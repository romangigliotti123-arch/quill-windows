import { execFile } from 'node:child_process';
import type { FocusedTextReading } from '../../core/style/editWatcher';

/// Reads the text of the focused field out of another application.
///
/// # What this replaces
///
/// The macOS build asked `AXUIElement` for the focused element's value. Windows
/// has the equivalent in UI Automation, and — unlike the macOS API — nothing in
/// .NET's UI Automation needs a native module: `UIAutomationClient` ships with
/// Windows PowerShell, so one spawned script gives an answer with no compiled
/// dependency to install, sign or break.
///
/// Linux has AT-SPI, which needs a D-Bus client and an accessibility stack the
/// user may not have enabled, and macOS is not a target of this build. Both
/// report "will not say", which `EditWatcher` already treats as ordinary: a
/// watch that cannot read the field simply expires, and nothing is learned
/// rather than something being guessed.
///
/// # What is real and what is best-effort
///
/// The decision logic that uses this (`EditWatcher`, `InsertedSpan`) is fully
/// tested without it. This file is the thin impure edge and the one part of the
/// feature that can only be proved by dictating into a real Windows application
/// and reading the profile afterwards. It has been written against the UI
/// Automation documentation, not run on a Windows machine.
///
/// # Privacy
///
///  * Only the process the dictation went into is ever read. UI Automation's
///    focused element is global to the desktop, so the element's process id is
///    compared against the one Quill typed into, and anything else is refused.
///  * A password field is refused outright (`IsPassword`). Nothing about learning
///    a writing style needs to go near one.
///  * The text is returned to the caller and never written anywhere by this file.

/// One read, bounded. UI Automation against an unresponsive app can block for
/// seconds, and a hung PowerShell must not outlive the watch that asked for it.
const READ_TIMEOUT_MS = 2500;
/// A whole document in a focused field is the point, but there is a ceiling: a
/// 50 MB log in a text box is not a sentence anybody corrected.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/// The PowerShell that reads the focused element. Exit codes are the protocol,
/// so a caller can tell "the app would not say" from "the script is broken":
///
///   0  text on stdout, base64 of its UTF-8 (so no console code page can mangle it)
///   3  no focused element
///   4  the focused element belongs to a different process
///   5  the element exposes no text
///   6  UI Automation threw
///   7  a password field
export function windowsFocusedTextScript(pid: number): string {
  // Interpolated into a script, so it must be a plain integer — never anything a
  // window or a document could influence.
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a process id: ${pid}`);
  return `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $element = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $element) { exit 3 }
  if ($element.Current.ProcessId -ne ${pid}) { exit 4 }
  if ($element.Current.IsPassword) { exit 7 }
  $text = $null
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    $text = $pattern.Current.Value
  }
  if ([string]::IsNullOrEmpty($text)) {
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
      $text = $pattern.DocumentRange.GetText(-1)
    }
  }
  if ([string]::IsNullOrEmpty($text)) { exit 5 }
  [Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text)))
  exit 0
} catch {
  exit 6
}
`;
}

/// PowerShell's `-EncodedCommand` takes UTF-16LE base64, which sidesteps every
/// quoting rule there is.
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/// Reads a stdout payload written by `windowsFocusedTextScript`. Null for
/// anything that is not valid base64 of non-empty text.
export function decodeFocusedText(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) return null;
  const text = Buffer.from(trimmed, 'base64').toString('utf8');
  return text.length > 0 ? text : null;
}

export class WindowsFocusedTextReader implements FocusedTextReading {
  focusedText(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
    const encoded = encodePowerShell(windowsFocusedTextScript(pid));
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: READ_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (error, stdout) => {
          // Any failure, including a non-zero exit code and a timeout, is the
          // ordinary "the app will not say".
          if (error) {
            resolve(null);
            return;
          }
          resolve(decodeFocusedText(stdout));
        },
      );
    });
  }
}

/// The reader for this platform. Where there is no reader the answer is "will not
/// say", which `EditWatcher` handles by reporting `couldNotRead` and stopping.
export class UnavailableFocusedTextReader implements FocusedTextReading {
  focusedText(): Promise<string | null> { return Promise.resolve(null); }
}

export function createFocusedTextReader(
  platform: NodeJS.Platform = process.platform,
): FocusedTextReading {
  return platform === 'win32' ? new WindowsFocusedTextReader() : new UnavailableFocusedTextReader();
}
