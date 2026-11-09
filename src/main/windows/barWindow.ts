import { BrowserWindow, ipcMain, screen, type Rectangle } from 'electron';
import { join } from 'node:path';
import type { QuillSettings } from '../../core/settings';
import { BAR_METRICS, anchorFor, barOrigin } from '../../core/overlayBar';

/// The always-on button at the edge of the screen — the persistent bar. A
/// second, independent window from the HUD: that one is the rich listening
/// display and appears only during a dictation, however it was started; this
/// one is present whenever `overlayBarEnabled` is on, and is what lets someone
/// start a dictation with a click instead of holding a key at all.
///
/// Two windows rather than one with two jobs. The HUD ignores mouse events on
/// purpose — nothing but Escape can dismiss it, so a dictation never loses
/// focus to it. This one has to catch clicks, which is exactly the property the
/// other cannot have. It never takes keyboard focus either: `focusable: false`
/// on Windows is `WS_EX_NOACTIVATE`, so a click on the bar does not move the
/// caret out of the app being dictated into.

export interface BarOptions {
  settings: QuillSettings;
  /// Fired on a click on the first segment. The caller decides press vs release
  /// from the coordinator's own state — the one place that truth lives — rather
  /// than this window keeping a guess that could drift out of sync with a
  /// dictation started by the key.
  onToggle: () => void;
  /// Fired from the second segment, shown only when
  /// `overlayShowsNewNoteButton` is on.
  onNewNote: () => void;
}

export class PersistentBar {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private active = false;

  constructor(private readonly options: BarOptions) {
    ipcMain.on('bar:toggle', () => this.options.onToggle());
    ipcMain.on('bar:newNote', () => this.options.onNewNote());
    options.settings.on('changed', () => { void this.apply(); });
    // A display unplugged or a taskbar moved: the bar is docked to a work-area
    // edge that no longer exists.
    const reposition = (): void => {
      if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
        this.place(this.window);
      }
    };
    screen.on('display-metrics-changed', reposition);
    screen.on('display-added', reposition);
    screen.on('display-removed', reposition);
  }

  /// Where the bar is on screen right now, for anything that needs to put
  /// itself relative to it — the quick-note bubble. Null only if it has never
  /// been shown.
  get bounds(): Rectangle | null {
    return this.window && !this.window.isDestroyed() ? this.window.getBounds() : null;
  }

  /// The pill's own rectangle within the panel, which is what the bubble should
  /// sit above — not the 32px of transparent margin around it.
  get pillBounds(): Rectangle | null {
    const panel = this.bounds;
    if (!panel) return null;
    const { height, panelHeight } = BAR_METRICS;
    return {
      x: panel.x + 16,
      y: panel.y + (panelHeight - height) / 2,
      width: panel.width - 32,
      height,
    };
  }

  setActive(active: boolean): void {
    this.active = active;
    this.send('bar:active', active);
  }

  /// Shows or hides the bar to match settings. Idempotent: called on launch and
  /// on every settings change.
  async apply(): Promise<void> {
    const { settings } = this.options;
    if (!settings.overlayBarEnabled) {
      this.window?.hide();
      return;
    }
    const window = await this.ensureWindow();
    if (window.isDestroyed()) return;
    this.send('bar:config', {
      anchor: anchorFor(settings.overlayBarPosition),
      showsNewNote: settings.overlayShowsNewNoteButton,
    });
    this.send('bar:active', this.active);
    this.place(window);
    if (!window.isVisible()) window.showInactive();
    // Re-asserted, because a workspace switch or a full-screen app can demote a
    // window already at this level.
    window.setAlwaysOnTop(true, 'screen-saver');
  }

  private place(window: BrowserWindow): void {
    // The display under the pointer, matching the HUD: the primary display
    // follows the focused window, and this app deliberately never has one.
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const origin = barOrigin(display.workArea, this.options.settings.overlayBarPosition);
    window.setBounds({
      x: origin.x, y: origin.y, width: BAR_METRICS.panelWidth, height: BAR_METRICS.panelHeight,
    });
  }

  private send(channel: string, payload: unknown): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, payload);
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      if (this.ready) await this.ready;
      return this.window;
    }
    const window = new BrowserWindow({
      width: BAR_METRICS.panelWidth,
      height: BAR_METRICS.panelHeight,
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
      // The one property that matters most here: clicking must not activate
      // Quill, or the caret moves out of the app being dictated into.
      focusable: false,
      type: process.platform === 'darwin' ? 'panel' : undefined,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'bar.js'),
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
    this.ready = window.loadFile(join(__dirname, '..', 'renderer', 'bar.html'));
    await this.ready;
    return window;
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
