import { hostname } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataFile } from '../paths';
import { uuid } from '../stores/storeFile';

/// A stable name for "this computer" on the Devices list on the Account screen
/// — not a hardware identifier, just enough to tell two machines apart once the
/// same account is signed into both.

export function deviceFile(): string {
  return dataFile('device.json');
}

const cache = new Map<string, string>();

/// A Firestore field-path-safe key. The REST API's unquoted field path syntax
/// must start with a letter or underscore, and a bare UUID (which can start
/// with a digit) would need backtick-quoting every place `SyncEngine` reads or
/// writes it — the "d" prefix sidesteps that everywhere, for free.
export function deviceID(path: string = deviceFile()): string {
  const cached = cache.get(path);
  if (cached) return cached;

  let id: string | null = null;
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown };
    if (typeof stored.id === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(stored.id)) id = stored.id;
  } catch {
    /* no file yet, or one that will not parse — a fresh id is correct for both */
  }
  if (id === null) {
    id = `d${uuid().replaceAll('-', '').toLowerCase()}`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ id })}\n`, 'utf8');
    } catch {
      /* the id still works for this run; it just will not be the same next time */
    }
  }
  cache.set(path, id);
  return id;
}

/// Hostnames end in ".local" on a Mac on a home network — trimmed because
/// nobody reading a device list needs to be told that. Windows has no such
/// suffix and the same call is harmless there.
export function deviceName(platform: NodeJS.Platform = process.platform): string {
  let host = hostname();
  if (host.endsWith('.local')) host = host.slice(0, -'.local'.length);
  if (host.length > 0) return host;
  switch (platform) {
    case 'win32': return 'This PC';
    case 'darwin': return 'This Mac';
    default: return 'This computer';
  }
}

/// What the Account screen calls the machine it is running on — "this PC",
/// "this Mac" — for the "(this …)" marker on the Devices list.
export function thisDeviceNoun(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'win32': return 'this PC';
    case 'darwin': return 'this Mac';
    default: return 'this computer';
  }
}

/// For tests, which share one process and must not share one device id.
export function forgetDeviceIDCache(): void {
  cache.clear();
}
