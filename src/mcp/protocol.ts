/// Quill's MCP server, as a function from one line of input to zero or more
/// lines of output — so the whole protocol can be proven without a process,
/// a pipe or a Claude on the other end.
///
/// A real MCP server, not a description of one. Claude Desktop (or Claude Code)
/// spawns it over stdio and talks JSON-RPC 2.0 to it, one message per line.
///
/// Deliberately narrow: one tool, and it hands over the same thing the
/// dashboard's "Copy for AI" button already writes to a file — writing style,
/// learned patterns, real dictation examples. Nothing here reads or sends email;
/// that access, if Claude has it at all, is granted to Claude separately and is
/// none of this server's business. See `VoiceExport` for the actual content and
/// `SyncEngine`'s doc comment for the same boundary stated from the account
/// side.
///
/// Requires a signed-in account, because that is the feature this unlocks — see
/// the Account screen's "Synced to your account" card for why the two are
/// already the same boundary elsewhere in this app.

/// Whatever the client sent for `id` — number, string, or absent — echoed back
/// exactly. A notification (no `id` at all) gets no response; getting this
/// wrong either leaves Claude Desktop waiting on a reply that never comes or
/// sends one it never asked for.
export type RPCID =
  | { kind: 'value'; value: number | string }
  | { kind: 'null' }
  | { kind: 'none' };

export function rpcID(raw: unknown): RPCID {
  if (raw === undefined) return { kind: 'none' };
  if (typeof raw === 'number' || typeof raw === 'string') return { kind: 'value', value: raw };
  return { kind: 'null' };
}

function idValue(id: RPCID): number | string | null {
  return id.kind === 'value' ? id.value : null;
}

export const WRITING_VOICE_TOOL = 'get_writing_voice';

export const TOOLS = [
  {
    name: WRITING_VOICE_TOOL,
    description: 'How this person writes: learned patterns (spelling, contractions, '
      + 'formality, sentence length) plus real excerpts of things they have actually '
      + 'dictated, oldest first. Use this when asked to write, draft, or reply AS this '
      + 'person, in their voice — not as a source of facts about them.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export interface ServerEnvironment {
  isSignedIn(): boolean;
  /// The markdown document `get_writing_voice` returns.
  voiceMarkdown(): string;
  /// "Mac", "PC" or "computer", for the one sentence that names the machine.
  machineNoun: string;
  /// Diagnostics. Never stdout: the transport IS stdout.
  log(message: string): void;
}

/// `content` + `isError`, MCP's own shape for "the tool ran, and here is what
/// happened" — a signed-out machine is not a protocol failure, it is an answer
/// Claude can read and relay: "ask them to sign in."
export function callTool(name: string, env: ServerEnvironment): { content: string; isError: boolean } {
  if (name !== WRITING_VOICE_TOOL) return { content: `No tool named "${name}".`, isError: true };
  if (!env.isSignedIn()) {
    return {
      content: `Quill is not signed into an account on this ${env.machineNoun}. Open Quill, `
        + 'go to Account, and sign in or create one — this tool needs that '
        + 'to know whose voice to hand over.',
      isError: true,
    };
  }
  return { content: env.voiceMarkdown(), isError: false };
}

function respond(id: RPCID, result: unknown): string[] {
  // A notification has no id and gets no reply — responding to one is itself a
  // protocol violation.
  if (id.kind === 'none') return [];
  return [JSON.stringify({ jsonrpc: '2.0', id: idValue(id), result })];
}

function respondError(id: RPCID, code: number, message: string): string[] {
  if (id.kind === 'none') return [];
  return [JSON.stringify({ jsonrpc: '2.0', id: idValue(id), error: { code, message } })];
}

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_VERSION = '1.0.0';

/// One input line in, the lines to write to stdout out.
export function handleLine(line: string, env: ServerEnvironment): string[] {
  if (line.trim().length === 0) return [];
  let request: Record<string, unknown>;
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof (value as { method?: unknown }).method !== 'string') {
      throw new Error('not a request');
    }
    request = value as Record<string, unknown>;
  } catch {
    env.log(`unparseable line, ignored: ${line.slice(0, 120)}`);
    return [];
  }
  const method = request.method as string;
  const id = rpcID(request.id);

  switch (method) {
    case 'initialize':
      return respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'quill', version: SERVER_VERSION },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return []; // Notifications. No reply, ever.

    case 'tools/list':
      return respond(id, { tools: TOOLS });

    case 'tools/call': {
      const params = request.params as { name?: unknown } | undefined;
      if (!params || typeof params.name !== 'string') {
        return respondError(id, -32602, 'Missing tool name.');
      }
      const { content, isError } = callTool(params.name, env);
      return respond(id, { content: [{ type: 'text', text: content }], isError });
    }

    case 'ping':
      return respond(id, {});

    default:
      return respondError(id, -32601, `Method not found: ${method}`);
  }
}
