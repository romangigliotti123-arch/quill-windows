import { BrowserWindow, ipcMain, screen, type Rectangle } from 'electron';
import { join } from 'node:path';
import { NOTE_BUBBLE, bubbleOrigin } from '../../core/overlayBar';
import { makeNote, type NoteStore } from '../../core/stores/notes';

/// Dictating a note straight from the bar, with no window involved.
///
/// Click "Note": a small bubble opens right above the bar with a blank line
/// already listening, and dictation starts the same instant — through the exact
/// same coordinator the held key and the bar's own dictate button use, so it is
/// genuinely a normal dictation and not a second, parallel implementation of
/// one. The only thing that differs from dictating into any other app is which
/// window is focused when it starts: this bubble's, so the words land here
/// instead of wherever the cursor happened to be. Click the bar again to stop,
/// exactly like any other dictation; the bubble holds what landed for a moment,
/// then it is saved as a new Note and the bubble closes.
///
/// The one window of Quill's that takes keyboard focus. Every other one refuses
/// it, because normal dictation always lands in whatever app you were already
/// in; a quick note is the one case where the destination is Quill itself.

/// Long enough to read the last couple of words that just landed — the same
/// lingering the HUD's "inserted" state sits for elsewhere in the app.
const LINGER_MS = 900;

export class QuickNoteBubble {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private activeNoteId: string | null = null;
  private text = '';

  constructor(private readonly store: NoteStore) {
    ipcMain.on('bubble:text', (_event, text: unknown) => {
      this.text = typeof text === 'string' ? text : '';
    });
  }

  /// So a second click on "Note" while one is already open is a no-op rather
  /// than a second note started mid-dictation.
  get isCapturing(): boolean { return this.activeNoteId !== null; }

  /// `pill` is the persistent bar's pill rectangle, so the bubble sits above
  /// that and not above the 32px of transparent margin around it. Nothing
  /// happens if it is null, which only occurs when the bar has never been shown.
  async begin(pill: Rectangle | null, startDictation: () => void): Promise<void> {
    if (this.isCapturing || !pill) return;
    const created = this.store.upsert(makeNote());
    this.activeNoteId = created.id;
    this.text = '';

    const window = await this.ensureWindow();
    if (window.isDestroyed()) return;
    const display = screen.getDisplayNearestPoint({ x: pill.x, y: pill.y });
    const origin = bubbleOrigin(pill, display.workArea);
    window.setBounds({ x: origin.x, y: origin.y, width: NOTE_BUBBLE.width, height: NOTE_BUBBLE.height });
    window.webContents.send('bubble:reset');
    window.show();
    window.focus();
    window.webContents.focus();
    // Focus first, then start: the words must land here, so this window has to
    // be the focused one at the instant dictation begins.
    setTimeout(startDictation, 120);
  }

  /// Fires on every dictation's end, not just this one's — the guard on
  /// `activeNoteId` is what makes an unrelated dictation elsewhere a no-op here
  /// rather than reading this bubble's text at the wrong moment.
  finish(): void {
    const id = this.activeNoteId;
    if (id === null) return;
    this.activeNoteId = null;
    const text = this.text.trim();
    if (text.length === 0) {
      // Escape, or a tap that never became a real dictation — nothing was said,
      // so the note created up front is discarded rather than left behind blank.
      this.store.remove(id);
      this.dismiss();
      return;
    }
    const existing = this.store.note(id) ?? makeNote({ id });
    this.store.upsert({ ...existing, body: text });
    setTimeout(() => this.dismiss(), LINGER_MS);
  }

  private dismiss(): void {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      if (this.ready) await this.ready;
      return this.window;
    }
    const window = new BrowserWindow({
      width: NOTE_BUBBLE.width,
      height: NOTE_BUBBLE.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      // Focusable, unlike every other overlay window: see the header.
      focusable: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'bubble.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window = window;
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setMenuBarVisibility(false);
    this.ready = window.loadFile(join(__dirname, '..', 'renderer', 'bubble.html'));
    await this.ready;
    return window;
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
