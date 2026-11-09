/// What crosses the IPC boundary between the Account screen and the main
/// process. Plain data only — no Dates, no classes — so it survives
/// `structuredClone` and reads the same on both sides.

/// Who is signed in. The email and the opaque Firebase uid; never a token.
export interface AccountInfo {
  uid: string;
  email: string;
}

/// One entry of the Devices list. `lastSyncedAt` is epoch milliseconds, or
/// null for a device that registered and has not finished a sync yet.
export interface DeviceWire {
  id: string;
  name: string;
  lastSyncedAt: number | null;
  isThisDevice: boolean;
}

/// The answer to every action the Account screen can take.
///
/// A result rather than a rejected promise because an IPC rejection arrives in
/// the renderer as "Error invoking remote method…" wrapped around the real
/// message, and the real message ("That email and password don't match an
/// account.") is the one thing a person should see.
export type AccountActionResult =
  | { ok: true; account: AccountInfo | null }
  | { ok: false; message: string };

/// Where the MCP server is on THIS machine, and how to launch it. Resolved in
/// the main process, which is the only thing that knows where the running app
/// really is.
export interface MCPLaunch {
  /// The program to run: the Electron/Quill executable, or `node`.
  command: string;
  /// Its arguments — the path of the bundled server script.
  args: string[];
  /// Environment the server needs. Always `ELECTRON_RUN_AS_NODE=1` when the
  /// command is an Electron binary; also `QUILL_DATA_DIR` when this running
  /// copy of Quill was pointed somewhere other than the default.
  env: Record<string, string>;
  /// The script itself, for display and for the "does it exist" check.
  script: string;
  scriptExists: boolean;
}
