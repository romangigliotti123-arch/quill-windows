/// "Finish, then Enter": release the dictation key, tap it again right away,
/// and Quill sends Return — but only once cleanup and insertion have actually
/// finished, never the instant the tap happens.
///
/// A tap this soon after releasing the key already lands in the coordinator as
/// an aborted gesture — too short to become a new dictation on its own — which
/// is what makes it safe to read as "send it" without watching a second key:
/// nothing else in normal use means anything by a tap this quick, right after
/// one just ended.
///
/// Pulled out of the coordinator as a pure class with an injected clock and an
/// injected Return, for the same reason the coordinator takes `context` as an
/// option: a test that actually posted a real Return to whatever app the test
/// machine happens to have focused would be a bug pretending to be a feature.

/// How long after text lands a tap still counts as "right after". A tap
/// arriving later is not right after anything any more and is left alone.
export const FINISH_THEN_ENTER_WINDOW_MS = 1200;

export class FinishThenEnter {
  /// Armed by a quick tap that lands while a dictation is still finalising, or
  /// shortly after one just landed; cleared the moment Return actually gets
  /// sent.
  private pending = false;
  /// When the last dictation's text actually landed — not when the key was
  /// released.
  private lastInsertionAt: number | null = null;

  constructor(
    private readonly enabled: () => boolean,
    private readonly sendReturn: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /// Whether a Return is waiting for the text to land. For tests and the
  /// dashboard; nothing else should branch on it.
  get armed(): boolean { return this.pending; }

  /// A quick tap that never became a dictation (`hotkeyAborted`).
  tap(isFinalising: boolean): void {
    if (!this.enabled()) return;
    const recentlyLanded = this.lastInsertionAt !== null
      && this.now() - this.lastInsertionAt < FINISH_THEN_ENTER_WINDOW_MS;
    if (!isFinalising && !recentlyLanded) return;
    this.pending = true;
    // The text already landed before this tap arrived — nothing left to wait
    // for.
    if (!isFinalising) this.fireIfPending();
  }

  /// The text is on screen now: the moment this feature exists to wait for.
  /// Fires the deferred Return if a tap already asked for one; otherwise just
  /// records when.
  noteInsertion(): void {
    this.lastInsertionAt = this.now();
    this.fireIfPending();
  }

  /// Also called when a finalise ends, not only from `noteInsertion`: a tap
  /// that lands between insertion actually happening and the finalise task
  /// actually exiting arms `pending` with the coordinator still finalising, the
  /// insertion that would otherwise fire it has already run and will not run
  /// again, and without this that tap is armed forever and nothing ever sends
  /// it.
  fireIfPending(): void {
    if (!this.pending) return;
    this.pending = false;
    this.sendReturn();
  }
}
