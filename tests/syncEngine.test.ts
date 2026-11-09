import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountStore } from '../src/core/account/accountStore';
import { FakeFirebase } from '../src/core/account/fakeFirebase';
import { MemorySessionStorage } from '../src/core/account/sessionStorage';
import { SyncEngine, type SyncField, type SyncPaths } from '../src/core/account/syncEngine';

// Two computers, one account, a merge in the middle — against a fake Identity
// Toolkit and Firestore, with real files in temporary directories. No network,
// and no real account created anywhere.

const SYNC_DOC = 'users/uid1/sync/data';

interface Machine {
  account: AccountStore;
  engine: SyncEngine;
  paths: SyncPaths;
  merged: SyncField[];
  dir: string;
}

function machine(fake: FakeFirebase, label: string, now: () => number): Machine {
  const dir = mkdtempSync(join(tmpdir(), `quill-sync-${label}-`));
  const paths: SyncPaths = {
    history: join(dir, 'history.json'),
    vocabulary: join(dir, 'vocabulary.json'),
    snippets: join(dir, 'snippets.json'),
    transforms: join(dir, 'transforms.json'),
    style: join(dir, 'style.json'),
    aiKey: join(dir, 'nim-key.txt'),
  };
  const account = new AccountStore({ storage: new MemorySessionStorage(), fetch: fake.fetch });
  const merged: SyncField[] = [];
  const engine = new SyncEngine({
    account,
    paths,
    fetch: fake.fetch,
    now,
    device: { id: () => `d${label}`, name: () => `${label}-machine` },
    onMerged: (field) => merged.push(field),
  });
  return { account, engine, paths, merged, dir };
}

const write = (path: string, value: unknown): void => {
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};
const readJSON = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const remoteField = (fake: FakeFirebase, field: string): string | undefined =>
  (fake.docs.get(SYNC_DOC)?.[field] as { stringValue?: string } | undefined)?.stringValue;

const record = (id: string, text: string, date = '2026-08-24T10:00:00Z') => ({
  id, date, rawText: text, insertedText: text, wordCount: text.split(' ').length,
});

async function twoMachines(): Promise<{ fake: FakeFirebase; a: Machine; b: Machine }> {
  const fake = new FakeFirebase();
  const a = machine(fake, 'A', () => Date.parse('2026-09-01T10:00:00Z'));
  const b = machine(fake, 'B', () => Date.parse('2026-09-01T11:00:00Z'));
  await a.account.signUp('roman@example.com', 'hunter22');
  await b.account.signIn('roman@example.com', 'hunter22');
  return { fake, a, b };
}

// MARK: - One machine

test('the first sync pushes every field that has a file, each with its own update mask', async () => {
  const { fake, a } = await twoMachines();
  write(a.paths.history, [record('1', 'hello there')]);
  write(a.paths.vocabulary, { terms: ['Netlify'] });
  write(a.paths.style, { preset: 'casual', correctionCount: 3 });
  write(a.paths.aiKey, 'nvapi-secret');

  assert.equal(await a.engine.syncNow(), true);

  for (const field of ['history', 'vocabulary', 'style', 'aiKey']) {
    assert.ok(remoteField(fake, field), `${field} was not uploaded`);
  }
  // No file, nothing to say — and nothing invented for it.
  assert.equal(remoteField(fake, 'snippets'), undefined);
  assert.equal(remoteField(fake, 'transforms'), undefined);
  assert.equal(remoteField(fake, 'aiKey'), 'nvapi-secret', 'the key is the plain text file, as it is');

  const patches = fake.calls.filter((call) => call.method === 'PATCH' && call.url.includes('/sync/data'));
  assert.equal(patches.length, 4);
  for (const patch of patches) {
    assert.match(patch.url, /updateMask\.fieldPaths=\w+$/, 'a PATCH without a mask would erase the other fields');
  }
  assert.ok(patches.every((patch) => patch.headers.authorization?.startsWith('Bearer id-uid1-')));
});

test('a timestamp with fractional seconds goes up as whole seconds, so a Mac can read it', async () => {
  const { fake, a } = await twoMachines();
  write(a.paths.history, [record('1', 'hello', '2026-08-24T10:00:00.123Z')]);
  await a.engine.syncNow();
  assert.equal(JSON.parse(remoteField(fake, 'history')!)[0].date, '2026-08-24T10:00:00Z');
});

test('nothing on either side is not a failure', async () => {
  const { a } = await twoMachines();
  assert.equal(await a.engine.syncNow(), true);
});

test('a second sync with nothing changed writes nothing to disk and nothing to the data document', async () => {
  const { fake, a } = await twoMachines();
  write(a.paths.history, [record('1', 'hello')]);
  await a.engine.syncNow();
  const written = readFileSync(a.paths.history, 'utf8');
  const before = fake.calls.filter((call) => call.url.includes('/sync/data') && call.method === 'PATCH').length;

  assert.equal(await a.engine.syncNow(), true);

  assert.equal(readFileSync(a.paths.history, 'utf8'), written);
  const after = fake.calls.filter((call) => call.url.includes('/sync/data') && call.method === 'PATCH').length;
  assert.equal(after, before, 'a quiet account does not re-upload every two minutes');
});

// MARK: - Two machines

test('two machines converge on the union, and neither loses what it had', async () => {
  const { fake, a, b } = await twoMachines();
  write(a.paths.history, [record('shared', 'said on both'), record('a1', 'only on A')]);
  write(b.paths.history, [record('shared', 'said on both'), record('b1', 'only on B')]);
  write(a.paths.vocabulary, { terms: ['Craigieburn', 'graphify'] });
  write(b.paths.vocabulary, { terms: ['craigieburn', 'Netlify'] });
  write(a.paths.snippets, [{ id: 's', phrase: 'sig', replacement: 'Roman', useCount: 2 }]);
  write(b.paths.snippets, [{ id: 's', phrase: 'sig', replacement: 'Roman', useCount: 40 }, { id: 't', useCount: 0 }]);

  assert.equal(await a.engine.syncNow(), true);
  assert.equal(await b.engine.syncNow(), true);
  assert.equal(await a.engine.syncNow(), true); // A hears what B added

  for (const m of [a, b]) {
    assert.deepEqual(new Set(readJSON(m.paths.history).map((item: any) => item.id)),
      new Set(['shared', 'a1', 'b1']));
    assert.equal(readJSON(m.paths.history).length, 3, 'the shared dictation is not listed twice');
    assert.equal(readJSON(m.paths.vocabulary).terms.length, 3);
    assert.equal(readJSON(m.paths.snippets).find((item: any) => item.id === 's').useCount, 40);
  }
  // The cloud holds the union too.
  assert.equal(JSON.parse(remoteField(fake, 'history')!).length, 3);
});

test('a machine with no key picks up the account\'s, and one with a key keeps its own', async () => {
  const { a, b } = await twoMachines();
  write(a.paths.aiKey, 'key-from-A');
  await a.engine.syncNow();

  await b.engine.syncNow();
  assert.equal(readFileSync(b.paths.aiKey, 'utf8'), 'key-from-A');
  if (process.platform !== 'win32') {
    assert.equal(statSync(b.paths.aiKey).mode & 0o777, 0o600, 'a key file must never be briefly readable by others');
  }

  write(b.paths.aiKey, 'key-from-B');
  await b.engine.syncNow();
  assert.equal(readFileSync(b.paths.aiKey, 'utf8'), 'key-from-B', 'local wins, and is what everyone converges to');
  await a.engine.syncNow();
  assert.equal(readFileSync(a.paths.aiKey, 'utf8'), 'key-from-A', 'A keeps deciding for itself until it is changed there');
});

test('style evidence from both machines is added together', async () => {
  const { a, b } = await twoMachines();
  const style = (corrections: number, british: number) => ({
    preset: 'casual', appTones: {}, isLearningEnabled: true,
    spelling: { votes: { british }, lastObserved: null },
    contractions: { votes: {}, lastObserved: null }, formality: { votes: {}, lastObserved: null },
    oxfordComma: { votes: {}, lastObserved: null }, exclamations: { votes: {}, lastObserved: null },
    sentenceLength: { total: 0, count: 0 }, phrasings: [],
    correctionCount: corrections, modelAccepted: 0, modelReverted: 0, lastLearned: null,
  });
  write(a.paths.style, style(5, 2));
  write(b.paths.style, style(7, 3));
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.equal(readJSON(b.paths.style).correctionCount, 12);
  assert.deepEqual(readJSON(b.paths.style).spelling.votes, { british: 5 });
});

test('the host is told which stores to reload, and only when a file really changed', async () => {
  const { a, b } = await twoMachines();
  write(a.paths.history, [record('a1', 'only on A')]);
  write(b.paths.history, [record('b1', 'only on B')]);
  await a.engine.syncNow();
  b.merged.length = 0;
  await b.engine.syncNow();
  assert.ok(b.merged.includes('history'), 'B\'s history changed, so its store must reload');
  assert.ok(!b.merged.includes('style'));
  b.merged.length = 0;
  await b.engine.syncNow();
  assert.deepEqual(b.merged, [], 'a second sync with nothing new rewrites nothing');
});

// MARK: - Devices

test('each machine registers itself without overwriting the other\'s entry', async () => {
  const { fake, a, b } = await twoMachines();
  await a.engine.syncNow();
  await b.engine.syncNow();

  const registrations = fake.calls.filter((call) =>
    call.method === 'PATCH' && call.url.includes('devices.'));
  assert.deepEqual(registrations.map((call) => call.url.match(/devices\.(\w+)/)![1]), ['dA', 'dB']);

  const fromA = await a.engine.fetchDevices();
  assert.deepEqual(fromA.map((device) => device.name), ['B-machine', 'A-machine'], 'newest sync first');
  assert.deepEqual(fromA.map((device) => device.isThisDevice), [false, true]);
  const fromB = await b.engine.fetchDevices();
  assert.deepEqual(fromB.map((device) => device.isThisDevice), [true, false]);
  assert.equal(fromA[1]!.lastSyncedAt?.toISOString(), '2026-09-01T10:00:00.000Z');
});

test('the device list is empty, not an error, before anyone has synced', async () => {
  const { a } = await twoMachines();
  assert.deepEqual(await a.engine.fetchDevices(), []);
});

// MARK: - When something is wrong

test('a local file that will not decode is left exactly as it was', async () => {
  const { fake, a, b } = await twoMachines();
  write(b.paths.history, [record('b1', 'on B')]);
  await b.engine.syncNow();

  write(a.paths.history, '{ this is not json');
  const ok = await a.engine.syncNow();

  assert.equal(ok, false);
  assert.equal(readFileSync(a.paths.history, 'utf8'), '{ this is not json',
    'the damaged bytes were NOT replaced by the cloud\'s copy');
  assert.equal(JSON.parse(remoteField(fake, 'history')!).length, 1, 'and the cloud was not touched');
  // Other fields still sync.
  write(a.paths.vocabulary, { terms: ['x'] });
  await a.engine.syncNow();
  assert.ok(remoteField(fake, 'vocabulary'));
});

test('a remote field this build cannot read is not overwritten with ours', async () => {
  const { fake, a } = await twoMachines();
  fake.docs.set(SYNC_DOC, { style: { stringValue: 'a format from the future' } });
  write(a.paths.style, { preset: 'casual', correctionCount: 1 });

  assert.equal(await a.engine.syncNow(), false);
  assert.equal(remoteField(fake, 'style'), 'a format from the future');
});

test('offline, the sync reports failure and loses nothing', async () => {
  const { fake, a } = await twoMachines();
  write(a.paths.history, [record('1', 'hello')]);
  fake.offline = true;
  assert.equal(await a.engine.syncNow(), false);
  assert.equal(readJSON(a.paths.history)[0].id, '1');
});

test('signed out, a sync makes no request at all', async () => {
  const fake = new FakeFirebase();
  const m = machine(fake, 'A', Date.now);
  assert.equal(await m.engine.syncNow(), false);
  assert.equal(fake.calls.length, 0);
});

test('a build with no Firebase project never syncs', async () => {
  const fake = new FakeFirebase();
  const { account, paths } = machine(fake, 'A', Date.now);
  await account.signUp('a@example.com', 'secret1');
  const engine = new SyncEngine({
    account, paths, config: null, fetch: fake.fetch, device: { id: () => 'dA', name: () => 'A' },
  });
  const before = fake.calls.length;
  assert.equal(await engine.syncNow(), false);
  assert.equal(fake.calls.length, before);
});

test('one sync at a time', async () => {
  const { fake, a } = await twoMachines();
  write(a.paths.history, [record('1', 'hello')]);
  const [first, second] = await Promise.all([a.engine.syncNow(), a.engine.syncNow()]);
  assert.deepEqual([first, second].sort(), [false, true], 'the overlapping call backs off instead of racing');
  assert.equal(fake.calls.filter((call) => call.method === 'GET' && call.url.endsWith('/sync/data')).length, 1);
});

test('an expired token is refreshed on the way in', async () => {
  const fake = new FakeFirebase();
  let now = 0;
  const m = machine(fake, 'A', () => now);
  const account = new AccountStore({ storage: new MemorySessionStorage(), fetch: fake.fetch, now: () => now });
  await account.signUp('a@example.com', 'secret1');
  const engine = new SyncEngine({
    account, paths: m.paths, fetch: fake.fetch, now: () => now, device: { id: () => 'dA', name: () => 'A' },
  });
  write(m.paths.history, [record('1', 'hello')]);
  now = 3_580_000;

  assert.equal(await engine.syncNow(), true);
  assert.equal(fake.callsTo('securetoken').length, 1);
});

// MARK: - Following the account

test('signing in starts a sync at once; signing out stops the timer', async () => {
  const fake = new FakeFirebase();
  const m = machine(fake, 'A', Date.now);
  write(m.paths.history, [record('1', 'hello')]);
  m.engine.start();
  assert.equal(fake.calls.length, 0, 'starting the engine makes no request while signed out');

  await m.account.signUp('a@example.com', 'secret1');
  // The sync is started, not awaited, by the account change; give it the ticks.
  for (let i = 0; i < 50 && !remoteField(fake, 'history'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(remoteField(fake, 'history'), 'signing in did not sync');

  m.account.signOut();
  m.engine.stop();
  assert.ok(existsSync(m.paths.history), 'signing out does not touch the local data');
});
