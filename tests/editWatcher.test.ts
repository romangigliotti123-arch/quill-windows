import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsertedSpan } from '../src/core/style/insertedSpan';
import { EditWatcher, type FocusedTextReading } from '../src/core/style/editWatcher';
import { StyleStore, freshProfile } from '../src/core/style/styleProfile';
import { HistoryStore, type DictationRecord } from '../src/core/stores/history';
import {
  createFocusedTextReader, decodeFocusedText, encodePowerShell, windowsFocusedTextScript,
  UnavailableFocusedTextReader,
} from '../src/main/style/focusedTextReader';
import { uuid } from '../src/core/stores/storeFile';

/// A scripted field. Each `focusedText` call returns the next state, so a whole
/// editing session — including the half-typed states in the middle of it — can
/// be stepped through without a window server.
class ScriptedField implements FocusedTextReading {
  reads = 0;
  constructor(private states: (string | null)[]) {}

  focusedText(): string | null {
    this.reads += 1;
    if (this.states.length === 0) return null;
    return this.states.length === 1 ? this.states[0]! : this.states.shift()!;
  }
}

const FIXED_NOW = new Date(1_700_000_000_000);

function watcher(
  field: FocusedTextReading,
  store: StyleStore,
  options: { learnFromEdits?: boolean; usesTimer?: boolean } = {},
): EditWatcher {
  const w = new EditWatcher({
    reader: field,
    store,
    learnFromEdits: () => options.learnFromEdits ?? true,
    now: () => FIXED_NOW,
    usesTimer: options.usesTimer ?? false,
  });
  // Pinned, for the same reason the live typer's tests pin theirs: otherwise
  // these pass or fail depending on which window is in front of whoever is
  // running them.
  w.frontmostPID = () => 1;
  return w;
}

// MARK: - Finding the sentence again

/// The anchoring, on its own. Diffing two whole documents would find every
/// change in both of them, including the paragraph written afterwards, which
/// says nothing about how someone corrects dictation.
const sentence = 'send noah the deposit terms';

test('anchors remember both sides of where it landed', () => {
  const field = `Morning. ${sentence} Cheers.`;
  const anchors = InsertedSpan.anchors(sentence, field);
  assert.ok(anchors);
  assert.equal(anchors.left, 'Morning. ');
  assert.equal(anchors.right, ' Cheers.');
  assert.equal(anchors.inserted, sentence);
});

test('anchors are short — a copy of the neighbourhood, not of the document', () => {
  const before = 'x'.repeat(100);
  const after = 'y'.repeat(100);
  const anchors = InsertedSpan.anchors(sentence, `${before}${sentence}${after}`);
  assert.ok(anchors);
  assert.equal(anchors.left.length, InsertedSpan.anchorLength);
  assert.equal(anchors.right.length, InsertedSpan.anchorLength);
});

test('there are no anchors when the field does not have the sentence', () => {
  // The app rewrote the text on arrival, or the insertion did not land.
  assert.equal(InsertedSpan.anchors(sentence, 'something else entirely'), null);
  assert.equal(InsertedSpan.anchors('', 'anything'), null);
});

/// Two copies and there is no way to know which one was edited. A coin toss here
/// teaches the profile from text the user never touched.
test('two copies of the sentence mean no watch', () => {
  assert.equal(InsertedSpan.anchors(sentence, `${sentence} and again ${sentence}`), null);
});

test('a sentence left alone reads as unchanged', () => {
  const anchors = InsertedSpan.anchors(sentence, `Hi. ${sentence}`)!;
  assert.deepEqual(InsertedSpan.verdict(anchors, `Hi. ${sentence}`), { kind: 'unchanged' });
});

/// The commonest thing that happens after a dictation: they keep it and carry on
/// writing. Not a correction, and reading it as one would teach the tone of
/// whatever they wrote next.
test('keeping it and writing more is not a correction', () => {
  const anchors = InsertedSpan.anchors(sentence, sentence)!;
  assert.deepEqual(InsertedSpan.verdict(anchors, `${sentence} and the invoice too.`), { kind: 'unchanged' });
});

test('an edit between the anchors is the correction', () => {
  const anchors = InsertedSpan.anchors(sentence, `Morning. ${sentence} Cheers.`)!;
  assert.deepEqual(
    InsertedSpan.verdict(anchors, 'Morning. Send Noah the deposit terms, please. Cheers.'),
    { kind: 'corrected', text: 'Send Noah the deposit terms, please.' },
  );
});

test('an edit at the end of the field is still found', () => {
  const anchors = InsertedSpan.anchors(sentence, `Morning. ${sentence}`)!;
  assert.deepEqual(
    InsertedSpan.verdict(anchors, 'Morning. Send Noah the deposit terms.'),
    { kind: 'corrected', text: 'Send Noah the deposit terms.' },
  );
});

/// The undo chord, or Quill mishearing entirely. Deleting a sentence is not a
/// statement about spelling or tone.
test('deleting the sentence teaches nothing', () => {
  const anchors = InsertedSpan.anchors(sentence, `Morning. ${sentence} Cheers.`)!;
  assert.deepEqual(InsertedSpan.verdict(anchors, 'Morning. Cheers.'),
    { kind: 'notComparable', reason: 'deleted' });
});

/// Replacing it with a different sentence is not correcting it.
test('a rewrite is refused rather than learned from', () => {
  const anchors = InsertedSpan.anchors(sentence, `Morning. ${sentence} Cheers.`)!;
  const after = "Morning. Actually, let's talk about this on the phone tomorrow "
    + 'instead, because there is a lot to go through and I would rather not '
    + 'put all of it in writing. Cheers.';
  assert.deepEqual(InsertedSpan.verdict(anchors, after), { kind: 'notComparable', reason: 'rewritten' });
});

test('losing the surrounding text is refused rather than guessed at', () => {
  const anchors = InsertedSpan.anchors(sentence, `Morning. ${sentence} Cheers.`)!;
  assert.deepEqual(InsertedSpan.verdict(anchors, 'totally different document'),
    { kind: 'notComparable', reason: 'anchorsLost' });
});

// MARK: - The watch itself

/// Roman: *"after i make a dictation make it watch where the text went and watch
/// what i change to adapt to what i said and what i meant to type."*
///
/// The half that was missing was not the learning — `styleLearner` has eight
/// detectors and `StyleProfile` tallies them — it was that
/// `StyleStore.recordCorrection` **had no callers at all**. The profile could
/// only ever show its defaults and "corrections seen" could only ever say zero.
/// So the assertion that matters most in here is the plain one: the profile
/// changed.
const typo = 'i recieve the invoice on monday';

test('a correction that holds still is learned', async () => {
  const corrected = 'I receive the invoice on Monday.';
  const field = new ScriptedField([
    typo,                  // begin(): where it landed
    corrected, corrected,  // two identical reads — they stopped typing
  ]);
  const store = StyleStore.inMemory(freshProfile());
  const w = watcher(field, store);

  assert.equal(store.profile.correctionCount, 0, 'nothing has been learned yet');

  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  await w.sample();
  await w.sample();

  assert.deepEqual(w.lastOutcome, { kind: 'learned', from: typo, to: corrected, destination: 'notepad.exe' });
  // The whole point. Before this feature existed the pipeline had no caller and
  // this number could not move.
  assert.equal(store.profile.correctionCount, 1);
});

/// Someone fixing "recieve" passes through "recve" and "recei" on the way, and
/// every one of those is a readable field value that says nothing true.
test('half-typed states are not learned from', async () => {
  const field = new ScriptedField([
    typo,
    'i recve the invoice on monday',  // mid-fix
    'i recei the invoice on monday',  // still mid-fix
  ]);
  const store = StyleStore.inMemory(freshProfile());
  const w = watcher(field, store);
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  await w.sample();
  await w.sample();

  assert.equal(w.lastOutcome, null, 'no conclusion while the text is still moving');
  assert.equal(store.profile.correctionCount, 0);
});

/// The measured reality on the Mac: three of the four apps most dictated into
/// cannot be read, and the feature has to say so rather than invent something.
test('an app that will not say is reported rather than guessed at', async () => {
  const field = new ScriptedField([null]);
  const store = StyleStore.inMemory(freshProfile());
  const w = watcher(field, store);
  w.begin(typo, 1, 'windowsterminal.exe');
  await w.flush();

  assert.deepEqual(w.lastOutcome, { kind: 'couldNotRead', destination: 'windowsterminal.exe' });
  assert.equal(store.profile.correctionCount, 0);
});

test('a sentence that is not in the field is ignored, not watched', async () => {
  const field = new ScriptedField(['something else entirely']);
  const w = watcher(field, StyleStore.inMemory(freshProfile()));
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  assert.deepEqual(w.lastOutcome, { kind: 'ignored', reason: 'notFound' });
});

test('deleting the sentence stops the watch without learning', async () => {
  const field = new ScriptedField([`Hi. ${typo} Bye.`, 'Hi. Bye.']);
  const store = StyleStore.inMemory(freshProfile());
  const w = watcher(field, store);
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  await w.sample();

  assert.deepEqual(w.lastOutcome, { kind: 'ignored', reason: 'deleted' });
  assert.equal(store.profile.correctionCount, 0);
});

/// Typing and then putting it back is not a correction either.
test('an edit that is undone is not learned from', async () => {
  const field = new ScriptedField([
    typo,
    'I receive the invoice on Monday.',  // edited
    typo,                                 // and reverted
    typo,
  ]);
  const store = StyleStore.inMemory(freshProfile());
  const w = watcher(field, store);
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  await w.sample(); await w.sample(); await w.sample();

  assert.equal(store.profile.correctionCount, 0);
});

test('the switch in Settings actually stops it', async () => {
  const field = new ScriptedField([typo]);
  const store = StyleStore.inMemory(freshProfile());
  const w = watcher(field, store, { learnFromEdits: false });
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();

  assert.equal(field.reads, 0, 'switched off, it must not even read the field');
  assert.equal(w.lastOutcome, null);
});

/// Learning off in the Style screen is a second, separate switch, and it has to
/// win too.
test('style learning turned off also stops it', async () => {
  const profile = freshProfile();
  profile.isLearningEnabled = false;
  const field = new ScriptedField([typo]);
  const w = watcher(field, StyleStore.inMemory(profile));
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  assert.equal(field.reads, 0);
});

/// The window closing is not evidence of anything. It waits.
test('a field that stops answering mid-watch is not a conclusion', async () => {
  const field = new ScriptedField([typo, null, null]);
  const store = StyleStore.inMemory(freshProfile());
  const w = watcher(field, store);
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  await w.sample(); await w.sample();

  assert.equal(w.lastOutcome, null);
  assert.equal(store.profile.correctionCount, 0);
});

/// Roman, the day the Mac build shipped this: *"the dictations arent working
/// they are really buggy right now from the option key and the on screen
/// button."*
///
/// `begin` did its first accessibility read inline. That put a synchronous
/// cross-process call on the main thread at the end of every dictation, and then
/// 75 more over the following 90 seconds, running straight through the next
/// dictation while the live typer was making its own calls at the same target on
/// every partial. Here the equivalent promise is that `begin` returns before the
/// reader has been asked anything at all.
test('begin does no reading on the caller\'s turn', async () => {
  const field = new ScriptedField([typo]);
  const w = watcher(field, StyleStore.inMemory(freshProfile()));
  w.begin(typo, 1, 'notepad.exe');
  assert.equal(field.reads, 0, 'the field was read before begin() returned');
  await w.flush();
  assert.equal(field.reads, 1, 'one read to open the watch, not a poll');
});

/// Seven looks, not seventy-five. The first version polled every 1.2 seconds for
/// 90 seconds against a field it had no reason to keep reading.
test('a watch is bounded and stops looking when it runs out', async () => {
  const field = new ScriptedField([`Hi. ${typo}`]);
  const store = StyleStore.inMemory(freshProfile());
  const w = watcher(field, store);
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  const afterOpen = field.reads;

  // More steps than the schedule has, to prove it stops rather than runs on.
  for (let i = 0; i < 20; i += 1) await w.sample();

  assert.equal(EditWatcher.schedule.length, 7);
  assert.ok(field.reads - afterOpen <= EditWatcher.schedule.length,
    'read the field more times than the schedule allows');
  assert.deepEqual(w.lastOutcome, { kind: 'keptAsWritten' }, 'it should conclude, not keep looking');
});

/// Reading the text out of an app the user has switched away from is wasted
/// work, and not a thing to do casually in an app whose pitch is that nothing
/// leaves the machine.
test('it does not read the field while the user is looking at something else', async () => {
  const field = new ScriptedField([`Hi. ${typo}`]);
  const w = watcher(field, StyleStore.inMemory(freshProfile()));
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  const afterOpen = field.reads;

  w.frontmostPID = () => 99; // they switched apps
  await w.sample(); await w.sample();
  assert.equal(field.reads, afterOpen, 'kept reading a background app\'s text');
});

test('a platform that cannot name the front window is read as "nothing changed"', async () => {
  const field = new ScriptedField([`Hi. ${typo}`]);
  const w = watcher(field, StyleStore.inMemory(freshProfile()));
  w.frontmostPID = () => null;
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  const afterOpen = field.reads;
  await w.sample();
  assert.equal(field.reads, afterOpen + 1);
});

// MARK: - Deliberate differences from the macOS original

/// On macOS a `begin` still waiting on its queue when the next dictation called
/// `cancel` would go on to open a watch for the previous sentence anyway —
/// which is exactly the "two subsystems at one target" the schedule exists to
/// avoid.
test('cancel also stops a begin that has not opened yet', async () => {
  const field = new ScriptedField([typo]);
  const w = watcher(field, StyleStore.inMemory(freshProfile()));
  w.begin(typo, 1, 'notepad.exe');
  w.cancel();
  await w.flush();
  assert.equal(field.reads, 0, 'a cancelled watch still read the field');
  assert.equal(w.lastOutcome, null);
});

test('cancel stops a watch that is already running', async () => {
  const field = new ScriptedField([`Hi. ${typo}`]);
  const w = watcher(field, StyleStore.inMemory(freshProfile()));
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  const afterOpen = field.reads;
  w.cancel();
  await w.sample();
  assert.equal(field.reads, afterOpen);
});

/// The Swift timer stopped scheduling after the last look, so the commonest real
/// outcome — "they left it alone" — was never recorded outside tests that step
/// the clock by hand. This runs the real timer, on a fake clock.
test('with the real timer, a watch walks its schedule and concludes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const field = new ScriptedField([`Hi. ${typo}`]);
  const w = watcher(field, StyleStore.inMemory(freshProfile()), { usesTimer: true });
  w.begin(typo, 1, 'notepad.exe');
  await w.flush();
  assert.equal(field.reads, 1);

  // Cumulative seconds 2, 4, 7, 12, 20, 32, 48 — one read each.
  let elapsed = 0;
  for (const mark of EditWatcher.schedule) {
    t.mock.timers.tick((mark - elapsed) * 1000);
    elapsed = mark;
    await w.flush();
  }
  assert.equal(field.reads, 1 + EditWatcher.schedule.length);
  // And the tick after the last look, which reads nothing.
  t.mock.timers.tick(1);
  await w.flush();
  assert.equal(field.reads, 1 + EditWatcher.schedule.length, 'the concluding tick read the field');
  assert.deepEqual(w.lastOutcome, { kind: 'keptAsWritten' });
});

test('it tells the caller when a watch concludes', async () => {
  const field = new ScriptedField([null]);
  const seen: string[] = [];
  const w = new EditWatcher({
    reader: field,
    store: StyleStore.inMemory(freshProfile()),
    learnFromEdits: () => true,
    usesTimer: false,
    onConcluded: (outcome) => seen.push(outcome.kind),
  });
  w.begin(typo, 1, null);
  await w.flush();
  assert.deepEqual(seen, ['couldNotRead']);
});

// MARK: - Where the text went

test('a dictation records which app the text landed in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quill-dest-'));
  const path = join(dir, 'history.json');
  const record: DictationRecord = {
    id: uuid(), date: new Date(), rawText: 'hello', insertedText: 'Hello.', wordCount: 1,
    inputDevice: 'Microphone Array', destinationBundleID: 'notepad.exe',
    timings: {
      timeToFirstWordMs: null, finalToInsertedMs: null, endToEndMs: null, audioDurationMs: null,
      usedThoroughCleanup: false, releaseToInsertedMs: null, micOpenMs: null,
      speechOnsetMs: null, recogniserFirstWordMs: null,
    },
  };
  const first = new HistoryStore(path, () => null);
  first.append(record);
  first.dispose();

  const second = new HistoryStore(path, () => null);
  assert.equal(second.all[0]!.destinationBundleID, 'notepad.exe');
  second.dispose();
});

/// Every record written before this field existed. See upgradeSurvival.test.ts
/// for why that is checked at all.
test('a dictation from before this field existed still loads', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'quill-dest-'));
  const path = join(dir, 'history.json');
  writeFileSync(path, JSON.stringify([
    { date: '2026-08-23T09:00:21Z', insertedText: 'Hello.', rawText: 'hello' },
  ]));
  const store = new HistoryStore(path, () => null);
  assert.equal(store.all.length, 1);
  assert.equal(store.all[0]!.destinationBundleID ?? null, null);
  assert.equal(store.all[0]!.insertedText, 'Hello.');
  store.dispose();
});

// MARK: - The Windows reader's pure parts
//
// The read itself needs a Windows desktop and a real application and is not
// something a unit test can do. Everything around it that can go wrong without
// one is checked here.

test('the focused-text script embeds only a plain process id', () => {
  assert.ok(windowsFocusedTextScript(4242).includes('ProcessId -ne 4242'));
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => windowsFocusedTextScript(bad), /not a process id/);
  }
});

test('the focused-text script refuses password fields and other processes', () => {
  const script = windowsFocusedTextScript(7);
  assert.ok(script.includes('IsPassword'));
  assert.ok(script.includes('exit 4'), 'no guard against a focused element in another process');
  assert.ok(script.includes('exit 7'), 'no guard against a password field');
});

test('PowerShell is handed UTF-16LE base64, which sidesteps every quoting rule', () => {
  const encoded = encodePowerShell("Write-Output 'héllo'");
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), "Write-Output 'héllo'");
});

test('the text comes back as base64 so no console code page can mangle it', () => {
  const text = 'I receive the invoice — on Monday, café.';
  const stdout = `${Buffer.from(text, 'utf8').toString('base64')}\r\n`;
  assert.equal(decodeFocusedText(stdout), text);
  assert.equal(decodeFocusedText(''), null);
  assert.equal(decodeFocusedText('   \r\n'), null);
  assert.equal(decodeFocusedText('not base64 at all!'), null);
});

test('only Windows gets a real reader; everywhere else the app simply will not say', async () => {
  assert.ok(createFocusedTextReader('linux') instanceof UnavailableFocusedTextReader);
  assert.ok(createFocusedTextReader('darwin') instanceof UnavailableFocusedTextReader);
  assert.equal(await createFocusedTextReader('linux').focusedText(1), null);
  assert.ok(!(createFocusedTextReader('win32') instanceof UnavailableFocusedTextReader));
});
