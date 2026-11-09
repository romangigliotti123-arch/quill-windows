import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { nimKeyFile } from '../../core/ai/nimClient';
import { AccountError, AccountStore } from '../../core/account/accountStore';
import { deviceID, deviceName } from '../../core/account/deviceIdentity';
import { FIREBASE_CONFIG } from '../../core/account/firebaseConfig';
import { FileSessionStorage, type Sealer } from '../../core/account/sessionStorage';
import { SyncEngine, type SyncField, type SyncPaths } from '../../core/account/syncEngine';
import type {
  AccountActionResult, AccountInfo, DeviceWire, MCPLaunch,
} from '../../core/account/types';
import { dataFile } from '../../core/paths';
import { historyURL } from '../../core/stores/history';
import { vocabularyURL } from '../../core/stores/vocabulary';

/// The account, the sync engine and the MCP launch details, assembled for the
/// main process — and the IPC handlers that expose them to the dashboard.
///
/// Nothing here runs at launch beyond constructing three objects. No request is
/// made until somebody signs in, so the person who never opens Account never
/// causes a byte to leave the machine on this feature's behalf.

export function accountFile(): string {
  return dataFile('account.json');
}

/// Where the six synced files live. Read from the same helpers the stores use,
/// so `QUILL_HISTORY_FILE` and friends move sync along with the store.
export function defaultSyncPaths(): SyncPaths {
  return {
    history: historyURL(),
    vocabulary: vocabularyURL(),
    snippets: dataFile('snippets.json'),
    transforms: dataFile('transforms.json'),
    style: dataFile('style.json'),
    aiKey: nimKeyFile(),
  };
}

export interface AccountServiceOptions {
  /// `safeStorageSealer` in the app; omitted in tests and anywhere Electron's
  /// APIs do not exist, which gives the plain 0600 file.
  sealer?: Sealer | null;
  fetch?: typeof fetch;
  sessionFile?: string;
  paths?: SyncPaths;
  /// Called when a sync rewrote one of the six files — the host reloads the
  /// matching in-memory store. See `SyncEngineOptions.onMerged`.
  onMerged?: (field: SyncField) => void;
}

export class AccountService {
  readonly account: AccountStore;
  readonly sync: SyncEngine;
  private readonly listeners = new Set<(account: AccountInfo | null) => void>();

  constructor(options: AccountServiceOptions = {}) {
    this.account = new AccountStore({
      storage: new FileSessionStorage(options.sessionFile ?? accountFile(), options.sealer ?? null),
      config: FIREBASE_CONFIG,
      fetch: options.fetch,
    });
    this.sync = new SyncEngine({
      account: this.account,
      paths: options.paths ?? defaultSyncPaths(),
      config: FIREBASE_CONFIG,
      fetch: options.fetch,
      device: { id: () => deviceID(), name: () => deviceName() },
      onMerged: options.onMerged,
    });
  }

  /// Starts watching the account. Safe to call at launch: it makes no request
  /// unless a session already exists on disk, in which case it syncs — which is
  /// the point of staying signed in.
  start(): void {
    this.account.observe((account) => {
      for (const listener of this.listeners) listener(account);
    });
    this.sync.start();
  }

  stop(): void {
    this.sync.stop();
  }

  /// For the host to forward sign-in and sign-out to open windows, and to gate
  /// anything that depends on being signed in (the sidebar's MCP lock, say).
  onChange(listener: (account: AccountInfo | null) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // MARK: - IPC

  /// The handlers the dashboard calls. Names are the `quill:invoke` names, so
  /// wiring is one `if (name in accountHandlers) return accountHandlers[name](payload)`
  /// ahead of the existing switch.
  readonly handlers: Record<string, (payload: unknown) => Promise<unknown> | unknown> = {
    'account.get': (): AccountInfo | null => this.account.current,

    'account.signIn': (payload) => this.act(async () => {
      const { email, password } = credentials(payload);
      await this.account.signIn(email, password);
    }),

    'account.signUp': (payload) => this.act(async () => {
      const { email, password } = credentials(payload);
      await this.account.signUp(email, password);
    }),

    'account.signOut': () => this.act(async () => {
      // The one thing worth doing on the way out: push whatever changed since
      // the last two-minute tick, so signing out on this machine does not strand
      // the last few dictations. Bounded, because a person who is signing out
      // because the network is down must not be made to wait on it.
      await Promise.race([
        this.sync.syncNow(),
        new Promise<void>((resolve) => { setTimeout(resolve, 5_000).unref?.(); }),
      ]);
      this.account.signOut();
    }),

    'account.changePassword': (payload) => this.act(async () => {
      const value = payload as { currentPassword?: unknown; newPassword?: unknown } | undefined;
      if (typeof value?.currentPassword !== 'string' || typeof value.newPassword !== 'string') {
        throw new AccountError('server', 'Enter your current and new password.');
      }
      await this.account.changePassword(value.currentPassword, value.newPassword);
    }),

    'account.devices': async (): Promise<DeviceWire[]> => {
      const devices = await this.sync.fetchDevices();
      return devices.map((device) => ({
        id: device.id,
        name: device.name,
        lastSyncedAt: device.lastSyncedAt ? device.lastSyncedAt.getTime() : null,
        isThisDevice: device.isThisDevice,
      }));
    },

    'mcp.launch': (): MCPLaunch => mcpLaunch(),
  };

  /// Runs an action and answers with a result rather than a rejection — see
  /// `AccountActionResult`.
  private async act(action: () => Promise<void>): Promise<AccountActionResult> {
    try {
      await action();
      return { ok: true, account: this.account.current };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof AccountError || error instanceof Error
          ? error.message
          : 'Something went wrong — try again.',
      };
    }
  }
}

function credentials(payload: unknown): { email: string; password: string } {
  const value = payload as { email?: unknown; password?: unknown } | undefined;
  if (typeof value?.email !== 'string' || typeof value.password !== 'string') {
    throw new AccountError('server', 'Enter an email and a password.');
  }
  return { email: value.email.trim(), password: value.password };
}

// MARK: - The MCP server's whereabouts

/// Where the bundled server script is, and how to run it, on THIS machine.
///
/// Read off the running app rather than assumed — Quill runs fine from
/// anywhere, and a config file pointing at a path that does not exist fails as a
/// Claude that simply has no Quill tools, with no error naming the reason.
///
/// The script is one file the build step writes beside the main bundle
/// (`dist/mcp/quill-mcp.js`). It runs under whatever launched this process:
/// Quill's own executable with `ELECTRON_RUN_AS_NODE=1` — which makes an
/// Electron binary behave as a plain Node — so nothing has to be installed for
/// it to work. Under plain Node (tests) it is just `node`.
///
/// In a packaged app the script sits inside `app.asar`. Node-mode Electron can
/// read an asar, but the script is also unpacked beside it by `asarUnpack` and
/// that copy is preferred: a path with no archive in it works from every
/// launcher, including ones that do not know what an asar is.
export function mcpLaunch(mainBundleDirectory: string = __dirname): MCPLaunch {
  const inArchive = join(mainBundleDirectory, '..', 'mcp', 'quill-mcp.js');
  const unpacked = inArchive.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  const script = unpacked !== inArchive && existsSync(unpacked) ? unpacked : inArchive;

  const env: Record<string, string> = {};
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  // A copy of Quill pointed somewhere other than the default data folder (a
  // test rig, a portable install) has its account and history there; a server
  // launched without the same variable would look in the default place and
  // report "signed out" with nothing wrong anywhere.
  if (process.env.QUILL_DATA_DIR) env.QUILL_DATA_DIR = process.env.QUILL_DATA_DIR;

  return { command: process.execPath, args: [script], env, script, scriptExists: existsSync(script) };
}
