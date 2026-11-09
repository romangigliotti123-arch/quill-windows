/// A stand-in for the two Google services the account talks to, small enough to
/// read in one sitting: Identity Toolkit (sign up / in / update / refresh) and
/// Firestore's document API (GET, and PATCH with an `updateMask`).
///
/// It exists so the account and sync code can be proven end to end — two
/// computers, one account, a merge in the middle — with no network, no real
/// project and, above all, no real account created anywhere. It is not shipped
/// in the app: nothing in `src/main` imports it, so the bundler drops it.
///
/// It enforces the one security rule that matters for these tests, the same one
/// `firebase/firestore.rules` states: a document under `users/{uid}` can only be
/// touched with a token that was issued to that uid.

interface FakeUser { uid: string; email: string; password: string }
type Fields = Record<string, unknown>;

export interface FakeCall { method: string; url: string; body: unknown; headers: Record<string, string> }

export class FakeFirebase {
  readonly users = new Map<string, FakeUser>();
  /// Document path (`users/<uid>/sync/data`) → its `fields` object.
  readonly docs = new Map<string, Fields>();
  readonly calls: FakeCall[] = [];
  /// Every transport call throws, as if the network were down.
  offline = false;
  /// Writes under `users/` answer 500 — for proving a failed side-write is not
  /// a failed sign-up.
  failFirestoreWrites = false;
  expiresIn = '3600';

  private tokens = new Map<string, string>(); // idToken → uid
  private refreshTokens = new Map<string, string>(); // refreshToken → uid
  private counter = 0;

  private issue(uid: string): { idToken: string; refreshToken: string } {
    this.counter += 1;
    const idToken = `id-${uid}-${this.counter}`;
    const refreshToken = `refresh-${uid}-${this.counter}`;
    this.tokens.set(idToken, uid);
    this.refreshTokens.set(refreshToken, uid);
    return { idToken, refreshToken };
  }

  /// Revokes an ID token without touching the refresh token — an expired one.
  expireIDToken(idToken: string): void {
    this.tokens.delete(idToken);
  }

  callsTo(fragment: string): FakeCall[] {
    return this.calls.filter((call) => call.url.includes(fragment));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    let body: unknown = rawBody;
    try { body = JSON.parse(rawBody); } catch { /* form-encoded or empty */ }
    this.calls.push({ method, url, body, headers });

    if (this.offline) throw new TypeError('fetch failed');

    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/')) return this.identity(url, body);
    if (url.startsWith('https://securetoken.googleapis.com/v1/token')) return this.refresh(rawBody);
    if (url.startsWith('https://firestore.googleapis.com/v1/')) return this.firestore(url, method, body, headers);
    return reply(404, { error: { message: 'NOT_FOUND' } });
  };

  // MARK: - Identity Toolkit

  private identity(url: string, body: unknown): Response {
    const path = url.split('/v1/')[1]!.split('?')[0]!;
    const request = body as { email?: string; password?: string; idToken?: string };

    if (path === 'accounts:signUp') {
      if (this.users.has(request.email ?? '')) return reply(400, { error: { message: 'EMAIL_EXISTS' } });
      if ((request.password ?? '').length < 6) {
        return reply(400, { error: { message: 'WEAK_PASSWORD : Password should be at least 6 characters' } });
      }
      const uid = `uid${this.users.size + 1}`;
      this.users.set(request.email!, { uid, email: request.email!, password: request.password! });
      return reply(200, { ...this.issue(uid), localId: uid, expiresIn: this.expiresIn, email: request.email });
    }

    if (path === 'accounts:signInWithPassword') {
      const user = this.users.get(request.email ?? '');
      if (!user || user.password !== request.password) {
        return reply(400, { error: { message: 'INVALID_LOGIN_CREDENTIALS' } });
      }
      return reply(200, { ...this.issue(user.uid), localId: user.uid, expiresIn: this.expiresIn, email: user.email });
    }

    if (path === 'accounts:update') {
      const uid = this.tokens.get(request.idToken ?? '');
      const user = [...this.users.values()].find((candidate) => candidate.uid === uid);
      if (!user) return reply(400, { error: { message: 'INVALID_ID_TOKEN' } });
      user.password = request.password ?? user.password;
      return reply(200, { ...this.issue(user.uid), localId: user.uid, expiresIn: this.expiresIn });
    }

    return reply(400, { error: { message: 'OPERATION_NOT_ALLOWED' } });
  }

  private refresh(rawBody: string): Response {
    const form = new URLSearchParams(rawBody);
    const uid = this.refreshTokens.get(form.get('refresh_token') ?? '');
    if (form.get('grant_type') !== 'refresh_token' || !uid) {
      return reply(400, { error: { message: 'INVALID_REFRESH_TOKEN' } });
    }
    const { idToken, refreshToken } = this.issue(uid);
    // snake_case, as the real endpoint answers — the account code must read both
    // spellings and not assume they match.
    return reply(200, { id_token: idToken, refresh_token: refreshToken, expires_in: this.expiresIn, user_id: uid });
  }

  // MARK: - Firestore

  private firestore(url: string, method: string, body: unknown, headers: Record<string, string>): Response {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname.split('/documents/')[1] ?? '');
    const uid = path.split('/')[1];
    const bearer = (headers.authorization ?? '').replace(/^Bearer /, '');
    if (!path.startsWith('users/') || this.tokens.get(bearer) !== uid) {
      return reply(403, { error: { status: 'PERMISSION_DENIED' } });
    }

    if (method === 'GET') {
      const fields = this.docs.get(path);
      return fields ? reply(200, { name: path, fields }) : reply(404, { error: { status: 'NOT_FOUND' } });
    }

    if (method === 'PATCH') {
      if (this.failFirestoreWrites) return reply(500, { error: { status: 'INTERNAL' } });
      const incoming = ((body as { fields?: Fields }).fields ?? {}) as Fields;
      const masks = parsed.searchParams.getAll('updateMask.fieldPaths');
      const existing = this.docs.get(path) ?? {};
      if (masks.length === 0) {
        // No mask: the plain PATCH replaces every field it does not name — the
        // trap `updateMask` exists to avoid.
        this.docs.set(path, incoming);
      } else {
        for (const mask of masks) applyMask(existing, incoming, mask.split('.'));
        this.docs.set(path, existing);
      }
      return reply(200, { name: path, fields: this.docs.get(path) });
    }

    return reply(405, { error: { status: 'METHOD_NOT_ALLOWED' } });
  }
}

function applyMask(target: Fields, source: Fields, path: string[]): void {
  const [head, ...rest] = path;
  if (!head) return;
  if (rest.length === 0) {
    if (head in source) target[head] = source[head];
    return;
  }
  // A path into a map: `devices.<id>` sets one key inside `devices.mapValue.fields`.
  const sourceMap = ((source[head] as { mapValue?: { fields?: Fields } } | undefined)?.mapValue?.fields) ?? {};
  const existing = (target[head] as { mapValue?: { fields?: Fields } } | undefined)
    ?? { mapValue: { fields: {} } };
  existing.mapValue = existing.mapValue ?? { fields: {} };
  existing.mapValue.fields = existing.mapValue.fields ?? {};
  applyMask(existing.mapValue.fields, sourceMap, rest);
  target[head] = existing;
}

function reply(status: number, json: unknown): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}
