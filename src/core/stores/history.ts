import { dataFile, expandTilde, writeAtomic } from '../paths';
import { encodeJSON, fromISO, readStoreFile, toISO, uuid } from './storeFile';
import { QuillSettings, retentionCutoff } from '../settings';
import { wordCount as countWords, trim } from '../text/strings';

/// Every dictation, on disk, with its timings.
///
/// The shape here is load-bearing beyond the app: the comparison rig reads this
/// file to score Quill against other dictation tools, and those keep separate
/// raw-ASR and formatted columns. We keep the same split so the two are scored
/// like for like — raw against raw for accuracy, cleaned against formatted for
/// formatting. Collapsing them into one field would mean measuring punctuation
/// and calling it accuracy.
export interface DictationTimings {
  timeToFirstWordMs: number | null;
  finalToInsertedMs: number | null;
  endToEndMs: number | null;
  audioDurationMs: number | null;
  /// Whether the model cleanup beat its deadline, or the fast pass shipped.
  usedThoroughCleanup: boolean;
  /// Key release → text on screen: the latency a person actually waits through.
  releaseToInsertedMs: number | null;
  /// Key-down → microphone delivering audio. Ours.
  micOpenMs: number | null;
  /// Microphone open → the user starts speaking. Theirs, and not a defect.
  speechOnsetMs: number | null;
  /// Speech starts → the recogniser's first guess. The model's, and the only
  /// part of "time to first word" worth tuning.
  recogniserFirstWordMs: number | null;
}

export interface DictationRecord {
  id: string;
  date: Date;
  /// Straight out of the recogniser, untouched. The accuracy column.
  rawText: string;
  /// What was actually inserted. The formatting column.
  insertedText: string;
  wordCount: number;
  /// The microphone the system was actually using. Without it a run cannot be
  /// audited, and a word-error-rate from an app that never heard the test audio
  /// looks exactly like a real one.
  inputDevice: string | null;
  /// Where the text was inserted. On macOS this is the destination's bundle
  /// identifier ("com.apple.TextEdit"); here it is whatever the window watcher
  /// reports — the executable name on Windows, the window class on X11, the
  /// app id on Wayland. The key keeps its macOS name so a history file written
  /// on either platform reads on the other, and so sync never has to translate.
  ///
  /// Null for a record written before this existed, and for the paths where the
  /// text never landed anywhere.
  ///
  /// Recorded whether or not the app will let Quill read the field back:
  /// knowing where your words went does not depend on being able to re-read
  /// them, and Insights and the Style screen both want it.
  destinationBundleID?: string | null;
  /// What the user changed the text to, after the fact, from the Dictation
  /// screen. Null when they never touched it, which is almost always.
  ///
  /// Kept alongside `insertedText` rather than replacing it. The pair is the
  /// evidence — what Quill produced and what the user actually wanted — and
  /// overwriting the first would throw away the only record of what needed
  /// correcting. It is also what `rawText` / `insertedText` on the Dictation
  /// screen are drawn from, and a diff against an edited version is a diff
  /// against the wrong thing.
  correctedText?: string | null;
  timings: DictationTimings;
}

/// Whether this record is a measurement rather than something a person said.
///
/// The eval rig feeds audio files through a loopback device, and it writes to
/// the same history file the app does. On the original machine that was 684 of
/// 696 records — so Insights was reporting "14,145 words dictated in the last
/// 30 days" and "3h 59m saved against typing it out", every one of them a
/// statistic about a test harness, presented as a fact about a person.
///
/// A dictation is words a person spoke into a microphone. Audio played into a
/// loopback is a measurement, and the two must not be added together on a
/// screen whose only job is to be trusted. The history *log* still lists them —
/// that is a record of what the app did — but nothing that says "you" counts
/// them.
const LOOPBACK_NAMES = [
  'blackhole', 'soundflower', 'loopback', 'aggregate', 'multi-output',
  'monitor of', 'null output', 'virtual audio', 'vb-audio', 'cable output',
  'stereo mix', 'pulse', 'dummy output', 'what u hear',
];

export function isLoopbackDevice(name: string | null | undefined): boolean {
  if (!name) return false;
  const lowered = name.toLowerCase();
  return LOOPBACK_NAMES.some((candidate) => lowered.includes(candidate));
}

export function isMeasurement(record: DictationRecord): boolean {
  return isLoopbackDevice(record.inputDevice);
}

/// Decoded key by key, with a default for anything absent.
///
/// A strict decoder throws on a missing key, and these records are read as one
/// array — so a single field added in a future release makes every record
/// written before it undecodable, `readStoreFile` correctly refuses to
/// overwrite the file, and the user opens Quill after an update to an empty
/// history and a store that has stopped saving. The data is still on disk, which
/// is no comfort to someone looking at a blank screen.
///
/// `rawText` and `insertedText` stay required. They are the record — a history
/// entry without them is not a dictation that lost a field, it is corruption,
/// and quietly inventing an empty one hides that.
function validate(value: unknown): DictationRecord[] | null {
  if (!Array.isArray(value)) return null;
  const out: DictationRecord[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.rawText !== 'string' || typeof raw.insertedText !== 'string') return null;
    // Absent is a default. Present and not a date is damage.
    let date: Date;
    if (raw.date === undefined || raw.date === null) {
      date = new Date();
    } else {
      const parsed = fromISO(raw.date);
      if (!parsed) return null;
      date = parsed;
    }
    const timings = (raw.timings && typeof raw.timings === 'object' ? raw.timings : {}) as Record<string, unknown>;
    const number = (key: string): number | null =>
      (typeof timings[key] === 'number' ? (timings[key] as number) : null);
    const record: DictationRecord = {
      id: typeof raw.id === 'string' ? raw.id : uuid(),
      date,
      rawText: raw.rawText,
      insertedText: raw.insertedText,
      // Derived rather than defaulted to zero, so Insights does not report a
      // month of dictation as no words at all.
      wordCount: typeof raw.wordCount === 'number' ? raw.wordCount : countWords(raw.insertedText),
      inputDevice: typeof raw.inputDevice === 'string' ? raw.inputDevice : null,
      timings: {
        timeToFirstWordMs: number('timeToFirstWordMs'),
        finalToInsertedMs: number('finalToInsertedMs'),
        endToEndMs: number('endToEndMs'),
        audioDurationMs: number('audioDurationMs'),
        usedThoroughCleanup: timings.usedThoroughCleanup === true,
        releaseToInsertedMs: number('releaseToInsertedMs'),
        micOpenMs: number('micOpenMs'),
        speechOnsetMs: number('speechOnsetMs'),
        recogniserFirstWordMs: number('recogniserFirstWordMs'),
      },
    };
    if (typeof raw.destinationBundleID === 'string') record.destinationBundleID = raw.destinationBundleID;
    if (typeof raw.correctedText === 'string') record.correctedText = raw.correctedText;
    out.push(record);
  }
  return out;
}

function encode(records: DictationRecord[]): unknown {
  return records.map((record) => {
    const encoded: Record<string, unknown> = {
      id: record.id,
      date: toISO(record.date),
      rawText: record.rawText,
      insertedText: record.insertedText,
      wordCount: record.wordCount,
      inputDevice: record.inputDevice,
      timings: record.timings,
    };
    // Omitted when absent, as the macOS encoder omits a nil optional, so a
    // record that never had these round-trips byte for byte.
    if (record.destinationBundleID != null) encoded.destinationBundleID = record.destinationBundleID;
    if (record.correctedText != null) encoded.correctedText = record.correctedText;
    return encoded;
  });
}

export function historyURL(): string {
  const override = process.env.QUILL_HISTORY_FILE;
  if (override && override.length > 0) return expandTilde(override);
  return dataFile('history.json');
}

export class HistoryStore {
  private readonly url: string | null;
  private records: DictationRecord[] = [];
  /// Set when the file exists but could not be read. While it is true nothing
  /// is written, because the alternative is writing an empty array over data
  /// that is probably still recoverable.
  private loadFailed = false;
  private readonly cutoff: () => Date | null;
  private expiryTimer: NodeJS.Timeout | null = null;

  private static sharedStore: HistoryStore | null = null;
  static shared(): HistoryStore {
    if (!HistoryStore.sharedStore) HistoryStore.sharedStore = new HistoryStore();
    return HistoryStore.sharedStore;
  }

  /// Tests pass their own URL. A self-test that writes to the real history file
  /// is a bug, not a shortcut.
  ///
  /// `cutoff` answers "delete anything older than this, or null to keep
  /// everything". A function rather than a stored date because the answer moves
  /// with the clock — a store built at launch and still alive at midnight has
  /// to prune to the new day, not the old one.
  constructor(
    url: string | null = historyURL(),
    cutoff: () => Date | null = () =>
      retentionCutoff(QuillSettings.instance().historyRetention, new Date()),
  ) {
    this.url = url;
    this.cutoff = cutoff;
    if (url) {
      const outcome = readStoreFile(url, validate);
      switch (outcome.kind) {
        case 'missing': this.records = []; break;
        case 'decoded': this.records = outcome.value; break;
        case 'unreadable':
          // A file that will not decode is NOT an empty history. It used to be
          // treated as one, and the next dictation atomically wrote an empty
          // array over the top.
          this.records = [];
          this.loadFailed = true;
          break;
      }
    }
    this.prune();
    this.startExpiryTimer();
  }

  /// Re-reads the file after a sync rewrote it underneath this store. Only a
  /// file that decodes replaces what is in memory — a store holds its records in
  /// memory and writes the whole file on the next change, so without this a
  /// running Quill would put its stale copy back over the merge within one
  /// dictation.
  reloadFromDisk(): void {
    if (!this.url) return;
    const outcome = readStoreFile(this.url, validate);
    if (outcome.kind !== 'decoded') return;
    this.records = outcome.value;
    this.prune();
  }

  /// Hourly, because "a month old" becomes true while the app is sitting there
  /// and the record should go that day rather than at the next restart.
  ///
  /// It writes nothing on the hours where nothing expired — which is all of
  /// them but one per record.
  private startExpiryTimer(): void {
    if (!this.url) return;
    this.expiryTimer = setInterval(() => {
      const removed = this.expire();
      if (removed === 0) return;
      this.persist();
      // eslint-disable-next-line no-console
      console.log(`[quill] history: deleted ${removed} expired dictation(s)`);
    }, 3_600_000);
    this.expiryTimer.unref?.();
  }

  dispose(): void {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
  }

  /// Newest first — the rig reads index 0.
  get all(): DictationRecord[] { return [...this.records]; }

  append(record: DictationRecord): void {
    this.records.unshift(record);
    const removed = this.expire();
    this.persist();
    if (removed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[quill] history: deleted ${removed} expired dictation(s)`);
    }
  }

  /// Record what the user meant, from the Dictation screen.
  ///
  /// **This is the learning path that works everywhere.** `EditWatcher` reads
  /// the sentence back out of the app it landed in, which only some apps allow.
  /// Correcting a dictation here costs one click, works for every dictation
  /// whatever app it went to, and Quill owns both sides of the pair so there is
  /// nothing to infer.
  ///
  /// Returns the pair to learn from, or null when nothing changed.
  correct(id: string, text: string): { was: string; now: string } | null {
    if (this.loadFailed) return null;
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) return null;
    const existing = this.records[index]!;
    const previous = existing.correctedText ?? existing.insertedText;
    const cleaned = trim(text);
    if (cleaned.length === 0 || cleaned === previous) return null;
    this.records[index] = { ...existing, correctedText: cleaned };
    this.persist();
    return { was: previous, now: cleaned };
  }

  /// Delete anything past its date. Safe to call as often as you like — it
  /// writes only when it actually removed something.
  prune(): void {
    const removed = this.expire();
    if (removed === 0) return;
    this.persist();
    // eslint-disable-next-line no-console
    console.log(`[quill] history: deleted ${removed} expired dictation(s)`);
  }

  private expire(): number {
    const cutoff = this.cutoff();
    if (!cutoff) return 0;
    const before = this.records.length;
    this.records = this.records.filter((record) => record.date >= cutoff);
    return before - this.records.length;
  }

  private persist(): void {
    // Never overwrite a file we failed to read.
    if (this.loadFailed || !this.url) return;
    writeAtomic(this.url, encodeJSON(encode(this.records)));
  }
}
