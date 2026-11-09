import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AccountInfo } from './types';

/// Where a signed-in session is kept between launches.
///
/// # Why a file, and why this shape
///
/// The macOS app stores the session in one file, mode 0600, beside everything
/// else Quill owns — because the Firebase SDK's keychain persistence needs an
/// entitlement a self-signed app cannot have, and the REST session is only a
/// token, which is data. This is that file. The tokens are exactly as sensitive
/// as the AI API key (enough to act as the user against their own account) and
/// are stored the way it is.
///
/// On Windows and Linux Electron has something the Mac build never had to
/// lean on: `safeStorage`, which seals a string with DPAPI (Windows), the
/// login keyring (Linux) or the Keychain (macOS). When it is available the two
/// tokens are sealed and only the NON-secret half of the session — who is
/// signed in, and when the token lapses — stays readable. That split is
/// deliberate: `QuillMCP` is a plain Node process with no Electron APIs, and
/// all it needs is "is somebody signed in, and who". Sealing the whole file
/// would make the MCP server answer "signed out" forever on exactly the
/// machines that had the better protection.
///
/// When sealing is not available (no keyring on a minimal Linux, a unit test,
/// the MCP process itself) the file falls back to the Mac's own arrangement:
/// plain JSON, 0600.

export interface Session {
  uid: string;
  email: string;
  idToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/// Something that can seal a string so only this user's login session can open
/// it. `src/main/account/safeStorageSealer.ts` provides the Electron one.
export interface Sealer {
  isAvailable(): boolean;
  /// Returns an opaque ASCII string (base64).
  seal(plain: string): string;
  /// Null when the string cannot be opened — a different user, a different
  /// machine, a keyring that was reset. Never throws.
  open(sealed: string): string | null;
}

export interface SessionStorage {
  load(): Session | null;
  /// `null` signs out: the file is removed, not blanked.
  save(session: Session | null): void;
}

interface OnDisk {
  uid?: unknown;
  email?: unknown;
  expiresAt?: unknown;
  idToken?: unknown;
  refreshToken?: unknown;
  sealed?: unknown;
}

function parse(path: string): OnDisk | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as OnDisk) : null;
  } catch {
    return null;
  }
}

/// Who is signed in, read without opening anything sealed.
///
/// This is what the MCP server calls. It deliberately does NOT go through
/// `AccountStore`: the store would need a sealer to read the tokens, and the
/// server has no use for them.
export function readAccountIdentity(path: string): AccountInfo | null {
  const disk = parse(path);
  if (!disk) return null;
  if (typeof disk.uid !== 'string' || disk.uid.length === 0) return null;
  if (typeof disk.email !== 'string') return null;
  return { uid: disk.uid, email: disk.email };
}

/// Written with the mode set at creation, then renamed over the old file.
///
/// The Mac build removes the file and re-creates it with `0o600` for the same
/// reason: a token file that is briefly world-readable HAS been world-readable.
/// Setting the mode on `open` rather than `chmod`-ing afterwards leaves no
/// window, and the rename means a crash mid-write cannot leave a half-written
/// session that decodes as "signed out". Windows ignores the mode; the profile
/// directory it lives in is already private to the user there.
export function writePrivateFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

export class FileSessionStorage implements SessionStorage {
  constructor(
    private readonly path: string,
    private readonly sealer: Sealer | null = null,
  ) {}

  load(): Session | null {
    const disk = parse(this.path);
    if (!disk) return null;
    if (typeof disk.uid !== 'string' || typeof disk.email !== 'string') return null;
    const expiresAt = typeof disk.expiresAt === 'string' ? new Date(disk.expiresAt) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime())) return null;

    let idToken = disk.idToken;
    let refreshToken = disk.refreshToken;
    if (typeof disk.sealed === 'string') {
      // Sealed by a sealer this process may not have. Signed out is the honest
      // answer: the file is intact, it just cannot be opened from here.
      const opened = this.sealer?.isAvailable() ? this.sealer.open(disk.sealed) : null;
      if (opened === null || opened === undefined) return null;
      try {
        const tokens = JSON.parse(opened) as { idToken?: unknown; refreshToken?: unknown };
        idToken = tokens.idToken;
        refreshToken = tokens.refreshToken;
      } catch {
        return null;
      }
    }
    if (typeof idToken !== 'string' || typeof refreshToken !== 'string') return null;
    return { uid: disk.uid, email: disk.email, idToken, refreshToken, expiresAt };
  }

  save(session: Session | null): void {
    if (session === null) {
      try {
        unlinkSync(this.path);
      } catch {
        /* already gone — which is the state that was asked for */
      }
      return;
    }
    const header = {
      uid: session.uid,
      email: session.email,
      expiresAt: session.expiresAt.toISOString(),
    };
    const tokens = { idToken: session.idToken, refreshToken: session.refreshToken };
    const body = this.sealer?.isAvailable()
      ? { ...header, sealed: this.sealer.seal(JSON.stringify(tokens)) }
      : { ...header, ...tokens };
    try {
      writePrivateFile(this.path, `${JSON.stringify(body, null, 2)}\n`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[quill] account: could not save the session to ${this.path}`, error);
    }
  }
}

/// A storage that never touches disk. Tests, and anything that wants an
/// `AccountStore` it can throw away.
export class MemorySessionStorage implements SessionStorage {
  constructor(public session: Session | null = null) {}
  load(): Session | null { return this.session; }
  save(session: Session | null): void { this.session = session; }
}
