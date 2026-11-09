import { readFileSync } from 'node:fs';
import { writeAtomic } from '../paths';
import { encodeJSON } from '../stores/storeFile';
import { FIREBASE_CONFIG, FIRESTORE } from './firebaseConfig';
import type { AccountObserver } from './accountStore';
import {
  mergeAPIKey, mergeByUseCount, mergeHistory, mergeStyle, mergeVocabulary, normalizeDates,
  type JSONObject, type StyleJSON, type VocabularyJSON,
} from './merge';
import { writePrivateFile } from './sessionStorage';

/// What actually moves once someone is signed in — see `AccountStore` for the
/// account itself, which this reads and does nothing else with.
///
/// # Shape
///
/// Six files, six fields on one Firestore document (`users/{uid}/sync/data`):
/// history, vocabulary, snippets, transforms, style, and the AI key. Each field
/// holds the WHOLE file's contents as a single string, not a Firestore-native
/// document — Firestore's typed field format (`stringValue`, `arrayValue`,
/// `mapValue`...) is built for querying individual fields from outside, and
/// nothing outside Quill ever will. A blob in a string field is simpler, cannot
/// drift from what each store already reads and writes on disk, and costs
/// nothing extra: six small files, not six hundred small documents. Five of the
/// six are JSON; the AI key is the plain text `nim-key.txt` already is, synced
/// as-is.
///
/// This is the same layout the macOS app writes, field for field. A Windows PC
/// and a Mac signed into one account read and write the same document, which is
/// the entire point of having an account.
///
/// # Merge, not overwrite
///
/// See `merge.ts`. Every merge is a union; nothing already on either side is
/// ever dropped.
///
/// # What is deliberately excluded
///
/// `settings.json` (hotkey, microphone) — machine-specific; a microphone id from
/// one machine means nothing on another. `account.json` — the local session
/// token itself; each machine keeps its own rather than trusting one signed into
/// two places with the same bearer token. `my-voice-for-ai.md` — a derived
/// export, regenerated on demand from the data that DOES sync.
///
/// The AI key travels over the same channel as everything else here — HTTPS to
/// Firestore, readable only by this account's own uid, per `firestore.rules`.
/// Not weaker than the rest of what already syncs; worth naming because a
/// credential is a different kind of thing to a history than a dictation is.

export type SyncField = 'history' | 'vocabulary' | 'snippets' | 'transforms' | 'style' | 'aiKey';

export interface SyncPaths {
  history: string;
  vocabulary: string;
  snippets: string;
  transforms: string;
  style: string;
  aiKey: string;
}

/// The part of `AccountStore` the engine uses — narrow on purpose, so a test can
/// hand it a stub.
export interface SyncAccount {
  observe(handler: AccountObserver): number;
  stopObserving?(id: number): void;
  validToken(): Promise<{ uid: string; idToken: string }>;
}

export interface DeviceEntry {
  id: string;
  name: string;
  lastSyncedAt: Date | null;
  isThisDevice: boolean;
}

export interface SyncEngineOptions {
  account: SyncAccount;
  paths: SyncPaths;
  /// `null` for a build with no Firebase project; every sync then reports false.
  config?: { projectID: string } | null;
  /// Tests point every request at a fake server instead of the real one.
  fetch?: typeof fetch;
  intervalMs?: number;
  now?: () => number;
  device: { id: () => string; name: () => string };
  /// Called after a merge changed a file on disk, with which one.
  ///
  /// The macOS app has no equivalent and does not need one: its stores read the
  /// file on every use. The stores in this app hold their records in memory and
  /// write the whole file on their next change, so without this a running copy
  /// would put its stale list back over the merged one on the very next
  /// dictation. Nothing is lost either way — the cloud still has the union and
  /// the next sync restores it — but a list that flickers back to its old self
  /// is a bug people report. The host reloads the named store here.
  onMerged?: (field: SyncField) => void;
}

/// Every 2 minutes while signed in, plus once immediately on sign-in — frequent
/// enough that "automatic" means something, rare enough that it is not the thing
/// keeping this machine's network light on.
export const SYNC_INTERVAL_MS = 120_000;

interface Codec<T> {
  field: SyncField;
  path: string;
  decode(text: string): T | null;
  encode(value: T): string;
  merge(local: T, remote: T): T;
  /// Set only for the AI key: a key file that is briefly world-readable HAS been
  /// world-readable, and a generic disk write here must not quietly relax that.
  isSecret?: boolean;
}

function decodeJSON(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/// All-or-nothing, like the Swift `Codable` decode this replaces: one element
/// that is not an object with an `id` makes the whole array unreadable.
function decodeRecords(text: string): JSONObject[] | null {
  const value = decodeJSON(text);
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (typeof (item as JSONObject).id !== 'string') return null;
  }
  return value as JSONObject[];
}

function decodeVocabulary(text: string): VocabularyJSON | null {
  const value = decodeJSON(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const terms = (value as { terms?: unknown }).terms;
  if (!Array.isArray(terms) || !terms.every((term) => typeof term === 'string')) return null;
  return value as VocabularyJSON;
}

function decodeStyle(text: string): StyleJSON | null {
  const value = decodeJSON(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as StyleJSON;
}

function jsonText(value: unknown): string {
  return encodeJSON(normalizeDates(value));
}

function codecs(paths: SyncPaths): Codec<never>[] {
  const history: Codec<JSONObject[]> = {
    field: 'history', path: paths.history, decode: decodeRecords, encode: jsonText, merge: mergeHistory,
  };
  const vocabulary: Codec<VocabularyJSON> = {
    field: 'vocabulary', path: paths.vocabulary, decode: decodeVocabulary, encode: jsonText, merge: mergeVocabulary,
  };
  const snippets: Codec<JSONObject[]> = {
    field: 'snippets', path: paths.snippets, decode: decodeRecords, encode: jsonText, merge: mergeByUseCount,
  };
  const transforms: Codec<JSONObject[]> = {
    field: 'transforms', path: paths.transforms, decode: decodeRecords, encode: jsonText, merge: mergeByUseCount,
  };
  const style: Codec<StyleJSON> = {
    field: 'style', path: paths.style, decode: decodeStyle, encode: jsonText, merge: mergeStyle,
  };
  // Plain text, not JSON — `nim-key.txt` already is one, and the key store never
  // writes an empty file, so an absent file and an absent field both land in the
  // "nothing on either side" case rather than needing a special empty-string
  // check elsewhere.
  const aiKey: Codec<string> = {
    field: 'aiKey',
    path: paths.aiKey,
    decode: (text) => {
      const trimmed = text.trim();
      return trimmed.length === 0 ? null : trimmed;
    },
    encode: (key) => key,
    merge: mergeAPIKey,
    isSecret: true,
  };
  return [history, vocabulary, snippets, transforms, style, aiKey] as unknown as Codec<never>[];
}

export class SyncEngine {
  private readonly options: SyncEngineOptions;
  private readonly config: { projectID: string } | null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private observerID: number | null = null;
  private isSyncing = false;

  constructor(options: SyncEngineOptions) {
    this.options = options;
    this.config = options.config === undefined ? FIREBASE_CONFIG : options.config;
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
  }

  /// Begins watching the account: a timer and an immediate sync on sign-in, the
  /// timer stopped on sign-out. Nothing here makes a request until somebody is
  /// signed in, so starting the engine at launch costs nothing for the person
  /// who never touches Account.
  start(): void {
    if (this.observerID !== null) return;
    this.observerID = this.options.account.observe((account) => {
      if (account) {
        this.startTimer();
        void this.syncNow();
      } else {
        this.stopTimer();
      }
    });
  }

  stop(): void {
    this.stopTimer();
    // Unsubscribed, not just forgotten: an engine that is stopped must not wake
    // itself up at the next sign-in.
    if (this.observerID !== null) this.options.account.stopObserving?.(this.observerID);
    this.observerID = null;
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.syncNow(); }, this.options.intervalMs ?? SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // MARK: - The sync itself

  /// Never rejects. A sync that fails reports `false` and leaves the next
  /// attempt to the timer.
  async syncNow(): Promise<boolean> {
    let uid: string;
    let token: string;
    try {
      ({ uid, idToken: token } = await this.options.account.validToken());
    } catch {
      return false;
    }
    if (!this.config) return false;
    if (this.isSyncing) return false;
    this.isSyncing = true;
    try {
      const document = await this.fetchDocument(uid, token);
      let allOK = true;
      for (const codec of codecs(this.options.paths)) {
        const ok = await this.syncField(codec as Codec<unknown>, document[codec.field], uid, token);
        allOK = allOK && ok;
      }
      // Bookkeeping for the Devices list, not data — its failure does not make
      // the sync itself a failure, so it is not part of the boolean.
      await this.registerDevice(uid, token);
      return allOK;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[quill] sync failed', error);
      return false;
    } finally {
      this.isSyncing = false;
    }
  }

  /// Reads the local file (if any), merges it with whatever the cloud already
  /// holds (if anything), writes the merged result back to BOTH disk and
  /// Firestore.
  ///
  /// Two deliberate differences from the macOS app, both on paths that only run
  /// when something is already wrong:
  ///
  /// * A local file that EXISTS but will not decode is left alone and the field
  ///   is skipped. The Mac treats it as "no local copy", so the remote copy is
  ///   written straight over it — the exact mistake every store in this app was
  ///   rewritten to stop making: damage mistaken for emptiness, answered by
  ///   overwriting the only copy somebody could still have rescued by hand.
  /// * A remote field that exists but will not decode is left alone too, rather
  ///   than replaced with ours. If a newer build wrote it in a shape this one
  ///   cannot read, uploading our older spelling would silently downgrade it for
  ///   every machine on the account.
  private async syncField(
    codec: Codec<unknown>, remoteText: string | undefined, uid: string, token: string,
  ): Promise<boolean> {
    let localText: string | null = null;
    try {
      localText = readFileSync(codec.path, 'utf8');
    } catch {
      localText = null;
    }
    const local = localText === null ? null : codec.decode(localText);
    if (localText !== null && local === null) {
      // eslint-disable-next-line no-console
      console.error(`[quill] sync: ${codec.path} exists but cannot be read — leaving it alone.`);
      return false;
    }
    const remote = remoteText === undefined ? null : codec.decode(remoteText);
    if (remoteText !== undefined && remote === null && remoteText.trim().length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[quill] sync: the cloud's ${codec.field} is in a form this build cannot read — leaving it alone.`);
      return false;
    }

    let merged: unknown;
    if (local !== null && remote !== null) merged = codec.merge(local, remote);
    else if (local !== null) merged = local;
    else if (remote !== null) merged = remote;
    else return true; // nothing on either side yet — not a failure

    const text = codec.encode(merged);

    // Written locally even if the network half below fails — a successful merge
    // should not wait on Firestore to be worth having on disk, and the next sync
    // attempt will still push it up. Not rewritten when nothing changed, so a
    // quiet account does not touch the disk every two minutes.
    if (text !== localText) {
      const wrote = codec.isSecret ? writeSecret(codec.path, text) : writeAtomic(codec.path, text);
      if (wrote) this.options.onMerged?.(codec.field);
    }

    if (text === remoteText) return true;
    return this.putField(codec.field, text, uid, token);
  }

  // MARK: - Firestore REST, minimal

  private documentURL(uid: string): string {
    return `${FIRESTORE}/projects/${this.config!.projectID}/databases/(default)/documents/users/${uid}/sync/data`;
  }

  /// The top-level `users/{uid}` document — where `AccountStore` writes
  /// email/createdAt, and where the Devices list lives, in its own `devices`
  /// field. Not the same document as `documentURL`: that one is the `sync/data`
  /// subcollection doc holding the six data fields, and Firestore rules do not
  /// let one PATCH touch both.
  private accountDocumentURL(uid: string): string {
    return `${FIRESTORE}/projects/${this.config!.projectID}/databases/(default)/documents/users/${uid}`;
  }

  /// Field name → its JSON text, for whatever fields already exist. Missing
  /// entirely (a brand new account, or the very first sync from any device) is
  /// not an error — every `syncField` call already treats "nothing remote yet"
  /// as "local wins".
  private async fetchDocument(uid: string, token: string): Promise<Record<string, string>> {
    try {
      const response = await this.fetcher(this.documentURL(uid), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status !== 200) return {};
      const json = (await response.json()) as { fields?: Record<string, { stringValue?: unknown }> };
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(json.fields ?? {})) {
        if (typeof value?.stringValue === 'string') out[key] = value.stringValue;
      }
      return out;
    } catch {
      return {};
    }
  }

  /// `updateMask` is what makes this a per-field PATCH rather than a
  /// whole-document overwrite — without it, syncing "history" would erase
  /// whatever "vocabulary" already held, since Firestore's plain PATCH replaces
  /// every field not explicitly named.
  private async putField(field: string, text: string, uid: string, token: string): Promise<boolean> {
    const query = new URLSearchParams({ 'updateMask.fieldPaths': field });
    try {
      const response = await this.fetcher(`${this.documentURL(uid)}?${query}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields: { [field]: { stringValue: text } } }),
      });
      return response.status >= 200 && response.status <= 299;
    } catch {
      return false;
    }
  }

  // MARK: - Devices, for the Account screen

  /// Writes this machine's entry into `devices.<id>` on the account document —
  /// masked to just that one key, so two machines syncing around the same time
  /// each write their own entry rather than racing to overwrite the whole map.
  /// Best-effort: see the call site in `syncNow()` for why a failure here does
  /// not fail the sync.
  private async registerDevice(uid: string, token: string): Promise<void> {
    const id = this.options.device.id();
    const query = new URLSearchParams({ 'updateMask.fieldPaths': `devices.${id}` });
    try {
      await this.fetcher(`${this.accountDocumentURL(uid)}?${query}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          fields: {
            devices: {
              mapValue: {
                fields: {
                  [id]: {
                    mapValue: {
                      fields: {
                        name: { stringValue: this.options.device.name() },
                        lastSyncedAt: { timestampValue: new Date(this.now()).toISOString() },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      });
    } catch {
      /* bookkeeping only */
    }
  }

  /// Every device that has ever synced this account, newest sync first. A
  /// snapshot, not a live feed — there is no push channel for "another machine
  /// just synced", so the Account screen calls this again to refresh.
  async fetchDevices(): Promise<DeviceEntry[]> {
    if (!this.config) return [];
    let uid: string;
    let token: string;
    try {
      ({ uid, idToken: token } = await this.options.account.validToken());
    } catch {
      return [];
    }
    let json: { fields?: Record<string, unknown> };
    try {
      const response = await this.fetcher(this.accountDocumentURL(uid), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status !== 200) return [];
      json = (await response.json()) as typeof json;
    } catch {
      return [];
    }

    const deviceFields = (json.fields?.devices as {
      mapValue?: { fields?: Record<string, { mapValue?: { fields?: Record<string, { stringValue?: string; timestampValue?: string }> } }> };
    } | undefined)?.mapValue?.fields;
    if (!deviceFields) return [];

    const thisDevice = this.options.device.id();
    const entries: DeviceEntry[] = [];
    for (const [id, value] of Object.entries(deviceFields)) {
      const fields = value?.mapValue?.fields;
      const name = fields?.name?.stringValue;
      if (typeof name !== 'string') continue;
      const stampText = fields?.lastSyncedAt?.timestampValue;
      const parsed = typeof stampText === 'string' ? new Date(stampText) : null;
      entries.push({
        id,
        name,
        lastSyncedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
        isThisDevice: id === thisDevice,
      });
    }
    return entries.sort((a, b) => (b.lastSyncedAt?.getTime() ?? 0) - (a.lastSyncedAt?.getTime() ?? 0));
  }
}

function writeSecret(path: string, text: string): boolean {
  try {
    writePrivateFile(path, text);
    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[quill] sync: could not write ${path}`, error);
    return false;
  }
}
