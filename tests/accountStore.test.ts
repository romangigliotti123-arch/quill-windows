import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountError, AccountStore } from '../src/core/account/accountStore';
import { FakeFirebase } from '../src/core/account/fakeFirebase';
import {
  FileSessionStorage, MemorySessionStorage, readAccountIdentity, type Sealer,
} from '../src/core/account/sessionStorage';
import { FIREBASE_CONFIG } from '../src/core/account/firebaseConfig';

// The account, with no network and no real project: Identity Toolkit and
// Firestore are `FakeFirebase`, and no account is ever created anywhere.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'quill-account-'));
}

function store(fake: FakeFirebase, options: { now?: () => number; storage?: MemorySessionStorage } = {}) {
  const storage = options.storage ?? new MemorySessionStorage();
  const account = new AccountStore({ storage, fetch: fake.fetch, now: options.now });
  return { account, storage };
}

/// A sealer that is not encryption at all — enough to prove the file shape.
const reversing: Sealer = {
  isAvailable: () => true,
  seal: (plain) => Buffer.from(plain, 'utf8').reverse().toString('base64'),
  open: (sealed) => Buffer.from(sealed, 'base64').reverse().toString('utf8'),
};

// MARK: - Signing up and in

test('signing up persists a session and writes the user document', async () => {
  const fake = new FakeFirebase();
  const { account, storage } = store(fake);

  await account.signUp('roman@example.com', 'hunter22');

  assert.deepEqual(account.current, { uid: 'uid1', email: 'roman@example.com' });
  assert.equal(storage.session?.email, 'roman@example.com');
  const doc = fake.docs.get('users/uid1') as { email: { stringValue: string }; createdAt: { timestampValue: string } };
  assert.equal(doc.email.stringValue, 'roman@example.com');
  assert.match(doc.createdAt.timestampValue, /^\d{4}-\d\d-\d\dT/);
});

test('every request goes to the right Identity Toolkit path with the project key', async () => {
  const fake = new FakeFirebase();
  const { account } = store(fake);
  await account.signUp('a@example.com', 'secret1');
  account.signOut();
  await account.signIn('a@example.com', 'secret1');

  const paths = fake.calls.filter((call) => call.url.includes('identitytoolkit')).map((call) =>
    call.url.split('/v1/')[1]!.split('?')[0]);
  // `accounts:signIn` does not exist; the real one is `signInWithPassword`.
  assert.deepEqual(paths, ['accounts:signUp', 'accounts:signInWithPassword']);
  assert.ok(fake.calls.every((call) => !call.url.includes('identitytoolkit') || call.url.includes(`key=${FIREBASE_CONFIG.apiKey}`)));
});

test('a signed-in account is read from storage by anything that asks `current` first', async () => {
  const fake = new FakeFirebase();
  const first = store(fake);
  await first.account.signUp('a@example.com', 'secret1');

  // A second process — the MCP server is one — that never calls `observe`.
  const second = store(fake, { storage: first.storage });
  assert.equal(second.account.current?.email, 'a@example.com');
});

test('the common failures read as sentences, and unknown ones pass through', async () => {
  const fake = new FakeFirebase();
  const { account } = store(fake);
  await account.signUp('a@example.com', 'secret1');
  account.signOut();

  const failure = async (action: () => Promise<void>): Promise<string> => {
    try { await action(); } catch (error) { return (error as Error).message; }
    return 'did not throw';
  };

  assert.equal(await failure(() => account.signUp('a@example.com', 'secret1')),
    'An account already exists for that email.');
  assert.equal(await failure(() => account.signUp('b@example.com', '123')),
    'That password is too weak — six characters or more.');
  assert.equal(await failure(() => account.signIn('a@example.com', 'wrong')),
    'That email and password don\'t match an account.');
  assert.equal(AccountStore.readable('TOO_MANY_ATTEMPTS_TRY_LATER'),
    'Too many attempts — wait a bit and try again.');
  assert.equal(AccountStore.readable('INVALID_EMAIL'), 'That doesn\'t look like an email address.');
  // Anything unrecognised is shown as it came, minus the explanatory tail.
  assert.equal(AccountStore.readable('QUOTA_EXCEEDED : Too many requests'), 'QUOTA_EXCEEDED');
  assert.equal(account.current, null, 'a failed sign-in must not leave a session behind');
});

test('a dropped connection is a network error, not a crash', async () => {
  const fake = new FakeFirebase();
  fake.offline = true;
  const { account } = store(fake);
  await assert.rejects(() => account.signIn('a@example.com', 'secret1'), (error: unknown) =>
    error instanceof AccountError && error.kind === 'network'
    && error.message === 'No connection right now — try again in a moment.');
});

test('a failed user-document write does not fail the sign-up that already succeeded', async () => {
  const fake = new FakeFirebase();
  fake.failFirestoreWrites = true;
  const { account } = store(fake);
  await account.signUp('a@example.com', 'secret1'); // must not throw
  assert.equal(account.current?.email, 'a@example.com');
});

test('a build with no Firebase project is unavailable rather than reaching for a network', async () => {
  const fake = new FakeFirebase();
  const account = new AccountStore({ storage: new MemorySessionStorage(), config: null, fetch: fake.fetch });
  await assert.rejects(() => account.signIn('a@example.com', 'secret1'), (error: unknown) =>
    error instanceof AccountError && error.kind === 'unavailable');
  assert.equal(fake.calls.length, 0);
});

// MARK: - Observers

test('an observer hears the current state at once, and every change after', async () => {
  const fake = new FakeFirebase();
  const { account } = store(fake);
  const seen: (string | null)[] = [];
  const id = account.observe((who) => seen.push(who?.email ?? null));
  assert.deepEqual(seen, [null], 'called once, immediately');

  await account.signUp('a@example.com', 'secret1');
  account.signOut();
  assert.deepEqual(seen, [null, 'a@example.com', null]);

  account.stopObserving(id);
  await account.signIn('a@example.com', 'secret1');
  assert.equal(seen.length, 3, 'a stopped observer is not called');
});

test('an observer that throws cannot stop the sign-in that caused it', async () => {
  const fake = new FakeFirebase();
  const { account } = store(fake);
  account.observe(() => { throw new Error('a view that failed to redraw'); });
  const seen: (string | null)[] = [];
  account.observe((who) => seen.push(who?.email ?? null));
  await account.signUp('a@example.com', 'secret1');
  assert.equal(account.current?.email, 'a@example.com');
  assert.deepEqual(seen, [null, 'a@example.com']);
});

// MARK: - Tokens

test('a token with more than a minute left is used as it is', async () => {
  const fake = new FakeFirebase();
  let now = 1_000_000;
  const { account } = store(fake, { now: () => now });
  await account.signUp('a@example.com', 'secret1');
  now += 3_000_000; // 50 minutes of a 60-minute token

  const token = await account.validToken();
  assert.equal(token.uid, 'uid1');
  assert.equal(fake.callsTo('securetoken').length, 0);
});

test('a token due to lapse within a minute is refreshed first, and the new one is kept', async () => {
  const fake = new FakeFirebase();
  let now = 1_000_000;
  const { account, storage } = store(fake, { now: () => now });
  await account.signUp('a@example.com', 'secret1');
  const before = storage.session!.idToken;
  now += 3_545_000; // 55 s left

  const token = await account.validToken();
  assert.equal(fake.callsTo('securetoken').length, 1);
  assert.notEqual(token.idToken, before);
  assert.equal(storage.session!.idToken, token.idToken, 'the refreshed session replaced the old one');
  // The refresh body is form-encoded, not JSON.
  assert.match(String(fake.callsTo('securetoken')[0]!.body), /^grant_type=refresh_token&refresh_token=/);
});

test('validToken with nobody signed in is unavailable', async () => {
  const { account } = store(new FakeFirebase());
  await assert.rejects(() => account.validToken(), (error: unknown) =>
    error instanceof AccountError && error.kind === 'unavailable');
});

// MARK: - Changing the password

test('changing a password re-proves the old one first, then sets the new one', async () => {
  const fake = new FakeFirebase();
  const { account } = store(fake);
  await account.signUp('a@example.com', 'oldpass1');

  await assert.rejects(() => account.changePassword('not-the-password', 'newpass1'), /don't match an account/);
  assert.equal(fake.users.get('a@example.com')!.password, 'oldpass1', 'a wrong current password changes nothing');

  await account.changePassword('oldpass1', 'newpass1');
  assert.equal(fake.users.get('a@example.com')!.password, 'newpass1');
  assert.equal(account.current?.email, 'a@example.com', 'still signed in afterwards');
  account.signOut();
  await account.signIn('a@example.com', 'newpass1');
});

// MARK: - The session file

test('the session file is plain JSON, written private, and removed on sign-out', async () => {
  const dir = scratch();
  const path = join(dir, 'account.json');
  const fake = new FakeFirebase();
  const account = new AccountStore({ storage: new FileSessionStorage(path), fetch: fake.fetch });

  await account.signUp('a@example.com', 'secret1');
  const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.equal(written.uid, 'uid1');
  assert.equal(typeof written.idToken, 'string');
  assert.equal(typeof written.refreshToken, 'string');
  assert.match(String(written.expiresAt), /^\d{4}-\d\d-\d\dT/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600, 'a token file must not be group- or world-readable');
  }

  account.signOut();
  assert.equal(existsSync(path), false, 'signing out removes the file rather than blanking it');
});

test('a session survives a restart', async () => {
  const dir = scratch();
  const path = join(dir, 'account.json');
  const fake = new FakeFirebase();
  await new AccountStore({ storage: new FileSessionStorage(path), fetch: fake.fetch })
    .signUp('a@example.com', 'secret1');

  const reopened = new AccountStore({ storage: new FileSessionStorage(path), fetch: fake.fetch });
  assert.equal(reopened.current?.email, 'a@example.com');
  assert.equal((await reopened.validToken()).uid, 'uid1');
});

test('sealed tokens are not readable in the file, but the identity is', async () => {
  const dir = scratch();
  const path = join(dir, 'account.json');
  const fake = new FakeFirebase();
  const account = new AccountStore({ storage: new FileSessionStorage(path, reversing), fetch: fake.fetch });
  await account.signUp('a@example.com', 'secret1');

  const raw = readFileSync(path, 'utf8');
  const written = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(written.idToken, undefined, 'no token in the clear');
  assert.equal(written.refreshToken, undefined);
  assert.equal(typeof written.sealed, 'string');
  assert.ok(!raw.includes('id-uid1'), 'the token text appears nowhere in the file');

  // This process can open it…
  const reopened = new AccountStore({ storage: new FileSessionStorage(path, reversing), fetch: fake.fetch });
  assert.equal((await reopened.validToken()).uid, 'uid1');
  // …and one with no sealer — the MCP server — still learns who is signed in.
  assert.deepEqual(readAccountIdentity(path), { uid: 'uid1', email: 'a@example.com' });
  const blind = new AccountStore({ storage: new FileSessionStorage(path, null), fetch: fake.fetch });
  assert.equal(blind.current, null, 'a session this process cannot open is reported signed out, not corrupted');
  assert.ok(existsSync(path), 'and the file is left exactly as it was');
});

test('a damaged session file is signed out, not an exception', () => {
  const dir = scratch();
  const path = join(dir, 'account.json');
  writeFileSync(path, '{ not json');
  const account = new AccountStore({ storage: new FileSessionStorage(path), fetch: new FakeFirebase().fetch });
  assert.equal(account.current, null);
  assert.equal(readAccountIdentity(path), null);
  assert.equal(readAccountIdentity(join(dir, 'missing.json')), null);
});
