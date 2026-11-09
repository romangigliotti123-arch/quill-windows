import { safeStorage } from 'electron';
import type { Sealer } from '../../core/account/sessionStorage';

/// Electron's `safeStorage` as a `Sealer`: DPAPI on Windows, the Keychain on
/// macOS, libsecret / kwallet on Linux. It seals the two session tokens so that
/// another program running as a different user, or a copy of the data folder
/// taken to another machine, cannot use them.
///
/// It is NOT protection against malware running as the same user — DPAPI will
/// open the blob for anything in the user's session — and the README does not
/// pretend it is. What it adds over the plain-file fallback is that a backup, a
/// synced folder or a misconfigured share does not leak a working login.
///
/// Only touched after the app is ready (the first session read happens when the
/// Account screen or the sync engine first asks), because `safeStorage` is
/// unavailable before that.
export const safeStorageSealer: Sealer = {
  isAvailable(): boolean {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      // On Linux without a keyring Chromium falls back to a hard-coded key and
      // still answers "available". That is obfuscation, not sealing — and
      // choosing it would also hide the tokens from nothing while making the
      // file unreadable when the same data directory is opened on a machine that
      // does have a keyring. Treat it as unavailable.
      if (process.platform === 'linux') {
        const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string })
          .getSelectedStorageBackend?.();
        if (backend === 'basic_text' || backend === 'unknown') return false;
      }
      return true;
    } catch {
      return false;
    }
  },

  seal(plain: string): string {
    return safeStorage.encryptString(plain).toString('base64');
  },

  open(sealed: string): string | null {
    try {
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'));
    } catch {
      return null;
    }
  },
};
