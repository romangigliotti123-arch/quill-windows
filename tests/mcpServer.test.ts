import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROTOCOL_VERSION, TOOLS, WRITING_VOICE_TOOL, callTool, handleLine, rpcID, type ServerEnvironment,
} from '../src/mcp/protocol';
import {
  claudeCodeCommand, claudeDesktopConfigPath, mcpClaudePrompt, mcpConfigSnippet, platformNoun,
} from '../src/core/account/mcpConnect';
import type { MCPLaunch } from '../src/core/account/types';
import { mcpLaunch } from '../src/main/account/accountService';

// The MCP server is a function from a line of input to the lines of output, so
// the whole protocol is proven here without a process, a pipe or a Claude. The
// process itself is smoke-tested separately by piping real requests into the
// bundled `dist/mcp/quill-mcp.js`.

function environment(options: { signedIn?: boolean; voice?: string; noun?: string } = {}): {
  env: ServerEnvironment; logged: string[];
} {
  const logged: string[] = [];
  return {
    logged,
    env: {
      isSignedIn: () => options.signedIn ?? true,
      voiceMarkdown: () => options.voice ?? '# How this person writes\n\nthey write short sentences.',
      machineNoun: options.noun ?? 'PC',
      log: (message) => logged.push(message),
    },
  };
}

const send = (env: ServerEnvironment, request: unknown): any[] =>
  handleLine(JSON.stringify(request), env).map((line) => JSON.parse(line));

// MARK: - Wire format

test('initialize answers with the protocol version, the tools capability and the server name', () => {
  const { env } = environment();
  const [reply] = send(env, { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
  assert.equal(reply.jsonrpc, '2.0');
  assert.equal(reply.id, 0);
  assert.equal(reply.result.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(reply.result.capabilities, { tools: {} });
  assert.equal(reply.result.serverInfo.name, 'quill');
});

test('whatever id the client sent is echoed back exactly', () => {
  const { env } = environment();
  assert.equal(send(env, { id: 7, method: 'ping' })[0].id, 7);
  assert.equal(send(env, { id: 'abc-1', method: 'ping' })[0].id, 'abc-1');
  assert.equal(send(env, { id: null, method: 'ping' })[0].id, null);
  assert.deepEqual(rpcID(undefined), { kind: 'none' });
  assert.deepEqual(rpcID({}), { kind: 'null' });
});

test('a notification gets no reply, ever', () => {
  const { env } = environment();
  assert.deepEqual(send(env, { method: 'notifications/initialized' }), []);
  assert.deepEqual(send(env, { method: 'notifications/cancelled', params: { requestId: 1 } }), []);
  // Even an error is not sent to something that did not ask a question.
  assert.deepEqual(send(env, { method: 'no/such/method' }), []);
  assert.deepEqual(send(env, { method: 'tools/call', params: {} }), []);
});

test('an unknown method with an id is a JSON-RPC "method not found"', () => {
  const { env } = environment();
  const [reply] = send(env, { id: 3, method: 'resources/list' });
  assert.equal(reply.error.code, -32601);
  assert.equal(reply.error.message, 'Method not found: resources/list');
  assert.equal(reply.result, undefined);
});

test('ping answers an empty result', () => {
  const { env } = environment();
  assert.deepEqual(send(env, { id: 1, method: 'ping' })[0].result, {});
});

test('lines that are not requests are ignored and logged, never answered', () => {
  const { env, logged } = environment();
  assert.deepEqual(handleLine('', env), []);
  assert.deepEqual(handleLine('   ', env), []);
  assert.deepEqual(handleLine('not json at all', env), []);
  assert.deepEqual(handleLine('[1,2,3]', env), []);
  assert.deepEqual(handleLine('{"id":1}', env), [], 'no method, no request');
  // Blank lines are silently skipped; the three malformed ones are logged.
  assert.equal(logged.length, 3);
  assert.match(logged[0]!, /unparseable line, ignored/);
});

test('every reply is exactly one line — a newline inside one would corrupt the stream', () => {
  const { env } = environment({ voice: 'line one\nline two\n\nline four' });
  const lines = handleLine(JSON.stringify({ id: 1, method: 'tools/call', params: { name: WRITING_VOICE_TOOL } }), env);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes('\n'));
  assert.equal(JSON.parse(lines[0]!).result.content[0].text, 'line one\nline two\n\nline four');
});

// MARK: - Tools

test('there is one tool, it takes no arguments, and it says when to use it', () => {
  const { env } = environment();
  const [reply] = send(env, { id: 2, method: 'tools/list' });
  assert.equal(reply.result.tools.length, 1);
  const tool = reply.result.tools[0];
  assert.equal(tool.name, 'get_writing_voice');
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /AS this person/);
  assert.equal(TOOLS.length, 1);
});

test('signed in, the tool hands over the writing voice', () => {
  const { env } = environment({ signedIn: true });
  const [reply] = send(env, { id: 4, method: 'tools/call', params: { name: 'get_writing_voice', arguments: {} } });
  assert.equal(reply.result.isError, false);
  assert.equal(reply.result.content[0].type, 'text');
  assert.match(reply.result.content[0].text, /^# How this person writes/);
});

test('signed out is an answer Claude can relay, not a protocol failure', () => {
  const { env } = environment({ signedIn: false, noun: 'PC' });
  const [reply] = send(env, { id: 5, method: 'tools/call', params: { name: 'get_writing_voice' } });
  assert.equal(reply.error, undefined, 'a JSON-RPC error would hide the instruction from the model');
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /not signed into an account on this PC/);
  assert.match(reply.result.content[0].text, /go to Account, and sign in/);
});

test('the voice is not built for a caller who cannot receive it', () => {
  let built = 0;
  const env: ServerEnvironment = {
    isSignedIn: () => false, voiceMarkdown: () => { built += 1; return 'x'; }, machineNoun: 'PC', log: () => {},
  };
  callTool('get_writing_voice', env);
  assert.equal(built, 0);
});

test('an unknown tool is a tool error, and a missing name is invalid params', () => {
  const { env } = environment();
  const [unknown] = send(env, { id: 6, method: 'tools/call', params: { name: 'delete_everything' } });
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.result.content[0].text, 'No tool named "delete_everything".');
  const [missing] = send(env, { id: 7, method: 'tools/call', params: {} });
  assert.equal(missing.error.code, -32602);
  assert.equal(missing.error.message, 'Missing tool name.');
});

// MARK: - The connection text

const windowsLaunch: MCPLaunch = {
  command: 'C:\\Users\\roman\\AppData\\Local\\Programs\\Quill\\Quill.exe',
  args: ['C:\\Users\\roman\\AppData\\Local\\Programs\\Quill\\resources\\app.asar.unpacked\\dist\\mcp\\quill-mcp.js'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  script: 'C:\\Users\\roman\\AppData\\Local\\Programs\\Quill\\resources\\app.asar.unpacked\\dist\\mcp\\quill-mcp.js',
  scriptExists: true,
};

test('the config snippet is real JSON even with Windows backslashes in every path', () => {
  const snippet = mcpConfigSnippet(windowsLaunch);
  assert.ok(snippet.startsWith('"quill": {'));
  // Wrapped in braces it is the object a person merges under "mcpServers".
  const parsed = JSON.parse(`{ ${snippet} }`) as { quill: { command: string; args: string[]; env: Record<string, string> } };
  assert.equal(parsed.quill.command, windowsLaunch.command);
  assert.deepEqual(parsed.quill.args, windowsLaunch.args);
  assert.deepEqual(parsed.quill.env, { ELECTRON_RUN_AS_NODE: '1' });
});

test('the snippet leaves out env when there is nothing to set', () => {
  const parsed = JSON.parse(`{ ${mcpConfigSnippet({ ...windowsLaunch, env: {} })} }`);
  assert.equal(parsed.quill.env, undefined);
});

test('a data directory override travels with the server', () => {
  const launch = { ...windowsLaunch, env: { ELECTRON_RUN_AS_NODE: '1', QUILL_DATA_DIR: 'D:\\quill data' } };
  const parsed = JSON.parse(`{ ${mcpConfigSnippet(launch)} }`);
  assert.equal(parsed.quill.env.QUILL_DATA_DIR, 'D:\\quill data');
  assert.match(claudeCodeCommand(launch), /-e QUILL_DATA_DIR=D:\\quill data/);
});

test('the Claude Code command quotes paths that have spaces in them', () => {
  const command = claudeCodeCommand({
    ...windowsLaunch,
    command: 'C:\\Program Files\\Quill\\Quill.exe',
    args: ['C:\\Program Files\\Quill\\resources\\quill-mcp.js'],
  });
  assert.equal(command,
    'claude mcp add quill -e ELECTRON_RUN_AS_NODE=1 -- "C:\\Program Files\\Quill\\Quill.exe" '
    + '"C:\\Program Files\\Quill\\resources\\quill-mcp.js"');
});

test('the prompt carries the real paths, the tool name and the two non-setup answers', () => {
  const prompt = mcpClaudePrompt(windowsLaunch, 'win32');
  assert.ok(prompt.includes(windowsLaunch.script));
  assert.ok(prompt.includes(windowsLaunch.command));
  assert.ok(prompt.includes('get_writing_voice'));
  assert.ok(prompt.includes('%APPDATA%\\Claude\\claude_desktop_config.json'));
  assert.ok(prompt.includes('ELECTRON_RUN_AS_NODE'));
  assert.ok(prompt.includes('on this PC'));
  assert.match(prompt, /isn't signed in/);
  assert.match(prompt, /merge, don't overwrite/);
  assert.ok(prompt.includes(claudeCodeCommand(windowsLaunch)), 'the prompt and the button give the same command');
  // The embedded snippet must be as valid as the standalone one.
  const snippet = prompt.split('\n').filter((line) => line.startsWith('     ')).join('\n');
  assert.doesNotThrow(() => JSON.parse(`{ ${snippet.replace(/^\s+/gm, '').split('\n').filter((l) => !l.startsWith('claude mcp')).join('\n')} }`));
});

test('no line of the prompt has stray indentation inside a sentence', () => {
  for (const line of mcpClaudePrompt(windowsLaunch, 'win32').split('\n')) {
    assert.ok(!/\S {2,}\S/.test(line.trim()) || line.includes('"'), `odd spacing inside: ${line}`);
  }
});

test('the config file lives where each platform keeps it', () => {
  assert.equal(claudeDesktopConfigPath('win32'), '%APPDATA%\\Claude\\claude_desktop_config.json');
  assert.equal(claudeDesktopConfigPath('darwin'), '~/Library/Application Support/Claude/claude_desktop_config.json');
  assert.equal(claudeDesktopConfigPath('linux'), '~/.config/Claude/claude_desktop_config.json');
  assert.deepEqual(['win32', 'darwin', 'linux'].map((p) => platformNoun(p as NodeJS.Platform)), ['PC', 'Mac', 'computer']);
});

// MARK: - Where the server is

test('the launch details point at the script beside the main bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'quill-launch-'));
  mkdirSync(join(root, 'dist', 'mcp'), { recursive: true });
  mkdirSync(join(root, 'dist', 'main'), { recursive: true });
  const script = join(root, 'dist', 'mcp', 'quill-mcp.js');
  writeFileSync(script, '// server');

  const launch = mcpLaunch(join(root, 'dist', 'main'));
  assert.equal(launch.script, script);
  assert.deepEqual(launch.args, [script]);
  assert.equal(launch.scriptExists, true);
  assert.equal(launch.command, process.execPath);
});

test('a script that was not built is reported missing rather than assumed', () => {
  const root = mkdtempSync(join(tmpdir(), 'quill-launch-'));
  const launch = mcpLaunch(join(root, 'dist', 'main'));
  assert.equal(launch.scriptExists, false);
});

test('inside an asar the unpacked copy is preferred when it exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'quill-launch-'));
  const unpackedScript = join(root, 'resources', 'app.asar.unpacked', 'dist', 'mcp', 'quill-mcp.js');
  mkdirSync(join(root, 'resources', 'app.asar.unpacked', 'dist', 'mcp'), { recursive: true });
  writeFileSync(unpackedScript, '// server');

  // No real archive on disk: only the path shape matters.
  const launch = mcpLaunch(join(root, 'resources', 'app.asar', 'dist', 'main'));
  assert.equal(launch.script, unpackedScript);
  assert.equal(launch.scriptExists, true);
});

test('a data directory override is passed on to the server', () => {
  const saved = process.env.QUILL_DATA_DIR;
  process.env.QUILL_DATA_DIR = join(tmpdir(), 'quill-elsewhere');
  try {
    assert.equal(mcpLaunch(tmpdir()).env.QUILL_DATA_DIR, join(tmpdir(), 'quill-elsewhere'));
  } finally {
    if (saved === undefined) delete process.env.QUILL_DATA_DIR; else process.env.QUILL_DATA_DIR = saved;
  }
});
