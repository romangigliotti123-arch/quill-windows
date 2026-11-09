import {
  FIREBASE_CONFIG, FIRESTORE, IDENTITY_TOOLKIT, SECURE_TOKEN, type FirebaseConfig,
} from './firebaseConfig';
import type { Session, SessionStorage } from './sessionStorage';
import type { AccountInfo } from './types';

/// An account, entirely optional, that lets Quill's data — dictations, the
/// Dictionary, snippets, transforms, the learned style — follow you to a
/// second computer. Nothing else in Quill reads this class or requires it to
/// exist, and see `SyncEngine` for what actually moves once it does.
///
/// # Why this talks to Firebase's REST API rather than its SDK
///
/// On the Mac it did, at first — `FirebaseAuth` and `FirebaseFirestore`, the
/// real SDKs. Every sign-up and sign-in failed with `ERROR_KEYCHAIN_ERROR`: the
/// SDK's macOS keychain persistence needs a `keychain-access-groups`
/// entitlement backed by a real Apple-issued Team ID, and Quill is self-signed.
/// Confirmed against `firebase/firebase-ios-sdk#14191`: no known workaround.
///
/// The REST APIs underneath the SDK — Identity Toolkit for auth, Firestore's own
/// document API for data — have no such requirement. They are plain HTTPS, and
/// the session they hand back is a token, which is data, not a keychain item.
/// Here the same choice is made for a different reason that points the same
/// way: the Firebase web SDK is a few hundred kilobytes of code, an IndexedDB
/// persistence layer and a long-lived connection, brought into a main process
/// to read and write a handful of JSON documents — which is what the REST API
/// is *for*. One dependency fewer, one transport, and the same code path the
/// Mac build runs.
///
/// # Why this is allowed to be the one networked, cloud-backed thing in an
/// app whose entire argument for existing is "runs on your machine, learns your
/// voice, sends nothing anywhere unless you add your own AI key"
///
/// Because it does not compromise that argument — it sits beside it. Nobody is
/// asked to create an account, nothing here runs unless the Account screen is
/// touched, and no request is made at launch.

export type AccountErrorKind = 'unavailable' | 'server' | 'network';

export class AccountError extends Error {
  constructor(readonly kind: AccountErrorKind, detail?: string) {
    super(AccountError.describe(kind, detail));
    this.name = 'AccountError';
  }

  private static describe(kind: AccountErrorKind, detail?: string): string {
    switch (kind) {
      case 'unavailable': return 'Accounts aren\'t available in this build.';
      case 'server': return detail ?? 'The account server returned an error.';
      case 'network': return 'No connection right now — try again in a moment.';
    }
  }
}

export type AccountObserver = (account: AccountInfo | null) => void;

export interface AccountStoreOptions {
  storage: SessionStorage;
  /// `null` means "this build has no Firebase project", and every action then
  /// fails with `unavailable` rather than reaching for a network.
  config?: FirebaseConfig | null;
  /// Tests pass a fake; the real thing is the platform `fetch`.
  fetch?: typeof fetch;
  now?: () => number;
}

export class AccountStore {
  private readonly storage: SessionStorage;
  private readonly config: FirebaseConfig | null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  private session: Session | null = null;
  private loadedFromDisk = false;
  private readonly listeners = new Map<number, AccountObserver>();
  private nextListener = 1;

  constructor(options: AccountStoreOptions) {
    this.storage = options.storage;
    this.config = options.config === undefined ? FIREBASE_CONFIG : options.config;
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
  }

  /// `loadSessionIfNeeded()` first, matching `observe` and `validToken` —
  /// without it this answered "signed out" for the entire life of any caller
  /// that checks `current` before ever calling `observe`, because the session
  /// sits on disk until something loads it.
  get current(): AccountInfo | null {
    this.loadSessionIfNeeded();
    return this.session ? { uid: this.session.uid, email: this.session.email } : null;
  }

  /// Read from disk exactly once, the first time anything asks — matching the
  /// same lazy-touch rule as everything else here.
  private loadSessionIfNeeded(): void {
    if (this.loadedFromDisk) return;
    this.loadedFromDisk = true;
    this.session = this.storage.load();
  }

  private persist(next: Session | null): void {
    this.session = next;
    this.storage.save(next);
  }

  /// Every listener is called from this one place, and a listener that throws
  /// is logged and skipped. Not because the Mac build needed it — there the
  /// hazard was AppKit off the main thread, which a JavaScript main process
  /// cannot have — but because the same property holds: a view that fails to
  /// redraw must not be able to stop the sign-in that caused the redraw.
  private notify(): void {
    const account = this.current;
    for (const handler of [...this.listeners.values()]) {
      try {
        handler(account);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[quill] account: an observer threw', error);
      }
    }
  }

  /// Called from the Account screen when it appears, and again whenever
  /// sign-in/out happens anywhere in the app while it is open. The handler is
  /// called once, immediately, with the current state — so a card never renders
  /// its signed-out face for a frame before correcting itself.
  observe(handler: AccountObserver): number {
    this.loadSessionIfNeeded();
    const id = this.nextListener++;
    this.listeners.set(id, handler);
    try {
      handler(this.current);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[quill] account: an observer threw', error);
    }
    return id;
  }

  stopObserving(id: number): void {
    this.listeners.delete(id);
  }

  // MARK: - Actions

  async signUp(email: string, password: string): Promise<void> {
    await this.authenticate('signUp', email, password);
  }

  async signIn(email: string, password: string): Promise<void> {
    await this.authenticate('signIn', email, password);
  }

  /// The real Identity Toolkit path names are `accounts:signUp` and
  /// `accounts:signInWithPassword` — there is no `accounts:signIn`, which is
  /// the typo this function exists to make impossible. Kept as one function
  /// with a `mode` because the two calls are otherwise identical: same request
  /// shape, same response shape, same error mapping.
  private async authenticate(mode: 'signUp' | 'signIn', email: string, password: string): Promise<void> {
    const config = this.requireConfig();
    const path = mode === 'signUp' ? 'accounts:signUp' : 'accounts:signInWithPassword';
    const { status, body } = await this.send(
      `${IDENTITY_TOOLKIT}/${path}?key=${encodeURIComponent(config.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    AccountStore.throwIfError(status, body);

    const json = AccountStore.parseObject(body);
    const idToken = json?.idToken;
    const refreshToken = json?.refreshToken;
    const uid = json?.localId;
    const expiresIn = Number(json?.expiresIn);
    if (typeof idToken !== 'string' || typeof refreshToken !== 'string'
      || typeof uid !== 'string' || !Number.isFinite(expiresIn)) {
      throw new AccountError('server', 'The account server sent back something Quill didn\'t expect.');
    }

    const session: Session = {
      uid, email, idToken, refreshToken, expiresAt: new Date(this.now() + expiresIn * 1000),
    };
    this.persist(session);

    if (mode === 'signUp') {
      await this.writeAccountDocument(session, config);
    }
    this.notify();
  }

  signOut(): void {
    this.loadSessionIfNeeded();
    this.persist(null);
    this.notify();
  }

  /// Re-proves the current password with a normal sign-in before changing it —
  /// the same thing the operating system asks for before it lets you change
  /// yours, not because the session in hand isn't valid, but because this is
  /// worth asking again for.
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const account = this.current;
    if (!account) throw new AccountError('unavailable');
    await this.authenticate('signIn', account.email, currentPassword);
    const config = this.requireConfig();
    const reauthed = this.session;
    if (!reauthed) throw new AccountError('unavailable');

    const { status, body } = await this.send(
      `${IDENTITY_TOOLKIT}/accounts:update?key=${encodeURIComponent(config.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: reauthed.idToken, password: newPassword, returnSecureToken: true }),
      },
    );
    AccountStore.throwIfError(status, body);
    const json = AccountStore.parseObject(body);
    const idToken = json?.idToken;
    const refreshToken = json?.refreshToken;
    const expiresIn = Number(json?.expiresIn);
    if (typeof idToken !== 'string' || typeof refreshToken !== 'string' || !Number.isFinite(expiresIn)) {
      throw new AccountError('server', 'The account server sent back something Quill didn\'t expect.');
    }
    this.persist({
      uid: reauthed.uid,
      email: reauthed.email,
      idToken,
      refreshToken,
      expiresAt: new Date(this.now() + expiresIn * 1000),
    });
  }

  /// One document, `users/{uid}`: an email and a creation date. Nothing about
  /// how anyone writes, nothing they have dictated — that is `SyncEngine`'s
  /// job, and it writes to a different path under the same document once there
  /// is something worth syncing.
  private async writeAccountDocument(session: Session, config: FirebaseConfig): Promise<void> {
    const url = `${FIRESTORE}/projects/${config.projectID}/databases/(default)/documents/users/${session.uid}`;
    try {
      const { status, body } = await this.send(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.idToken}`,
        },
        body: JSON.stringify({
          fields: {
            email: { stringValue: session.email },
            createdAt: { timestampValue: new Date(this.now()).toISOString() },
          },
        }),
      });
      // Not fatal to the sign-up itself — the account exists and the user is
      // signed in either way. Logged so a real failure here is at least
      // findable, rather than silently leaving the users/ collection one
      // document short of the accounts that exist.
      if (status < 200 || status > 299) {
        // eslint-disable-next-line no-console
        console.error(`[quill] account: writing the user document failed: ${body}`);
      }
    } catch (error) {
      // The Mac build lets a transport failure here escape and report the whole
      // sign-up as failed, with the session already saved — which contradicts
      // the comment above it. A dropped connection between two requests is the
      // same non-event as a 4xx on the second one.
      // eslint-disable-next-line no-console
      console.error('[quill] account: writing the user document failed', error);
    }
  }

  // MARK: - Token refresh, for SyncEngine

  /// A valid ID token, refreshing first if the current one is due to expire in
  /// under a minute. Every Firestore REST call `SyncEngine` makes goes through
  /// this rather than reading the session's token directly.
  async validToken(): Promise<{ uid: string; idToken: string }> {
    this.loadSessionIfNeeded();
    const current = this.session;
    if (!current) throw new AccountError('unavailable');
    if (current.expiresAt.getTime() - this.now() <= 60_000) return this.refresh(current);
    return { uid: current.uid, idToken: current.idToken };
  }

  private async refresh(expiring: Session): Promise<{ uid: string; idToken: string }> {
    const config = this.requireConfig();
    const { status, body } = await this.send(
      `${SECURE_TOKEN}?key=${encodeURIComponent(config.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(expiring.refreshToken)}`,
      },
    );
    AccountStore.throwIfError(status, body);
    const json = AccountStore.parseObject(body);
    // The refresh endpoint's response uses different key casing than
    // sign-in's — snake_case, not camelCase. Different Google API, different
    // convention; both are read here rather than assumed to match.
    const idToken = json?.id_token;
    const refreshToken = json?.refresh_token;
    const expiresIn = Number(json?.expires_in);
    if (typeof idToken !== 'string' || typeof refreshToken !== 'string' || !Number.isFinite(expiresIn)) {
      throw new AccountError('server', 'Couldn\'t refresh the sign-in — try signing in again.');
    }
    const refreshed: Session = {
      uid: expiring.uid,
      email: expiring.email,
      idToken,
      refreshToken,
      expiresAt: new Date(this.now() + expiresIn * 1000),
    };
    this.persist(refreshed);
    return { uid: refreshed.uid, idToken: refreshed.idToken };
  }

  // MARK: - Transport

  private requireConfig(): FirebaseConfig {
    if (!this.config) throw new AccountError('unavailable');
    return this.config;
  }

  /// Only a transport failure becomes `network`. An HTTP error status is a
  /// response, and is read by `throwIfError` for what the server actually said.
  private async send(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ status: number; body: string }> {
    try {
      const response = await this.fetcher(url, init);
      return { status: response.status, body: await response.text() };
    } catch {
      throw new AccountError('network');
    }
  }

  private static parseObject(body: string): Record<string, unknown> | null {
    try {
      const value = JSON.parse(body) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /// Identity Toolkit puts the useful part of an error at `error.message`, an
  /// all-caps code ("EMAIL_EXISTS", "WEAK_PASSWORD", "INVALID_LOGIN_CREDENTIALS")
  /// rather than a sentence — translated where the common ones are known,
  /// passed through for anything else rather than hidden behind a generic
  /// failure.
  static throwIfError(status: number, body: string): void {
    if (status >= 200 && status <= 299) return;
    const error = AccountStore.parseObject(body)?.error;
    const message = error && typeof error === 'object'
      ? (error as { message?: unknown }).message
      : undefined;
    const code = typeof message === 'string' ? message : 'UNKNOWN_ERROR';
    throw new AccountError('server', AccountStore.readable(code));
  }

  static readable(code: string): string {
    switch (code) {
      case 'EMAIL_EXISTS': return 'An account already exists for that email.';
      case 'INVALID_EMAIL': return 'That doesn\'t look like an email address.';
      case 'EMAIL_NOT_FOUND':
      case 'INVALID_PASSWORD':
      case 'INVALID_LOGIN_CREDENTIALS':
        return 'That email and password don\'t match an account.';
      case 'TOO_MANY_ATTEMPTS_TRY_LATER': return 'Too many attempts — wait a bit and try again.';
      default:
        if (code.startsWith('WEAK_PASSWORD')) return 'That password is too weak — six characters or more.';
        return code.split(':')[0]?.trim() || code;
    }
  }
}
