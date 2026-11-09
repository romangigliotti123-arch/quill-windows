import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepeatedWords } from '../src/core/cleanup/repeatedWords';
import { FastCleaner } from '../src/core/cleanup/fastCleaner';
import { VocabularyCorrector } from '../src/core/cleanup/vocabularyCorrector';
import { VocabularyBook } from '../src/core/stores/vocabulary';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The stutter — saying it twice while you decide how the sentence goes.
//
// Quill removed filled pauses and left every repetition untouched, so
// "the the invoice", "can you can you check" and "we need to we need to fix"
// all reached the document intact.
//
// Three disfluency taggers were measured before this was written — 4M, 11M and
// 66M parameter deletion-taggers, Apache-2.0, quantised ONNX, all under 2ms.
// On Roman's 85 real dictations the 11M wanted to delete 89 words, of which 77%
// were neither a filler nor a repetition: `"So sign in, sign out, create
// account"` lost an item from its list, `"the option key for transforms"` lost
// its preposition, `"Because it's wrong."` lost `"wrong"`. The one thing they
// got right is the one thing that needs no judgement, so it is a rule here.
//
// On the same 85 dictations this changes 4 and removes 10 words, every one of
// them a real restart: "up to up to date", "And it's stored and it's stored",
// "it sort of sort of shows", "It doesn't say, it doesn't say".

test('an immediate repeat of one word goes', () => {
  assert.equal(RepeatedWords.collapse('send the the invoice'), 'send the invoice');
  assert.equal(RepeatedWords.collapse('it is is ready'), 'it is ready');
  assert.equal(RepeatedWords.collapse('I I think so'), 'I think so');
});

test('a restart of a whole phrase goes', () => {
  assert.equal(RepeatedWords.collapse('can you can you check that'), 'can you check that');
  assert.equal(RepeatedWords.collapse('we need to we need to fix it'), 'we need to fix it');
  assert.equal(RepeatedWords.collapse('it should be up to up to date'), 'it should be up to date');
});

/// The half that matters more. English doubles words on purpose, and a silent
/// deletion inside someone's sentence is the failure this is written to avoid —
/// so `that`, `had`, `no`, `very`, `so` and their like are deliberately absent
/// from the single-word list.
test('English repeats words on purpose and those stay', () => {
  for (const kept of [
    'I know that that is true',
    'the sound that that makes is wrong',
    'he had had enough by then',
    'no no leave it where it is',
    'that is very very good',
    'it went on and on for hours',
  ]) {
    assert.equal(RepeatedWords.collapse(kept), kept, `changed: ${kept}`);
  }
});

/// The second copy is kept, not the first: a restart's second attempt is the one
/// the speaker meant, and it carries the punctuation they ended on.
test('the second attempt is the one kept', () => {
  assert.equal(RepeatedWords.collapse("It doesn't say, it doesn't say a word"), "it doesn't say a word");
});

/// Through the whole cleanup, which is where it actually runs — and where the
/// capital lost by keeping the second copy is put back.
test('the cleanup removes filled pauses and restarts together', () => {
  // An empty dictionary in a scratch file, so the real one on the machine
  // running this can never change the answer.
  const book = new VocabularyBook(join(mkdtempSync(join(tmpdir(), 'quill-rw-')), 'vocabulary.json'));
  const cleaner = new FastCleaner(new VocabularyCorrector({ book }));
  assert.equal(cleaner.cleanFast('the thing is um the thing is it keeps crashing'),
    'The thing is it keeps crashing');
  assert.equal(cleaner.cleanFast('can you can you check whether the build passed'),
    'Can you check whether the build passed');
});

/// A number said twice is a number said twice — "two two" is a digit sequence,
/// not a stutter, and no digit is on the safe list.
test('repeated numbers are left alone', () => {
  assert.equal(RepeatedWords.collapse('the code is two two five'), 'the code is two two five');
  assert.equal(RepeatedWords.collapse('call 9 9 8 now'), 'call 9 9 8 now');
});

test('text with fewer than two words is returned untouched', () => {
  assert.equal(RepeatedWords.collapse(''), '');
  assert.equal(RepeatedWords.collapse('hello'), 'hello');
  assert.equal(RepeatedWords.collapse('  spaced  '), '  spaced  ');
});
