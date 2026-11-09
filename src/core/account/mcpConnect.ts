import type { MCPLaunch } from './types';

/// The text a person pastes to connect Quill's MCP server to Claude — built
/// from where the server REALLY is on this machine, never from a guess.
///
/// Pure and free of Node and Electron imports on purpose: the Account screen's
/// renderer and the main process both call it, and a test can run it for any
/// platform without being on one.

/// A path in double quotes, which is what both `cmd` and PowerShell (and every
/// POSIX shell) agree on for an argument with a space in it.
export function quoteArg(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function platformNoun(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32': return 'PC';
    case 'darwin': return 'Mac';
    default: return 'computer';
  }
}

/// Where Claude Desktop keeps the file the snippet below belongs in.
export function claudeDesktopConfigPath(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32': return '%APPDATA%\\Claude\\claude_desktop_config.json';
    case 'darwin': return '~/Library/Application Support/Claude/claude_desktop_config.json';
    default: return '~/.config/Claude/claude_desktop_config.json';
  }
}

function serverObject(launch: MCPLaunch): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: launch.command, args: launch.args };
  if (Object.keys(launch.env).length > 0) entry.env = launch.env;
  return entry;
}

/// The config snippet a person merges into their own `claude_desktop_config.json`,
/// under whatever `mcpServers` already holds — not the whole file, because
/// overwriting it would drop every other server they already have configured.
///
/// Built with `JSON.stringify` rather than a template string. On Windows every
/// path is full of backslashes, and a snippet that says `"C:\Users\…"` is not
/// JSON: Claude Desktop would refuse the whole file, and with it every other
/// server the person has set up.
export function mcpConfigSnippet(launch: MCPLaunch): string {
  return `"quill": ${JSON.stringify(serverObject(launch), null, 2)}`;
}

/// The one-line way in for Claude Code. `-e` carries the environment the server
/// needs; everything after `--` is the command Claude Code will run.
export function claudeCodeCommand(launch: MCPLaunch): string {
  const env = Object.entries(launch.env).map(([key, value]) => `-e ${key}=${value}`);
  const command = [quoteArg(launch.command), ...launch.args.map(quoteArg)].join(' ');
  return ['claude mcp add quill', ...env, '--', command].join(' ');
}

/// The other way in: hand Claude the job instead of editing JSON by hand.
///
/// Editing `claude_desktop_config.json` correctly means knowing where it is,
/// that it may not exist yet, and that `mcpServers` is a dictionary to merge
/// into rather than replace — which is three chances to lose every other server
/// you had configured. A Claude with a terminal does it in one paste and can
/// prove it worked afterwards.
///
/// Everything it needs is in the text: the real resolved path, the config
/// location, the tool's name, what to check, and the one failure that is not a
/// setup problem at all. A prompt that assumes the reader already knows the app
/// is a prompt that only works for someone who did not need it — see the same
/// rule on every other copy-for-AI button in Quill.
///
/// Written as one physical line per paragraph, deliberately: a pretty-wrapped
/// template string leaves the continued lines' indentation sitting in the
/// middle of sentences, invisible in the source and obvious the moment you
/// paste it.
export function mcpClaudePrompt(launch: MCPLaunch, platform: NodeJS.Platform): string {
  const noun = platformNoun(platform);
  const envNote = launch.env.ELECTRON_RUN_AS_NODE
    ? ' The server is a script run by Quill\'s own program acting as a plain Node.js runtime, which is what the ELECTRON_RUN_AS_NODE variable does — it is required, and nothing else needs to be installed.'
    : '';
  const dataNote = launch.env.QUILL_DATA_DIR
    ? ` This copy of Quill keeps its data in ${launch.env.QUILL_DATA_DIR}, so the server is launched with QUILL_DATA_DIR set to match; keep that variable.`
    : '';
  const storeNote = platform === 'win32'
    ? ' If Claude Desktop was installed from the Microsoft Store, Windows may keep that file under %LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude\\ instead; use whichever one exists.'
    : '';
  const lines = [
    'Set up Quill\'s MCP server for me so Claude can write in my voice.',
    '',
    `Quill is a dictation app. It ships a local MCP server inside its own app folder, on this ${noun} at:`,
    '',
    `  ${launch.script}`,
    '',
    `It speaks MCP over stdio and exposes one tool, \`get_writing_voice\`, which returns a markdown document describing how I write, built from my own dictations. It takes no arguments, needs no API key, and makes no network requests.${envNote}${dataNote}`,
    '',
    'To launch it, run this program with that script as its argument:',
    '',
    `  ${launch.command}`,
    '',
    'Please connect it wherever I would use it — skip either one I don\'t have installed:',
    '',
    '1. Claude Code:',
    '',
    `     ${claudeCodeCommand(launch)}`,
    '',
    `2. Claude Desktop — merge this into the "mcpServers" object in ${claudeDesktopConfigPath(platform)}`,
    '',
    ...mcpConfigSnippet(launch).split('\n').map((line) => `     ${line}`),
    '',
    `   Create that file if it isn't there. If it is, keep every server already in it — merge, don't overwrite. Claude Desktop only picks the change up after it is quit and reopened (fully, from the tray, not just the window), so tell me to do that.${storeNote}`,
    '',
    'Then prove it works: call `get_writing_voice` and show me the first few lines of what comes back.',
    '',
    'Two answers that are not setup problems, so don\'t try to fix either by editing config:',
    '',
    '- If the tool says Quill isn\'t signed in, tell me. I need to open Quill, go to Account and sign in — that is what tells it whose voice to hand over.',
    `- If that path doesn't exist, Quill has been moved, updated or uninstalled. Find where Quill is installed and use the quill-mcp.js script inside its app folder (it is under resources, in dist/mcp).`,
  ];
  return lines.join('\n');
}
