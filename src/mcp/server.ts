import { createInterface } from 'node:readline';
import { readAccountIdentity } from '../core/account/sessionStorage';
import { platformNoun } from '../core/account/mcpConnect';
import { dataFile } from '../core/paths';
import { HistoryStore, historyURL } from '../core/stores/history';
import { StyleStore } from '../core/style/styleProfile';
import { voiceMarkdown } from '../core/style/voiceExport';
import { handleLine, type ServerEnvironment } from './protocol';

// The entry point `esbuild` bundles to `dist/mcp/quill-mcp.js`.
//
// Launched by Claude as
//
//     <Quill executable> <path>/quill-mcp.js        (ELECTRON_RUN_AS_NODE=1)
//     node <path>/quill-mcp.js                      (a checkout, no Electron)
//
// and it must never print anything to stdout that is not a JSON-RPC message.
// The transport IS the stream: one stray `console.log` debugging a tool call is
// a corrupted message from Claude's side, not a log line. Diagnostics go to
// stderr, and `console.log` is pointed there below so a dependency cannot
// undo that by accident.

const log = (message: string): void => {
  process.stderr.write(`[quill-mcp] ${message}\n`);
};
console.log = (...args: unknown[]): void => { log(args.map(String).join(' ')); };
console.info = console.log;
console.debug = console.log;

const environment: ServerEnvironment = {
  /// Read from the account file's plain half. The session's tokens may be sealed
  /// by the OS keyring — which this process, a plain Node with no Electron APIs,
  /// cannot open — and it has no use for them: it needs to know whether somebody
  /// is signed in, not to act as them.
  isSignedIn: () => readAccountIdentity(dataFile('account.json')) !== null,

  /// Read-only on purpose. The history store prunes expired records and rewrites
  /// the file when it finds any; handing it a cutoff of "keep everything" means
  /// a server that merely READS the history can never be the thing that
  /// changes it, while the app itself is still the one enforcing retention.
  voiceMarkdown: () => {
    const history = new HistoryStore(historyURL(), () => null);
    try {
      return voiceMarkdown(new StyleStore(dataFile('style.json')).profile, history.all);
    } finally {
      history.dispose();
    }
  },

  machineNoun: platformNoun(process.platform),
  log,
};

log('starting');

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on('line', (line) => {
  for (const out of handleLine(line, environment)) process.stdout.write(`${out}\n`);
});

// Not `process.exit` — letting the event loop drain is what guarantees the last
// response is flushed before the process ends, on a pipe, on Windows.
lines.on('close', () => { log('stdin closed, exiting'); });
