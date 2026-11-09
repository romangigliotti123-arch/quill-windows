import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceMarkdown, writeVoiceExport } from '../src/core/style/voiceExport';
import { freshProfile, recordTrait } from '../src/core/style/styleProfile';
import type { DictationRecord } from '../src/core/stores/history';
import { DATA_FILES } from '../src/core/paths';
import { uuid } from '../src/core/stores/storeFile';

// A document meant to leave the app entirely — pasted into Claude, ChatGPT,
// whatever the user already talks to — so the tests care about two things a unit
// test can actually check: that it never sends what should not be there
// (measurements, blanks), and that it never touches the real data directory
// while proving that.

function record(text: string, daysAgo: number, loopback = false): DictationRecord {
  return {
    id: uuid(),
    date: new Date(Date.now() - daysAgo * 86_400_000),
    rawText: text,
    insertedText: text,
    wordCount: text.split(' ').length,
    inputDevice: loopback ? 'BlackHole 2ch' : 'Microphone Array',
    timings: {
      timeToFirstWordMs: null, finalToInsertedMs: null, endToEndMs: null, audioDurationMs: null,
      usedThoroughCleanup: false, releaseToInsertedMs: null, micOpenMs: null,
      speechOnsetMs: null, recogniserFirstWordMs: null,
    },
  };
}

test('a fresh profile with no history still produces a readable document', () => {
  const doc = voiceMarkdown(freshProfile(), []);
  assert.ok(doc.includes('# How this person writes'));
  assert.ok(doc.includes('Nothing yet'));
});

test('measurements never reach the exported document', () => {
  // The eval rig's loopback clips are not things the user said, and this
  // document exists specifically to teach an AI how the user actually talks — a
  // synthetic benchmark clip in there is worse than noise, it is a false claim
  // about someone's own voice.
  const doc = voiceMarkdown(freshProfile(), [
    record('the real thing I said', 1),
    record('a benchmark clip fed through a loopback', 1, true),
  ]);
  assert.ok(doc.includes('the real thing I said'));
  assert.ok(!doc.includes('a benchmark clip fed through a loopback'));
});

test('blank dictations are dropped', () => {
  const doc = voiceMarkdown(freshProfile(), [record('   ', 1), record('something real', 1)]);
  assert.ok(doc.includes('something real'));
  assert.ok(doc.includes('1 dictation,'), 'the blank one should not have been counted');
});

test('dictations appear oldest first', () => {
  const doc = voiceMarkdown(freshProfile(), [
    record('said most recently', 1),
    record('said a week ago', 7),
  ]);
  assert.ok(doc.indexOf('said a week ago') < doc.indexOf('said most recently'),
    'the older dictation should read first, like a transcript');
});

test('the document counts what it contains', () => {
  const doc = voiceMarkdown(freshProfile(), [record('one two three', 2), record('four five', 1)]);
  assert.ok(doc.includes('(2 dictations, roughly 5 words)'), doc);
});

test('learned traits appear when settled and not when guessed', () => {
  const profile = freshProfile();
  for (let i = 0; i < 5; i += 1) recordTrait(profile.spelling, 'british', new Date());
  const doc = voiceMarkdown(profile, []);
  assert.ok(doc.includes('British spelling'));
  // Nothing else was ever taught, so nothing else should be asserted as fact.
  assert.ok(!doc.includes('Uses contractions'));
  assert.ok(!doc.includes('no contractions'));
});

test('every settled trait is reported in the words the receiving model will read', () => {
  const profile = freshProfile();
  const now = new Date();
  for (let i = 0; i < 4; i += 1) {
    recordTrait(profile.spelling, 'american', now);
    recordTrait(profile.contractions, 'no', now);
    recordTrait(profile.formality, 'formal', now);
    recordTrait(profile.oxfordComma, 'yes', now);
    recordTrait(profile.exclamations, 'no', now);
  }
  profile.sentenceLength = { total: 30 * 5, count: 5 };
  const doc = voiceMarkdown(profile, []);
  for (const line of [
    'American spelling.',
    'Writes words out in full — no contractions.',
    'Tone: formal.',
    'Typical sentence is about 30 words — long sentences are normal for them, not a sign to trim.',
    'Uses the Oxford comma.',
    'Does not use exclamation marks.',
  ]) {
    assert.ok(doc.includes(line), `missing: ${line}`);
  }
});

test('the instructions tell the receiving model what this is and when to use it', () => {
  // The whole reason this exists rather than being a plain history dump: handed
  // to a model with no framing, a thousand of someone's sentences reads as either
  // "imitate this in every reply from now on" or "ignore it" — neither of which
  // is what "write like me" means.
  const doc = voiceMarkdown(freshProfile(), []);
  assert.ok(doc.includes('Quill'));
  assert.ok(doc.toLowerCase().includes('only when'));
  assert.ok(doc.toLowerCase().includes('do not quote'));
});

// MARK: - Writing to disk never touches the real data directory

test('writing never touches the real data directory when given a destination', () => {
  // Same rule as every store's constructor: a self-test that can reach the real
  // file is a bug waiting for someone to run the suite once. `write` takes an
  // explicit destination for exactly this reason — this pins that the parameter
  // exists and actually redirects the write.
  const scratch = join(mkdtempSync(join(tmpdir(), 'quill-voice-export-')), 'nested', 'my-voice-for-ai.md');
  const result = writeVoiceExport(freshProfile(), [record('a real dictation', 1)], scratch);
  assert.ok(result);
  assert.equal(result.url, scratch);
  assert.ok(existsSync(scratch));
  const onDisk = readFileSync(scratch, 'utf8');
  assert.equal(onDisk, result.text);
  assert.ok(onDisk.includes('a real dictation'));
});

test('the export file is on the erase list', () => {
  assert.ok((DATA_FILES as readonly string[]).includes('my-voice-for-ai.md'));
});
