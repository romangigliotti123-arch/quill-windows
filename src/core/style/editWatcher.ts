import { InsertedSpan, type Anchors, type VerdictReason } from './insertedSpan';
import type { StyleStore } from './styleProfile';

/// The whole text of whatever field has focus, behind a seam.
///
/// An interface for the same reason `CaretTextReading` was one on macOS: the
/// real implementation asks another process over an accessibility API, so the
/// answer depends on which window happens to be focused on the machine running
/// the test. The real one lives in `src/main/style/focusedTextReader.ts`; this
/// file knows nothing about any operating system and imports no Electron.
export interface FocusedTextReading {
  /// The focused element's full text in process `pid`, or null when the app
  /// will not say.
  ///
  /// Null is ordinary, not exceptional. Measured on the Mac while building the
  /// undo chord: TextEdit answers exactly, Ghostty reports a caret frozen at 0,
  /// Chrome reports an `AXGroup` with no text, and VS Code reports no focused
  /// element at all. Three of the four apps most dictated into cannot be read,
  /// which is the fact that shapes this whole feature — see `EditWatcher`.
  focusedText(pid: number): Promise<string | null> | string | null;
}

/// What the last watch concluded, for the Style screen to show and for tests to
/// assert on.
export type EditWatchOutcome =
  | { kind: 'learned'; from: string; to: string; destination: string | null }
  | { kind: 'keptAsWritten' }
  | { kind: 'couldNotRead'; destination: string | null }
  | { kind: 'ignored'; reason: VerdictReason };

export interface EditWatcherOptions {
  reader: FocusedTextReading;
  store: StyleStore;
  /// `settings.learnFromEdits`, read at the moment a dictation finishes so the
  /// switch in Settings takes effect on the very next one.
  learnFromEdits: () => boolean;
  now?: () => Date;
  /// False in tests, which call `sample()` themselves. A repeating timer
  /// running alongside a test that is also stepping the clock is a race, and
  /// this project has already lost a full test run to one of those.
  usesTimer?: boolean;
  /// The process id that has the keyboard focus right now, or null when the
  /// platform cannot say. Null is read as "assume nothing changed" — the same
  /// convention `WindowWatcher` documents — because on a platform with no
  /// answer the alternative is that the watch never reads anything at all.
  frontmostPID?: () => number | null;
  /// Called when a watch concludes. Replaces the macOS `quillStyleLearned`
  /// notification: the Style screen rebuilds on it, so a correction shows up
  /// without needing the tab reopened.
  onConcluded?: (outcome: EditWatchOutcome) => void;
}

/// Nothing here holds the field's text. Only the anchors, the sentence Quill
/// wrote, and the candidate currently being confirmed.
interface Watch {
  anchors: Anchors;
  pid: number;
  destination: string | null;
  startedAt: Date;
  pending: string | null;
  pendingCount: number;
  /// How far through `SCHEDULE` this watch has got.
  step: number;
}

/// When to look, counted in seconds from the insertion.
///
/// **Backoff, not a fixed interval, and this is the second version.** The first
/// polled every 1.2 seconds for 90 seconds: 75 reads per dictation, each one
/// pulling the entire contents of a focused field across a process boundary,
/// running straight through whatever the user did next — including the next
/// dictation, where the live typer is making its own accessibility calls on
/// every partial to check that focus has not moved. Two subsystems hammering
/// the same target, one of them for a minute and a half after it had any reason
/// to.
///
/// Seven reads catch the same edits. Nobody fixes a typo at second 61 and not
/// at second 48, and the early samples are where corrections actually happen —
/// people reread what just appeared.
export const EDIT_WATCH_SCHEDULE: readonly number[] = [2, 4, 7, 12, 20, 32, 48];

/// An edit has to hold still before it counts.
///
/// Mid-typing states are not corrections. Someone fixing "recieve" passes
/// through "recve", "recei", "receiv" on the way, and every one of those is a
/// perfectly readable field value that says nothing true about how they spell.
/// Two identical consecutive readings — about two and a half seconds of not
/// typing — is the cheapest available definition of "they stopped".
export const EDIT_WATCH_STABLE_SAMPLES = 2;

/// Watches what the user does to the sentence Quill just inserted, and teaches
/// the style profile from the difference.
///
/// # Why this exists
///
/// Every part of learning a writing style was already here — `styleLearner` with
/// eight detectors, `StyleProfile` with tallied traits, the Style screen showing
/// them with their evidence — and `StyleStore.recordCorrection`, the one function
/// that feeds all of it, **had no callers at all**. The profile could only ever
/// show its defaults, and the header counting "corrections seen" could only ever
/// say zero. The learner's own doc comment warns about exactly this shape
/// shipping, which is a good warning to have written and not enough on its own.
///
/// Corrections happen in the app the text landed in, not inside Quill. So this
/// watches there.
///
/// # What it will and will not see
///
/// It reads the focused field over the platform's accessibility API, which many
/// apps decline to answer. **So this learns in some apps and not others, and
/// there is no fixing that from here.** It is built to notice the difference and
/// stay quiet rather than to guess: a watch that cannot read the field simply
/// expires.
///
/// That is also why the destination is recorded on every dictation
/// (`DictationRecord.destinationBundleID`) whether or not the text can be read
/// back — knowing where your words went does not depend on being able to re-read
/// them, and it is the other half of what was asked for.
///
/// # Why the guards are strict
///
/// A wrong correction is worse than a missed one. A missed one costs nothing; a
/// wrong one silently teaches the profile a preference the user never expressed,
/// and that profile is what `VoiceExport` hands to Claude. So every ambiguity is
/// a refusal — see `VerdictReason` for the list, and the stability requirement
/// above for the rest.
///
/// # Differences from the macOS original, all deliberate
///
///  * Every accessibility call is asynchronous here (Windows asks through a
///    spawned PowerShell), so `begin`, `sample` and `flush` are promise-based
///    where the Swift ones were blocking on a private queue. Everything is still
///    serialised on one promise chain, so two samples can never overlap.
///  * `cancel()` also invalidates a watch that `begin` has queued but not yet
///    opened. On macOS a `begin` still waiting on its queue when the next
///    dictation called `cancel` would go on to open a watch for the previous
///    sentence anyway, which is exactly the "two subsystems at one target" the
///    schedule comment above is about.
///  * After the seventh look the watch schedules one final tick that concludes
///    it. The Swift code had the `keptAsWritten` branch and tests that reach it
///    by stepping the clock by hand, but its timer stopped scheduling after the
///    last look, so in real use the commonest outcome was never recorded.
export class EditWatcher {
  static readonly schedule = EDIT_WATCH_SCHEDULE;
  static readonly stableSamples = EDIT_WATCH_STABLE_SAMPLES;

  private readonly reader: FocusedTextReading;
  private readonly store: StyleStore;
  private readonly learnFromEdits: () => boolean;
  private readonly now: () => Date;
  private readonly usesTimer: boolean;
  private readonly onConcluded: ((outcome: EditWatchOutcome) => void) | null;

  /// Behind a seam for the same reason the live typer's focus check is: a test
  /// that asks the operating system answers differently depending on which
  /// window happens to be in front of whoever is running it.
  frontmostPID: () => number | null;

  private watch: Watch | null = null;
  private timer: NodeJS.Timeout | null = null;
  /// Bumped by `cancel()` so a queued `open` can tell it has been overtaken.
  private generation = 0;
  /// Every read this type makes happens on this chain, one at a time, and never
  /// synchronously inside `begin` — the caller is finishing a dictation and has a
  /// waveform to dismiss and a key press to be ready for.
  private tail: Promise<void> = Promise.resolve();
  private outcome: EditWatchOutcome | null = null;

  constructor(options: EditWatcherOptions) {
    this.reader = options.reader;
    this.store = options.store;
    this.learnFromEdits = options.learnFromEdits;
    this.now = options.now ?? (() => new Date());
    this.usesTimer = options.usesTimer ?? true;
    this.frontmostPID = options.frontmostPID ?? (() => null);
    this.onConcluded = options.onConcluded ?? null;
  }

  /// What the last watch concluded. Deliberately not persisted: it is a live
  /// status, and a stale one read back after a relaunch would be a claim about a
  /// session that is over.
  get lastOutcome(): EditWatchOutcome | null { return this.outcome; }

  /// Start watching the sentence Quill just put into process `pid`.
  ///
  /// Called from the one branch of the coordinator where the text is believed to
  /// be on screen — the same gate the undo record uses, because a sentence that
  /// never landed has nothing to watch and a clipboard fallback went somewhere
  /// this cannot see.
  begin(inserted: string, pid: number, destination: string | null): void {
    if (!this.learnFromEdits() || !this.store.profile.isLearningEnabled) return;
    const generation = this.generation;
    // Returns immediately. Everything below happens on the chain.
    void this.enqueue(() => this.open(inserted, pid, destination, generation));
  }

  private async open(
    inserted: string,
    pid: number,
    destination: string | null,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) return;
    const field = await this.reader.focusedText(pid);
    if (generation !== this.generation) return;
    if (field === null) {
      this.finish({ kind: 'couldNotRead', destination });
      return;
    }
    // The field does not contain what we just inserted, or contains it twice.
    // Either way there is nothing here that can be attributed later.
    const anchors = InsertedSpan.anchors(inserted, field);
    if (!anchors) {
      this.finish({ kind: 'ignored', reason: 'notFound' });
      return;
    }
    this.watch = {
      anchors, pid, destination, startedAt: this.now(),
      pending: null, pendingCount: 0, step: 0,
    };
    this.scheduleNext();
  }

  /// Stop watching without concluding anything.
  ///
  /// Called when a new dictation begins: the previous sentence is no longer the
  /// one being edited, and more to the point nothing else should be making
  /// accessibility calls at the same target while the live typer is typing into
  /// it.
  cancel(): void {
    this.generation += 1;
    this.watch = null;
    this.stopTimer();
  }

  private scheduleNext(): void {
    this.stopTimer();
    if (!this.usesTimer) return;
    const watch = this.watch;
    if (!watch) return;
    const schedule = EditWatcher.schedule;
    if (watch.step > schedule.length) return;
    // One tick past the last look, immediately: it reads nothing and exists only
    // to conclude. See the class comment.
    const delaySeconds = watch.step >= schedule.length
      ? 0
      : schedule[watch.step]! - (watch.step === 0 ? 0 : schedule[watch.step - 1]!);
    this.timer = setTimeout(() => { void this.sample(); }, delaySeconds * 1000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /// Waits for the work `begin` dispatched. Tests only: production never needs
  /// to know when the first read finished, which is the whole point of it not
  /// happening on the caller's thread.
  flush(): Promise<void> { return this.tail; }

  /// One look. Exposed so a test can step time rather than wait for it.
  sample(): Promise<void> {
    return this.enqueue(() => this.takeSample());
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.tail.then(job, job);
    // Never let one failed read poison the chain for every dictation after it.
    this.tail = next.catch(() => undefined);
    return this.tail;
  }

  private async takeSample(): Promise<void> {
    const watch = this.watch;
    if (!watch) {
      this.stopTimer();
      return;
    }
    // The values this look started with. `step` is read BEFORE it advances, as
    // in the original, so the look that finds it past the end is the one after
    // the last read.
    const stepBefore = watch.step;
    watch.step += 1;
    try {
      if (stepBefore >= EditWatcher.schedule.length) {
        // Out of looks with nothing conclusive. The commonest real outcome, and
        // not a failure: most dictations are simply left alone.
        this.finish(watch.pending === null
          ? { kind: 'keptAsWritten' }
          : { kind: 'ignored', reason: 'anchorsLost' });
        return;
      }

      // Only while they are looking at it. Someone who has switched away is not
      // editing that sentence right now, and reading the text out of a
      // background app is both wasted work and a thing not to do casually.
      if (!this.isFrontmost(watch.pid)) return;

      const field = await this.reader.focusedText(watch.pid);
      // Cancelled or replaced while the read was in flight.
      if (this.watch !== watch) return;
      if (field === null) {
        // The window closed, focus moved, or the app never answered. Not
        // conclusive either way, so keep looking until the schedule runs out.
        return;
      }

      const verdict = InsertedSpan.verdict(watch.anchors, field);
      switch (verdict.kind) {
        case 'unchanged':
          // Reset any half-confirmed edit: they typed and then put it back.
          watch.pending = null;
          watch.pendingCount = 0;
          return;

        case 'notComparable':
          // `deleted` is conclusive and worth stopping for — the sentence is
          // gone and it is not coming back. The others may recover on the next
          // look, so they wait.
          if (verdict.reason === 'deleted') this.finish({ kind: 'ignored', reason: verdict.reason });
          return;

        case 'corrected':
          if (watch.pending === verdict.text) {
            watch.pendingCount += 1;
            if (watch.pendingCount >= EditWatcher.stableSamples) {
              this.store.recordCorrection(watch.anchors.inserted, verdict.text, this.now());
              this.finish({
                kind: 'learned',
                from: watch.anchors.inserted,
                to: verdict.text,
                destination: watch.destination,
              });
              return;
            }
          } else {
            watch.pending = verdict.text;
            watch.pendingCount = 1;
          }
          return;
      }
    } finally {
      this.scheduleNext();
    }
  }

  private isFrontmost(pid: number): boolean {
    const front = this.frontmostPID();
    return front === null || front === pid;
  }

  private finish(result: EditWatchOutcome): void {
    this.watch = null;
    this.outcome = result;
    this.stopTimer();
    this.onConcluded?.(result);
  }
}
