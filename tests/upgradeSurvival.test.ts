import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore } from '../src/core/stores/history';
import { NoteStore } from '../src/core/stores/notes';
import { SnippetStore } from '../src/core/stores/snippets';
import { loadVocabulary } from '../src/core/stores/vocabulary';
import { QuillSettings } from '../src/core/settings';
import { StyleStore } from '../src/core/style/styleProfile';

// Nothing a user has may be lost by installing a newer Quill.
//
// An update replaces the application and nothing else — every file the user owns
// stays in the data directory, written by the old build and read by the new one.
// That only holds while the new build can still read what the old one wrote, and
// a strict decoder breaks it in the quietest way available: add one required
// field and every record written before it fails to decode. The store then does
// the right thing and refuses to overwrite the file, so nothing is destroyed —
// but the user opens Quill after an update to an empty history, an empty
// Dictionary, no notes and no snippets, and a store that has silently stopped
// saving. "Still on disk" is no comfort to someone looking at a blank screen.
//
// So the fixtures below are frozen: they are the exact bytes a shipped release
// wrote, and they stay that way. Adding a required field to any of these types
// fails these tests at the moment it is added, which is the only moment it is
// cheap to fix.
//
// They are read from a scratch directory. A test that reads the real data
// directory is a test that passes on the author's machine and tells nobody else
// anything.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'quill-upgrade-'));
}

function write(json: string, name: string, dir: string): string {
  const path = join(dir, name);
  writeFileSync(path, json, 'utf8');
  return path;
}

// MARK: - History

/// A record exactly as an early release writes it — ISO-8601 dates, nested
/// timings, none of the fields added since.
const historyAsShipped = `[
  {
    "date" : "2026-08-23T09:00:21Z",
    "id" : "687743A7-7D06-4EAC-A444-B161D8A9622A",
    "inputDevice" : "Microphone Array",
    "insertedText" : "Send Noah the deposit terms.",
    "rawText" : "send noah the deposit terms",
    "timings" : {
      "audioDurationMs" : 2100,
      "endToEndMs" : 2400,
      "finalToInsertedMs" : 40,
      "timeToFirstWordMs" : 380,
      "usedThoroughCleanup" : true
    },
    "wordCount" : 5
  }
]`;

test('a history written by a shipped release survives the update', () => {
  const dir = scratch();
  const store = new HistoryStore(write(historyAsShipped, 'history.json', dir), () => null);
  assert.equal(store.all.length, 1);
  const record = store.all[0]!;
  assert.equal(record.rawText, 'send noah the deposit terms');
  assert.equal(record.insertedText, 'Send Noah the deposit terms.');
  assert.equal(record.wordCount, 5);
  assert.equal(record.inputDevice, 'Microphone Array');
  assert.equal(record.timings.audioDurationMs, 2100);
  assert.equal(record.timings.usedThoroughCleanup, true);
  // The three timings added after this record's shape was frozen.
  assert.equal(record.timings.releaseToInsertedMs, null);
  assert.equal(record.timings.micOpenMs, null);
  store.dispose();
});

/// The failure this suite exists for, in its purest form: 85 dictations and one
/// field this build wants that the file does not have.
test('a history missing fields added later still loads every record', () => {
  const dir = scratch();
  const records = Array.from({ length: 85 }, (_, i) => `
    { "date" : "2026-08-2${i % 3}T09:00:21Z",
      "insertedText" : "record ${i}",
      "rawText" : "record ${i}" }`).join(',');
  const store = new HistoryStore(write(`[${records}]`, 'history.json', dir), () => null);
  assert.equal(store.all.length, 85);
  // wordCount was absent; derived rather than defaulted to zero, so Insights does
  // not report a month of dictation as no words at all.
  assert.ok(store.all.every((record) => record.wordCount === 2));
  store.dispose();
});

test('a record with no date or id still loads, with the current time and a fresh id', () => {
  const dir = scratch();
  const store = new HistoryStore(
    write('[{"insertedText":"a","rawText":"a"},{"insertedText":"b","rawText":"b"}]', 'history.json', dir),
    () => null,
  );
  assert.equal(store.all.length, 2);
  assert.notEqual(store.all[0]!.id, store.all[1]!.id);
  assert.ok(Math.abs(store.all[0]!.date.getTime() - Date.now()) < 60_000);
  store.dispose();
});

/// `rawText` and `insertedText` stay required. They are the record — a history
/// entry without them is not a dictation that lost a field, it is corruption, and
/// quietly inventing an empty one hides that.
test('a record without its text is corruption, not an empty dictation', () => {
  const dir = scratch();
  const path = write('[{"date":"2026-08-23T09:00:21Z","insertedText":"kept"}]', 'history.json', dir);
  const store = new HistoryStore(path, () => null);
  assert.equal(store.all.length, 0);
  // And the store refuses to write over what it could not read.
  store.append({
    id: 'x', date: new Date(), rawText: 'new', insertedText: 'new', wordCount: 1, inputDevice: null,
    timings: {
      timeToFirstWordMs: null, finalToInsertedMs: null, endToEndMs: null, audioDurationMs: null,
      usedThoroughCleanup: false, releaseToInsertedMs: null, micOpenMs: null,
      speechOnsetMs: null, recogniserFirstWordMs: null,
    },
  });
  assert.equal(readFileSync(path, 'utf8'), '[{"date":"2026-08-23T09:00:21Z","insertedText":"kept"}]');
  store.dispose();
});

test('a record whose date is present but not a date is damage, not a default', () => {
  const dir = scratch();
  const path = write('[{"date":"yesterday-ish","insertedText":"a","rawText":"a"}]', 'history.json', dir);
  const store = new HistoryStore(path, () => null);
  assert.equal(store.all.length, 0);
  assert.ok(readdirSync(dir).some((name) => name.includes('.unreadable-')));
  store.dispose();
});

// MARK: - Notes, Dictionary, snippets

test('notes written by a shipped release survive the update', () => {
  const dir = scratch();
  const path = write(`[
    {
      "body" : "Ask about the Warwick cloth by the metre.",
      "created" : "2026-08-23T09:00:21Z",
      "id" : "687743A7-7D06-4EAC-A444-B161D8A9622A",
      "title" : "Builda Bed",
      "updated" : "2026-08-23T09:14:02Z"
    }
  ]`, 'notes.json', dir);

  const all = new NoteStore(path).all;
  assert.equal(all.length, 1);
  assert.equal(all[0]!.title, 'Builda Bed');
  assert.equal(all[0]!.body, 'Ask about the Warwick cloth by the metre.');
  assert.equal(all[0]!.updated.toISOString(), '2026-08-23T09:14:02.000Z');
});

test('notes from the earlier Windows/Linux build keep their place in the list', () => {
  // That build wrote `modified` and `isPinned` where this one writes `updated`.
  const dir = scratch();
  const path = write(`[
    {"id":"a","title":"old","body":"b","created":"2026-08-01T00:00:00Z","modified":"2026-08-20T00:00:00Z","isPinned":true}
  ]`, 'notes.json', dir);
  const note = new NoteStore(path).all[0]!;
  assert.equal(note.title, 'old');
  assert.equal(note.updated.toISOString(), '2026-08-20T00:00:00.000Z');
});

test('a note missing every optional field still loads', () => {
  const dir = scratch();
  const path = write('[{"body":"just words"}, {"title":"just a title"}, {}]', 'notes.json', dir);
  const all = new NoteStore(path).all;
  assert.equal(all.length, 3);
  assert.equal(all[0]!.body, 'just words');
  assert.equal(all[1]!.title, 'just a title');
  assert.equal(all[2]!.title, '');
});

test('the Dictionary written by a shipped release survives the update', () => {
  const dir = scratch();
  const path = write('{ "terms" : [ "Craigieburn", "graphify", "Netlify" ] }', 'vocabulary.json', dir);
  assert.deepEqual(loadVocabulary(path).terms, ['Craigieburn', 'graphify', 'Netlify']);
});

/// One field today, and a `terms` key that has always been there — but a strict
/// decoder throws the moment a second field is added and an old dictionary does
/// not have it, and the whole Dictionary would go with it.
test('a Dictionary with no terms key is an empty Dictionary, not a damaged one', () => {
  const dir = scratch();
  const path = write('{}', 'vocabulary.json', dir);
  assert.deepEqual(loadVocabulary(path).terms, []);
  assert.deepEqual(readdirSync(dir), ['vocabulary.json'], 'a salvage copy was made of a readable file');
});

test('a Dictionary whose terms are the wrong shape is still damage', () => {
  const dir = scratch();
  const path = write('{"terms": "Netlify"}', 'vocabulary.json', dir);
  loadVocabulary(path);
  assert.ok(readdirSync(dir).some((name) => name.includes('.unreadable-')));
});

test('snippets written by a shipped release survive the update', () => {
  const dir = scratch();
  const path = write(`[
    {
      "created" : "2026-08-23T09:00:21Z",
      "id" : "687743A7-7D06-4EAC-A444-B161D8A9622A",
      "isEnabled" : true,
      "mode" : "alone",
      "phrase" : "sign off",
      "replacement" : "Cheers,\\nRoman",
      "useCount" : 12
    }
  ]`, 'snippets.json', dir);

  const all = new SnippetStore(path).all;
  assert.equal(all.length, 1);
  assert.equal(all[0]!.phrase, 'sign off');
  assert.equal(all[0]!.replacement, 'Cheers,\nRoman');
  assert.equal(all[0]!.mode, 'alone');
  assert.equal(all[0]!.useCount, 12);
});

/// `mode` falls back rather than throwing, because a value written by a newer
/// build is a case this one has never heard of, and losing every snippet over an
/// unknown enum is the same failure by another route.
test('a snippet with a mode from a newer build keeps everything else', () => {
  const dir = scratch();
  const path = write(
    '[{"phrase":"p","replacement":"r","mode":"somethingNew"},{"phrase":"q","replacement":"s"}]',
    'snippets.json', dir,
  );
  const all = new SnippetStore(path).all;
  assert.equal(all.length, 2);
  assert.ok(all.every((snippet) => snippet.mode === 'anywhere' && snippet.isEnabled && snippet.useCount === 0));
});

/// `phrase` and `replacement` stay required: a snippet without either is not a
/// snippet that lost a field, and silently substituting an empty string would
/// leave an entry that fires on nothing and types nothing.
test('a snippet without its phrase is damage', () => {
  const dir = scratch();
  const path = write('[{"replacement":"r"}]', 'snippets.json', dir);
  assert.equal(new SnippetStore(path).all.length, 0);
  assert.ok(readdirSync(dir).some((name) => name.includes('.unreadable-')));
});

test('the learned style written by a shipped release survives the update', () => {
  const dir = scratch();
  const path = write(JSON.stringify({
    preset: 'technical',
    spelling: { votes: { british: 4 }, lastObserved: '2026-08-23T09:00:21Z' },
    correctionCount: 7,
  }), 'style.json', dir);
  const profile = new StyleStore(path).profile;
  assert.equal(profile.preset, 'technical');
  assert.equal(profile.spelling.votes.british, 4);
  assert.equal(profile.correctionCount, 7);
  // Everything the file did not say is the default, not a throw.
  assert.equal(profile.isLearningEnabled, true);
  assert.deepEqual(profile.phrasings, []);
});

// MARK: - Settings

test('an unreadable settings file is never overwritten', () => {
  // The rule the other stores already follow, and the one settings was still
  // missing: a file that cannot be read is not a file full of defaults. Before
  // this, an unreadable settings.json meant the app ran on defaults and then wrote
  // them over the top the first time the user changed anything — microphone,
  // dictation key, retention, every toggle, gone, along with the file that could
  // have been rescued by hand.
  const dir = scratch();
  const damaged = '{"holdKey": "CtrlRight", "liveText": tru'; // truncated mid-write
  const path = write(damaged, 'settings.json', dir);

  const settings = new QuillSettings(path);
  settings.set('liveText', false);
  settings.set('historyRetention', 'day');
  settings.markConfigured();

  assert.equal(readFileSync(path, 'utf8'), damaged);
  // And the bytes are kept a second time, where a person can find them.
  assert.equal(readdirSync(dir).filter((name) => name.includes('.unreadable-')).length, 1);
});

test('a settings file from a newer build keeps what this build understands', () => {
  const dir = scratch();
  const path = write(JSON.stringify({
    holdKey: 'CtrlRight',
    liveText: false,
    overlayBarPosition: 'middleOfTheScreenSomehow',
    somethingAddedInAFutureVersion: { nested: [1, 2, 3] },
  }), 'settings.json', dir);
  const values = new QuillSettings(path).current;
  assert.equal(values.holdKey, 'CtrlRight');
  assert.equal(values.liveText, false);
  assert.equal(values.overlayBarPosition, 'bottomLeft'); // unknown case → default
});

// MARK: - The whole folder at once

/// The end-to-end version: everything a user owns, written by the old build,
/// opened by this one. Asserts both halves of "nothing is lost" — the values read
/// back, and the bytes on disk are not rewritten just by launching.
test('opening a full data folder after an update changes nothing on disk', () => {
  const dir = scratch();
  const files: Record<string, string> = {
    'settings.json': JSON.stringify({ holdKey: 'CtrlRight', overlayBarPosition: 'topRight' }),
    'history.json': historyAsShipped,
    'notes.json': '[{"body":"b","created":"2026-08-23T09:00:21Z","id":"687743A7-7D06-4EAC-A444-B161D8A9622A","title":"t","updated":"2026-08-23T09:00:21Z"}]',
    'vocabulary.json': '{"terms":["Craigieburn"]}',
    'snippets.json': '[{"created":"2026-08-23T09:00:21Z","id":"11111111-1111-1111-1111-111111111111","isEnabled":true,"mode":"anywhere","phrase":"p","replacement":"r","useCount":0}]',
    'style.json': '{"preset":"casual"}',
    // Not decoded by anything here, but they live in the same folder and an
    // update must leave them exactly as they were.
    'nim-key.txt': 'nvapi-not-a-real-key',
    'my-voice-for-ai.md': '# How I write\n\nShort sentences.\n',
    'device.json': '{"id":"dabc123"}',
  };
  const before: Record<string, Buffer> = {};
  for (const [name, body] of Object.entries(files)) {
    before[name] = readFileSync(write(body, name, dir));
  }

  // What a newer build does on first launch: read everything.
  const settings = new QuillSettings(join(dir, 'settings.json'));
  const history = new HistoryStore(join(dir, 'history.json'), () => null);
  const notes = new NoteStore(join(dir, 'notes.json'));
  const snippets = new SnippetStore(join(dir, 'snippets.json'));
  const vocabulary = loadVocabulary(join(dir, 'vocabulary.json'));
  const style = new StyleStore(join(dir, 'style.json'));

  assert.equal(settings.current.overlayBarPosition, 'topRight');
  assert.equal(history.all.length, 1);
  assert.equal(notes.all.length, 1);
  assert.equal(snippets.all.length, 1);
  assert.deepEqual(vocabulary.terms, ['Craigieburn']);
  assert.equal(style.profile.preset, 'casual');
  history.dispose();

  for (const [name, original] of Object.entries(before)) {
    const now = readFileSync(join(dir, name));
    assert.ok(now.equals(original), `${name} was rewritten by an update that only read it`);
  }
  assert.deepEqual(
    readdirSync(dir).sort(),
    Object.keys(files).sort(),
    'launching left stray files behind',
  );
});
