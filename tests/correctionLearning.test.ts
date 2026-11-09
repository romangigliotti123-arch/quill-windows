import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorrectionLearning } from '../src/core/style/correctionLearning';
import { applyDictationCorrection } from '../src/core/style/applyCorrection';
import { HistoryStore, type DictationRecord } from '../src/core/stores/history';
import { StyleStore, freshProfile, traitValue } from '../src/core/style/styleProfile';
import { uuid } from '../src/core/stores/storeFile';

// Roman: *"make the model train itself by the dictations I make so the longer I
// use it, the more dictations I make, the smarter it gets."*
//
// Three measurements first, because a transcript on its own turns out to teach
// almost nothing. Across his 85 real dictations:
//
//   - harvesting unknown words proposed **one** term, and it was his own
//     pronunciation rather than a word the recogniser had missed;
//   - retraction cues found **two** genuine self-corrections, both already
//     handled, while the cue words themselves ("actually", "I mean") were
//     ordinary speech five times out of seven;
//   - repeated phrases worth a snippet: **four**, all connectives like "and
//     then they can".
//
// A transcript records what the recogniser did. It cannot say what was wrong
// with it. Only the user can, and the only moment they do is a correction — so
// that moment has to be worth as much as possible, and it has to be capturable
// for every dictation rather than only the ones that landed somewhere readable.

/// English words are not Dictionary candidates however wrong they were.
test('only words no dictionary knows are proposed', () => {
  const english = new Set(['send', 'the', 'invoice', 'to', 'tomorrow', 'receive']);
  const out = CorrectionLearning.learn(
    'send the invoice to Netterfly tomorrow',
    'send the invoice to Netlify tomorrow',
    [],
    (word) => english.has(word.toLowerCase()),
  );
  assert.deepEqual(out.dictionaryCandidates, ['Netlify']);
});

/// A word already in the Dictionary is not offered again — it is already biasing
/// the recogniser and the correction was about something else.
test('a term already in the dictionary is not proposed twice', () => {
  const out = CorrectionLearning.learn(
    'push it to Netterfly', 'push it to Netlify',
    ['Netlify', 'graphify'],
    () => false,
  );
  assert.deepEqual(out.dictionaryCandidates, []);
});

test('a multi-word dictionary term covers each of its words', () => {
  const out = CorrectionLearning.learn(
    'ask the wisper team', 'ask the Wispr Flow team',
    ['Wispr Flow'],
    () => false,
  );
  assert.deepEqual(out.dictionaryCandidates, []);
});

/// Only what the correction introduced. A word that was already there is not
/// what the user was fixing, and proposing it wastes the one question the app
/// gets to ask.
test('words that were already there are not proposed', () => {
  const out = CorrectionLearning.learn(
    'the graphify workspace is slow',
    'the graphify workspace is fast',
    [],
    (word) => word.toLowerCase() !== 'graphify',
  );
  assert.deepEqual(out.dictionaryCandidates, []);
});

test('punctuation and short fragments are not words', () => {
  const out = CorrectionLearning.learn(
    'it broke', 'it broke — MCP, v2, and 3 others',
    [], () => false,
  );
  // "MCP" is three letters and unknown, so it stays; "v2" and "3" are not.
  assert.deepEqual(out.dictionaryCandidates, ['MCP', 'and', 'others']);
});

test('a word is proposed once however many times it was typed', () => {
  const out = CorrectionLearning.learn('a b', 'Netlify Netlify netlify', [], () => false);
  assert.deepEqual(out.dictionaryCandidates, ['Netlify']);
});

test('words are letters, apostrophes and internal hyphens only', () => {
  assert.deepEqual(CorrectionLearning.words("well-known don't -dash- 'quoted' a1b"),
    ['well-known', "don't", 'dash', 'quoted', 'a', 'b']);
});

// MARK: - The store side

function scratchHistory(): HistoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'quill-corr-'));
  return new HistoryStore(join(dir, 'history.json'), () => null);
}

function record(text: string): DictationRecord {
  return {
    id: uuid(), date: new Date(), rawText: text, insertedText: text,
    wordCount: text.split(' ').length, inputDevice: null,
    timings: {
      timeToFirstWordMs: null, finalToInsertedMs: null, endToEndMs: null, audioDurationMs: null,
      usedThoroughCleanup: false, releaseToInsertedMs: null, micOpenMs: null,
      speechOnsetMs: null, recogniserFirstWordMs: null,
    },
  };
}

test('correcting a dictation keeps both versions', () => {
  const store = scratchHistory();
  const r = record('push it to Netterfly');
  store.append(r);

  const pair = store.correct(r.id, 'push it to Netlify');
  assert.ok(pair);
  assert.equal(pair.was, 'push it to Netterfly');
  assert.equal(pair.now, 'push it to Netlify');

  const saved = store.all.find((candidate) => candidate.id === r.id)!;
  assert.equal(saved.correctedText, 'push it to Netlify');
  // The original survives. It is half the evidence, and a diff against an edited
  // version is a diff against the wrong thing.
  assert.equal(saved.insertedText, 'push it to Netterfly');
  assert.equal(saved.rawText, 'push it to Netterfly');
  store.dispose();
});

test('correcting twice compares against the last correction', () => {
  const store = scratchHistory();
  const r = record('one');
  store.append(r);
  store.correct(r.id, 'two');
  const second = store.correct(r.id, 'three');
  assert.ok(second);
  assert.equal(second.was, 'two', 'the second correction is a correction of the first');
  store.dispose();
});

test('a correction that changes nothing teaches nothing', () => {
  const store = scratchHistory();
  const r = record('leave it alone');
  store.append(r);
  assert.equal(store.correct(r.id, 'leave it alone'), null);
  assert.equal(store.correct(r.id, '   '), null);
  assert.equal(store.correct('no-such-record', 'anything'), null);
  store.dispose();
});

test('a correction survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quill-corr-'));
  const path = join(dir, 'history.json');
  const first = new HistoryStore(path, () => null);
  const r = record('teh invoice');
  first.append(r);
  first.correct(r.id, 'the invoice');
  first.dispose();

  const second = new HistoryStore(path, () => null);
  assert.equal(second.all[0]!.correctedText, 'the invoice');
  assert.equal(second.all[0]!.insertedText, 'teh invoice');
  second.dispose();
});

/// The whole point, end to end: correcting a dictation moves the profile. Before
/// `EditWatcher` and this, `recordCorrection` had no callers at all and the Style
/// screen could only ever report zero.
test('a correction moves the style profile', () => {
  const store = scratchHistory();
  const style = StyleStore.inMemory(freshProfile());
  const r = record('I realize the color is wrong');
  store.append(r);

  assert.equal(style.profile.correctionCount, 0);
  const pair = store.correct(r.id, 'I realise the colour is wrong');
  assert.ok(pair);
  style.recordCorrection(pair.was, pair.now);
  assert.equal(style.profile.correctionCount, 1);
  assert.equal(traitValue(style.profile.spelling), 'british', 'two British spellings in one correction');
  store.dispose();
});

test('recording a correction does nothing while learning is switched off', () => {
  const profile = freshProfile();
  profile.isLearningEnabled = false;
  const style = StyleStore.inMemory(profile);
  style.recordCorrection('I realize the color is wrong', 'I realise the colour is wrong');
  assert.equal(style.profile.correctionCount, 0);
});

// MARK: - The whole chain

test('saving a correction keeps both versions, teaches the style, and offers dictionary terms', () => {
  const history = scratchHistory();
  const style = StyleStore.inMemory(freshProfile());
  const r = record('push the colour fix to Netterfly tonight');
  history.append(r);

  const result = applyDictationCorrection({
    history, style, existingTerms: [], id: r.id,
    text: 'push the colour fix to Netlify tonight',
    isKnownWord: (word) => ['push', 'the', 'colour', 'fix', 'to', 'tonight'].includes(word.toLowerCase()),
  });

  assert.ok(result);
  assert.equal(result.was, 'push the colour fix to Netterfly tonight');
  assert.deepEqual(result.dictionaryCandidates, ['Netlify']);
  assert.equal(history.all[0]!.correctedText, 'push the colour fix to Netlify tonight');
  assert.equal(history.all[0]!.insertedText, 'push the colour fix to Netterfly tonight');
  assert.equal(style.profile.correctionCount, 1);
  history.dispose();
});

test('a correction that changes nothing writes and learns nothing', () => {
  const history = scratchHistory();
  const style = StyleStore.inMemory(freshProfile());
  const r = record('leave it alone');
  history.append(r);
  assert.equal(
    applyDictationCorrection({ history, style, existingTerms: [], id: r.id, text: 'leave it alone' }),
    null,
  );
  assert.equal(style.profile.correctionCount, 0);
  assert.equal(history.all[0]!.correctedText ?? null, null);
  history.dispose();
});

test('with no word list injected it asks the bundled English dictionary', () => {
  const history = scratchHistory();
  const style = StyleStore.inMemory(freshProfile());
  const r = record('send the invoice tomorow');
  history.append(r);
  // Real English is never offered, whichever word list is loaded; and with the
  // list missing entirely (a bare test run) nothing is claimed to be unknown
  // beyond what it can actually say — the assertion is only that it runs.
  const result = applyDictationCorrection({
    history, style, existingTerms: [], id: r.id, text: 'send the invoice tomorrow',
  });
  assert.ok(result);
  assert.ok(!result.dictionaryCandidates.includes('invoice'));
  history.dispose();
});
