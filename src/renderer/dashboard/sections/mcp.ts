import { claudeCodeCommand, claudeDesktopConfigPath, mcpClaudePrompt, mcpConfigSnippet } from '../../../core/account/mcpConnect';
import type { MCPLaunch } from '../../../core/account/types';
import { clear, h, message, pageHead } from '../dom';
import { toast } from '../toast';
import { accountApi } from './account';

/// The MCP screen — always in the sidebar, because "it should be there all the
/// time anyways". Signed out, the real content sits behind a blur with a lock
/// card on top explaining what signing in unlocks; signing in un-blurs the SAME
/// view rather than swapping to a different one, so there is nothing to keep in
/// sync between two copies of this screen.
///
/// See `src/mcp/server.ts` for the server itself.

/// Asks the dashboard to switch screens. `dashboard.ts` owns navigation and does
/// not export it, so this goes out as an event it can listen for; the hash is
/// set as well so a window that has not wired the event still lands on the right
/// screen the next time it routes.
export const NAVIGATE = 'quill:navigate';

function goTo(section: string): void {
  window.dispatchEvent(new CustomEvent(NAVIGATE, { detail: section }));
  window.location.hash = section;
}

export async function renderMCP(root: HTMLElement): Promise<void> {
  const [account, launch] = await Promise.all([accountApi.get(), accountApi.mcpLaunch()]);
  const signedIn = account !== null;
  const platform = window.quill.platform;

  clear(root);
  root.appendChild(pageHead('MCP', 'Let Claude write the way you write.'));

  const content = h('div', {},
    benefits(),
    h('div', { style: 'margin-top:16px' }, connection(launch, platform)));

  if (signedIn) {
    root.appendChild(content);
    return;
  }

  // Real content behind a genuine blur, with a lock card on top. Blurred, not
  // hidden: a person who already knows what is here and is mid-sign-in should
  // not watch it flash empty and back. Set through the CSSOM — the page's
  // policy blocks the `style` ATTRIBUTE, and `h()` writes `cssText`.
  const blurred = h('div', {
    style: 'filter:blur(7px);opacity:0.55;pointer-events:none;user-select:none',
    'aria-hidden': 'true',
  }, content);
  const lock = h('div', {
    style: 'position:absolute;top:0;left:0;right:0;bottom:0;display:flex;'
      + 'align-items:flex-start;justify-content:center;padding-top:72px',
  }, message({
    title: 'Log in to use this feature',
    body: 'Signing in unlocks MCP — Claude reading your writing voice — and syncing this '
      + 'data to another computer. Everything else in Quill works exactly the same without an account.',
    steps: ['MCP: Claude can write like you', 'Sync: this data follows you to another computer'],
    action: { label: 'Go to Account', onClick: () => goTo('account') },
  }));
  root.appendChild(h('div', { style: 'position:relative' }, blurred, lock));
}

function benefits(): HTMLElement {
  const point = (title: string, detail: string): HTMLElement =>
    h('div', { style: 'padding:6px 0' },
      h('div', { style: 'font-weight:600' }, title),
      h('div', { class: 'muted' }, detail));
  return h('section', {},
    h('h2', { class: 'section-title' }, 'What this unlocks'),
    h('div', { class: 'card' },
      point('Claude can write like you',
        'Connect Quill\'s MCP server in Claude and it can read your writing style and real '
        + 'dictations to draft in your voice.'),
      point('Quill never touches your email',
        'It only ever hands over how you write. Whatever Claude does with that is access you '
        + 'grant Claude separately.')));
}

/// The connection details themselves — explanation, config snippet, copy
/// buttons. Always renders its full content; the page around it decides whether
/// that content is visible, blurred, or locked behind a prompt.
function connection(launch: MCPLaunch, platform: NodeJS.Platform): HTMLElement {
  // One receipt line at a time: the second copy silently replaced the first on
  // the clipboard, and a stale "Copied." beside the first button is the one
  // people act on.
  const promptReceipt = h('span', { class: 'tiny muted' });
  const configReceipt = h('span', { class: 'tiny muted' });
  const copy = async (text: string, receipt: HTMLElement): Promise<void> => {
    await navigator.clipboard.writeText(text);
    promptReceipt.textContent = '';
    configReceipt.textContent = '';
    receipt.textContent = 'Copied.';
    toast('Copied.');
  };

  const noun = platform === 'win32' ? 'PC' : platform === 'darwin' ? 'Mac' : 'computer';

  return h('section', {},
    h('h2', { class: 'section-title' }, 'Connect to Claude'),
    h('div', { class: 'card' },
      launch.scriptExists
        ? null
        : h('div', { class: 'chip warn', style: 'margin-bottom:12px;white-space:normal;height:auto;padding:6px 10px' },
          `The MCP server file is not at ${launch.script}. In a development checkout, run "npm run build" first; `
          + 'in an installed copy, reinstall Quill.'),
      h('p', { style: 'margin:0 0 12px' },
        `Easiest way: copy this and paste it into Claude Code, or any Claude that can run commands on this ${noun}. `
        + 'It has the path, the config file and what to check, so Claude can do the whole thing and then '
        + 'prove it worked.'),
      h('div', { style: 'display:flex;align-items:center;gap:10px' },
        h('button', {
          class: 'button primary',
          onClick: () => { void copy(mcpClaudePrompt(launch, platform), promptReceipt); },
        }, 'Copy prompt for Claude'),
        promptReceipt),

      h('hr', { style: 'border:none;border-top:1px solid var(--hairline);margin:16px 0' }),

      h('p', { style: 'margin:0 0 8px' },
        'Or do it yourself. For Claude Code, run this in a terminal:'),
      h('pre', { class: 'mono tiny', style: 'margin:0 0 12px;white-space:pre-wrap;word-break:break-all' },
        claudeCodeCommand(launch)),
      h('p', { style: 'margin:0 0 8px' },
        'For Claude Desktop, add this under “mcpServers” in ',
        h('span', { class: 'mono tiny' }, claudeDesktopConfigPath(platform)),
        ', then quit and reopen Claude.'),
      h('pre', { class: 'mono tiny', style: 'margin:0 0 12px;white-space:pre-wrap;word-break:break-all' },
        mcpConfigSnippet(launch)),
      h('div', { style: 'display:flex;align-items:center;gap:10px' },
        h('button', {
          class: 'button secondary',
          onClick: () => { void copy(mcpConfigSnippet(launch), configReceipt); },
        }, 'Copy config'),
        h('button', {
          class: 'button secondary',
          onClick: () => { void copy(claudeCodeCommand(launch), configReceipt); },
        }, 'Copy Claude Code command'),
        configReceipt)));
}
