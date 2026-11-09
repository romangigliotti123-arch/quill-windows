import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STYLE_MAXIMUM_PHRASINGS, STYLE_VOTE_CEILING, mergeAPIKey, mergeByID, mergeByUseCount, mergeHistory,
  mergeStyle, mergeVocabulary, normalizeDates, type JSONObject, type StyleJSON,
} from '../src/core/account/merge';
import { MAXIMUM_PHRASINGS, VOTE_CEILING } from '../src/core/style/styleProfile';

// Pure merge-logic tests — no network, no account, no data directory. The
// two-device round trip through a fake Firestore is in `syncEngine.test.ts`;
// these prove the merge is correct in isolation.

// MARK: - The generic union

test('new on either side survives', () => {
  const merged = mergeByID(
    [{ id: 1, tag: 'local-only' }], [{ id: 2, tag: 'remote-only' }], (item) => item.id, (a) => a);
  assert.deepEqual(new Set(merged.map((item) => item.id)), new Set([1, 2]));
});

test('a collision is decided by the tiebreaker', () => {
  const merged = mergeByID(
    [{ id: 1, score: 3 }], [{ id: 1, score: 9 }], (item) => item.id,
    (a, b) => (a.score >= b.score ? a : b));
  assert.deepEqual(merged, [{ id: 1, score: 9 }]);
});

test('nothing is ever dropped', () => {
  const local = Array.from({ length: 20 }, (_, id) => ({ id }));
  const remote = Array.from({ length: 20 }, (_, index) => ({ id: index + 10 }));
  const merged = mergeByID(local, remote, (item) => item.id, (a) => a);
  assert.deepEqual(new Set(merged.map((item) => item.id)), new Set(Array.from({ length: 30 }, (_, id) => id)));
  assert.equal(merged.length, 30, 'and nothing is listed twice');
});

test('the local list keeps its order, with new items after it', () => {
  const merged = mergeByID(
    [{ id: 'b' }, { id: 'a' }], [{ id: 'c' }, { id: 'a' }], (item) => item.id, (a) => a);
  assert.deepEqual(merged.map((item) => item.id), ['b', 'a', 'c']);
});

// MARK: - History: union by id, favouring whichever side already has it

const record = (id: string, text: string): JSONObject => ({
  id, date: '2026-08-24T10:00:00Z', rawText: text, insertedText: text, wordCount: text.split(' ').length,
});

test('history merge unions both devices without duplicating', () => {
  const shared = record('shared', 'said on both');
  const onlyOnA = record('a', 'said on A only');
  const onlyOnB = record('b', 'said on B only');
  const merged = mergeHistory([shared, onlyOnA], [shared, onlyOnB]);
  assert.equal(merged.length, 3);
  assert.deepEqual(new Set(merged.map((item) => item.id)), new Set(['shared', 'a', 'b']));
});

test('history merge is order independent', () => {
  const a = record('a', 'a');
  const b = record('b', 'b');
  const c = record('c', 'c');
  const forward = mergeHistory([a, b], [b, c]);
  const backward = mergeHistory([b, c], [a, b]);
  assert.deepEqual(new Set(forward.map((item) => item.id)), new Set(backward.map((item) => item.id)));
});

test('a collision in history keeps the copy this machine already has', () => {
  const merged = mergeHistory([{ ...record('x', 'local'), correctedText: 'edited here' }], [record('x', 'remote')]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.correctedText, 'edited here');
});

test('fields a newer build added are carried through untouched', () => {
  // A merge that rebuilt each record from the fields THIS build knows would
  // strip this on the next sync, from every machine.
  const fromNewerMac = { ...record('n', 'new'), someFutureField: { nested: [1, 2, 3] } };
  const merged = mergeHistory([], [fromNewerMac]);
  assert.deepEqual(merged[0]!.someFutureField, { nested: [1, 2, 3] });
});

// MARK: - Vocabulary: case-insensitive set union

test('vocabulary merge unions without case duplicates', () => {
  const merged = mergeVocabulary(
    { terms: ['Craigieburn', 'graphify'] }, { terms: ['craigieburn', 'Netlify'] });
  assert.equal(merged.terms.length, 3);
  for (const term of ['Craigieburn', 'graphify', 'Netlify']) assert.ok(merged.terms.includes(term));
});

test('vocabulary merge keeps local casing on a collision', () => {
  assert.deepEqual(mergeVocabulary({ terms: ['Craigieburn'] }, { terms: ['craigieburn'] }).terms, ['Craigieburn']);
});

test('vocabulary merge with an empty side returns the other', () => {
  assert.deepEqual(mergeVocabulary({ terms: [] }, { terms: ['Netlify'] }).terms, ['Netlify']);
  assert.deepEqual(mergeVocabulary({ terms: ['Netlify'] }, { terms: [] }).terms, ['Netlify']);
});

// MARK: - The AI key: a scalar, not a collection

test('API key merge keeps local when both are set', () => {
  assert.equal(mergeAPIKey('local-key', 'remote-key'), 'local-key');
});

// MARK: - Snippets and transforms

test('a snippet collision keeps the higher use count', () => {
  const local = { id: 's', phrase: 'sig', replacement: 'Roman', useCount: 2 };
  const remote = { ...local, useCount: 40 };
  const merged = mergeByUseCount([local], [remote]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.useCount, 40);
});

test('an exact tie keeps the local copy', () => {
  const merged = mergeByUseCount(
    [{ id: 's', useCount: 1, replacement: 'local' }], [{ id: 's', useCount: 1, replacement: 'remote' }]);
  assert.equal(merged[0]!.replacement, 'local');
});

test('distinct snippets are both kept', () => {
  const merged = mergeByUseCount(
    [{ id: '1', phrase: 'sig', useCount: 0 }], [{ id: '2', phrase: 'addr', useCount: 0 }]);
  assert.equal(merged.length, 2);
});

// MARK: - Style

const trait = (votes: Record<string, number>, lastObserved: string | null = null) => ({ votes, lastObserved });

const profile = (overrides: StyleJSON = {}): StyleJSON => ({
  preset: 'neutral',
  appTones: {},
  isLearningEnabled: true,
  spelling: trait({}),
  contractions: trait({}),
  formality: trait({}),
  oxfordComma: trait({}),
  exclamations: trait({}),
  sentenceLength: { total: 0, count: 0 },
  phrasings: [],
  correctionCount: 0,
  modelAccepted: 0,
  modelReverted: 0,
  lastLearned: null,
  ...overrides,
});

test('style merge combines learned counts from both devices', () => {
  const merged = mergeStyle(
    profile({ correctionCount: 5, modelAccepted: 2, modelReverted: 1 }),
    profile({ correctionCount: 7, modelAccepted: 3, modelReverted: 4 }));
  assert.equal(merged.correctionCount, 12);
  assert.equal(merged.modelAccepted, 5);
  assert.equal(merged.modelReverted, 5);
});

test('votes add per value, capped at the ceiling', () => {
  const merged = mergeStyle(
    profile({ spelling: trait({ british: 4, american: 1 }, '2026-08-01T00:00:00Z') }),
    profile({ spelling: trait({ british: 5 }, '2026-08-20T00:00:00Z') }));
  assert.deepEqual(merged.spelling!.votes, { british: STYLE_VOTE_CEILING, american: 1 });
  assert.equal(merged.spelling!.lastObserved, '2026-08-20T00:00:00Z', 'the later observation wins');
});

test('the constants shared with the style profile have not drifted apart', () => {
  assert.equal(STYLE_VOTE_CEILING, VOTE_CEILING);
  assert.equal(STYLE_MAXIMUM_PHRASINGS, MAXIMUM_PHRASINGS);
});

test('sentence length adds both sums, so the average stays honest', () => {
  const merged = mergeStyle(
    profile({ sentenceLength: { total: 100, count: 10 } }),
    profile({ sentenceLength: { total: 300, count: 10 } }));
  assert.deepEqual(merged.sentenceLength, { total: 400, count: 20 });
});

test('the more recently learned side keeps the chosen preset and tones', () => {
  const older = profile({ preset: 'casual', appTones: { slack: 'casual' }, lastLearned: '2026-08-01T00:00:00Z' });
  const newer = profile({
    preset: 'technical', appTones: { code: 'technical' }, isLearningEnabled: false, lastLearned: '2026-08-22T00:00:00Z',
  });
  const forward = mergeStyle(older, newer);
  assert.equal(forward.preset, 'technical');
  assert.deepEqual(forward.appTones, { code: 'technical' });
  assert.equal(forward.isLearningEnabled, false);
  assert.equal(forward.lastLearned, '2026-08-22T00:00:00Z');
  // And the other way round: local is newer, so local is kept.
  const backward = mergeStyle(newer, older);
  assert.equal(backward.preset, 'technical');
  assert.equal(backward.lastLearned, '2026-08-22T00:00:00Z');
});

test('phrasings are matched by their pair, summed, ordered by evidence and trimmed', () => {
  const merged = mergeStyle(
    profile({
      phrasings: [
        { from: 'hi team', to: 'hey', count: 2, lastObserved: '2026-08-01T00:00:00Z' },
        { from: 'kind regards', to: 'cheers', count: 1, lastObserved: '2026-08-02T00:00:00Z' },
      ],
    }),
    profile({
      phrasings: [
        { from: 'hi team', to: 'hey', count: 3, lastObserved: '2026-08-10T00:00:00Z' },
        { from: 'hi team', to: 'hello', count: 1, lastObserved: '2026-08-11T00:00:00Z' },
      ],
    }));
  assert.equal(merged.phrasings!.length, 3, '"hi team → hey" is one phrasing, not two');
  assert.deepEqual(merged.phrasings![0], { from: 'hi team', to: 'hey', count: 5, lastObserved: '2026-08-10T00:00:00Z' });
  // Equal evidence: the more recent one first.
  assert.equal(merged.phrasings![1]!.to, 'hello');

  const many = (prefix: string): StyleJSON => profile({
    phrasings: Array.from({ length: 20 }, (_, index) => ({
      from: `${prefix} ${index}`, to: 'x', count: 1, lastObserved: null,
    })),
  });
  assert.equal(mergeStyle(many('a'), many('b')).phrasings!.length, STYLE_MAXIMUM_PHRASINGS);
});

test('merging a profile with a blank one changes nothing it holds', () => {
  const rich = profile({
    spelling: trait({ british: 3 }),
    correctionCount: 9,
    phrasings: [{ from: 'hi team', to: 'hey', count: 4, lastObserved: null }],
    sentenceLength: { total: 80, count: 4 },
  });
  const merged = mergeStyle(rich, profile());
  assert.deepEqual(merged.spelling!.votes, { british: 3 });
  assert.equal(merged.correctionCount, 9);
  assert.equal(merged.phrasings!.length, 1);
  assert.deepEqual(merged.sentenceLength, { total: 80, count: 4 });
});

// MARK: - Dates on the wire

test('fractional seconds are stripped from every timestamp, at every depth', () => {
  const out = normalizeDates({
    date: '2026-08-24T10:00:00.123Z',
    nested: [{ lastUsed: '2026-08-24T10:00:00.9Z' }],
    text: 'said at 2026-08-24T10:00:00.123Z in passing',
    whole: '2026-08-24T10:00:00Z',
    number: 5,
    nothing: null,
  });
  assert.deepEqual(out, {
    date: '2026-08-24T10:00:00Z',
    nested: [{ lastUsed: '2026-08-24T10:00:00Z' }],
    text: 'said at 2026-08-24T10:00:00.123Z in passing', // prose is not a timestamp
    whole: '2026-08-24T10:00:00Z',
    number: 5,
    nothing: null,
  });
});
