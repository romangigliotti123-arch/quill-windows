import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StyleStore, VOTE_CEILING, MAXIMUM_PHRASINGS, freshProfile, makePhrasing, mergeMeans, mergeProfiles,
  mergeTraits, recordTrait, settled, emptyTrait, traitValue, type StyleProfile,
} from '../src/core/style/styleProfile';

function temporaryStoreURL(): string {
  return join(mkdtempSync(join(tmpdir(), 'quill-style-')), 'style.json');
}

// MARK: - Deleting the learned style, on its own

test('reset deletes the file and returns to the fresh default', () => {
  const url = temporaryStoreURL();
  const store = new StyleStore(url);
  store.update((profile) => {
    profile.preset = 'technical';
    for (let i = 0; i < 5; i += 1) recordTrait(profile.spelling, 'british', new Date());
  });
  assert.ok(existsSync(url), 'the update above should have persisted');
  assert.notEqual(settled(store.profile, store.profile.spelling), null);

  store.reset();
  assert.ok(!existsSync(url), 'the file should be gone, not just overwritten');
  assert.deepEqual(store.profile, freshProfile());
  assert.equal(settled(store.profile, store.profile.spelling), null);
});

test('reset survives and clears a previously damaged file', () => {
  // `loadFailed` blocks every other write in this class — on purpose, elsewhere,
  // so a broken file is never overwritten by accident. Delete is the one action
  // that should win regardless: there is no "keep the damaged copy around"
  // version of a button whose entire job is removal.
  const url = temporaryStoreURL();
  writeFileSync(url, 'not json');

  const store = new StyleStore(url);
  store.reset();
  assert.ok(!existsSync(url));
  assert.deepEqual(store.profile, freshProfile());

  // And it is usable again afterward — reset must clear loadFailed, or every
  // write from here on would silently no-op forever.
  store.update((profile) => { profile.preset = 'casual'; });
  assert.ok(existsSync(url));
});

test('an in-memory store survives reset with nothing to delete', () => {
  // The preview/screenshot renderer's store has no path at all; reset must not
  // reach for one on the one path that has nothing on disk to remove.
  const store = StyleStore.inMemory({ ...freshProfile('technical') });
  store.reset();
  assert.deepEqual(store.profile, freshProfile());
});

test('reset on a store whose file is already gone is not an error', () => {
  const store = new StyleStore(temporaryStoreURL());
  assert.doesNotThrow(() => store.reset());
});

test('learned style can be forgotten without losing the chosen settings', () => {
  const store = StyleStore.inMemory(freshProfile());
  store.setPreset('professional');
  store.setTone('casual', 'slack.exe');
  store.update((profile) => {
    profile.isLearningEnabled = false;
    profile.modelAccepted = 3;
    profile.modelReverted = 1;
    for (let i = 0; i < 3; i += 1) recordTrait(profile.contractions, 'yes', new Date());
    profile.correctionCount = 9;
  });

  store.resetLearning();
  const after = store.profile;
  assert.equal(after.preset, 'professional');
  assert.deepEqual(after.appTones, { 'slack.exe': 'casual' });
  assert.equal(after.isLearningEnabled, false);
  assert.equal(after.modelAccepted, 3);
  assert.equal(after.modelReverted, 1);
  assert.equal(after.correctionCount, 0);
  assert.deepEqual(after.contractions.votes, {});
});

test('a per-app tone can be set and cleared', () => {
  const store = StyleStore.inMemory(freshProfile());
  store.setTone('professional', 'outlook.exe');
  assert.equal(store.profile.appTones['outlook.exe'], 'professional');
  store.setTone(null, 'outlook.exe');
  assert.equal('outlook.exe' in store.profile.appTones, false);
});

test('the style file is not on the erase list', async () => {
  const { DATA_FILES, DELIBERATELY_NOT_ERASED } = await import('../src/core/paths');
  // The positive half of the exception: not just "the scan allows this", but
  // "this is actually true of the list a real erase reads".
  assert.ok(!(DATA_FILES as readonly string[]).includes('style.json'));
  assert.deepEqual([...DELIBERATELY_NOT_ERASED], ['style.json']);
});

// MARK: - Combining two machines' evidence, for sync
//
// Roman asked for this explicitly: signing into the same account on a second
// machine must never look like losing what that machine already knew.

const T1 = new Date('2026-08-01T00:00:00Z');
const T2 = new Date('2026-09-01T00:00:00Z');

function traitWith(votes: Record<string, number>, at: Date | null): ReturnType<typeof emptyTrait> {
  return { votes, lastObserved: at };
}

test('votes add per value and are capped at the ceiling', () => {
  const merged = mergeTraits(
    traitWith({ british: 4, american: 1 }, T1),
    traitWith({ british: 4 }, T2),
  );
  assert.equal(merged.votes.british, VOTE_CEILING, 'four plus four is capped, not eight');
  assert.equal(merged.votes.american, 1);
  assert.equal(traitValue(merged), 'british');
});

test('the later observation date wins and a missing one never beats a real one', () => {
  assert.equal(mergeTraits(traitWith({}, T1), traitWith({}, T2)).lastObserved, T2);
  assert.equal(mergeTraits(traitWith({}, T2), traitWith({}, T1)).lastObserved, T2);
  assert.equal(mergeTraits(traitWith({}, null), traitWith({}, T1)).lastObserved, T1);
  assert.equal(mergeTraits(traitWith({}, T1), traitWith({}, null)).lastObserved, T1);
  assert.equal(mergeTraits(traitWith({}, null), traitWith({}, null)).lastObserved, null);
});

test('merging traits does not modify either side', () => {
  const ours = traitWith({ yes: 2 }, T1);
  const theirs = traitWith({ yes: 3 }, T2);
  mergeTraits(ours, theirs);
  assert.deepEqual(ours.votes, { yes: 2 });
  assert.deepEqual(theirs.votes, { yes: 3 });
});

test('means combine as a weighted average, not a capped one', () => {
  // Capping `count` without scaling `total` to match is the average silently
  // going wrong rather than merely being generous with history.
  const merged = mergeMeans({ total: 400, count: 40 }, { total: 120, count: 10 });
  assert.deepEqual(merged, { total: 520, count: 50 });
  assert.equal(merged.total / merged.count, 10.4);
});

function profileWith(overrides: Partial<StyleProfile>): StyleProfile {
  return { ...freshProfile(), ...overrides };
}

test('a merged profile never has fewer corrections than either side', () => {
  const merged = mergeProfiles(
    profileWith({ correctionCount: 12, modelAccepted: 5, modelReverted: 1 }),
    profileWith({ correctionCount: 30, modelAccepted: 2, modelReverted: 4 }),
  );
  assert.equal(merged.correctionCount, 42);
  assert.equal(merged.modelAccepted, 7);
  assert.equal(merged.modelReverted, 5);
});

test('choices go to whichever side learned most recently', () => {
  const older = profileWith({
    preset: 'casual', appTones: { 'a.exe': 'casual' }, isLearningEnabled: true, lastLearned: T1,
  });
  const newer = profileWith({
    preset: 'technical', appTones: { 'b.exe': 'professional' }, isLearningEnabled: false, lastLearned: T2,
  });

  for (const merged of [mergeProfiles(older, newer), mergeProfiles(newer, older)]) {
    assert.equal(merged.preset, 'technical');
    assert.deepEqual(merged.appTones, { 'b.exe': 'professional' });
    assert.equal(merged.isLearningEnabled, false);
    assert.equal(merged.lastLearned, T2);
  }
});

test('a side that has never learned does not overwrite the other one\'s choices', () => {
  const learned = profileWith({ preset: 'professional', lastLearned: T1 });
  const blank = profileWith({ preset: 'neutral', lastLearned: null });
  assert.equal(mergeProfiles(learned, blank).preset, 'professional');
  // The other way round the blank side is "ours", but the learned one is newer
  // and so its choices win — what matters is that nothing the learned side knew
  // is lost.
  assert.equal(mergeProfiles(blank, learned).preset, 'professional');
});

test('phrasings are summed by identity, ordered by evidence, and capped', () => {
  const ours = profileWith({
    phrasings: [makePhrasing('get ready', 'prepare', 2, T1), makePhrasing('only ours', 'x', 1, T1)],
  });
  const theirs = profileWith({
    phrasings: [makePhrasing('get ready', 'prepare', 3, T2), makePhrasing('only theirs', 'y', 5, T1)],
  });
  const merged = mergeProfiles(ours, theirs);

  const byFrom = new Map(merged.phrasings.map((phrasing) => [phrasing.from, phrasing]));
  assert.equal(byFrom.get('get ready')!.count, 5);
  assert.equal(byFrom.get('get ready')!.lastObserved, T2);
  assert.equal(byFrom.get('only ours')!.count, 1);
  assert.equal(byFrom.get('only theirs')!.count, 5);
  // Highest evidence first; a tie goes to the more recently observed.
  assert.deepEqual(merged.phrasings.map((phrasing) => phrasing.from),
    ['get ready', 'only theirs', 'only ours']);
});

test('the phrasing cap keeps what has been said most', () => {
  const many = (prefix: string, count: number): StyleProfile => profileWith({
    phrasings: Array.from({ length: MAXIMUM_PHRASINGS }, (_, i) => makePhrasing(`${prefix} ${i}`, 'to', count, T1)),
  });
  const merged = mergeProfiles(many('a', 1), many('b', 4));
  assert.equal(merged.phrasings.length, MAXIMUM_PHRASINGS);
  assert.ok(merged.phrasings.every((phrasing) => phrasing.from.startsWith('b ')),
    'a low-evidence phrasing survived the trim over a high-evidence one');
});

test('merging profiles modifies neither side', () => {
  const ours = profileWith({ correctionCount: 1, phrasings: [makePhrasing('a b', 'c', 1, T1)] });
  const theirs = profileWith({ correctionCount: 2, phrasings: [makePhrasing('a b', 'c', 1, T2)] });
  const before = structuredClone(ours);
  mergeProfiles(ours, theirs);
  assert.deepEqual(ours, before);
  assert.equal(theirs.correctionCount, 2);
  assert.equal(theirs.phrasings[0]!.count, 1);
});
