import type {
  AccountActionResult, AccountInfo, DeviceWire, MCPLaunch,
} from '../../../core/account/types';
import { clear, h, pageHead, relativeTime } from '../dom';
import { toast } from '../toast';

/// The Account tab: everything about the optional account, in one place —
/// sign in/out, what syncs to it versus what stays on this machine, which
/// devices are connected, and changing your password.
///
/// Signed out by default, and staying that way changes nothing about Quill. The
/// account exists so a second computer can have your history, Dictionary,
/// snippets, transforms, learned style and AI key, and so Claude can read how
/// you write over MCP. Nobody is asked to create one, and nothing here makes a
/// request until this screen is used.

// MARK: - The bridge to the main process

/// Typed calls for the handlers in `src/main/account/accountService.ts`. Kept in
/// this file so the screen is one unit; `mcp.ts` imports it from here. When
/// `bridge.ts` grows an `account` group these move there unchanged.
const call = <T>(name: string, payload?: unknown): Promise<T> =>
  window.quill.invoke(name, payload) as Promise<T>;

export const accountApi = {
  get: () => call<AccountInfo | null>('account.get'),
  signIn: (email: string, password: string) =>
    call<AccountActionResult>('account.signIn', { email, password }),
  signUp: (email: string, password: string) =>
    call<AccountActionResult>('account.signUp', { email, password }),
  signOut: () => call<AccountActionResult>('account.signOut'),
  changePassword: (currentPassword: string, newPassword: string) =>
    call<AccountActionResult>('account.changePassword', { currentPassword, newPassword }),
  devices: () => call<DeviceWire[]>('account.devices'),
  mcpLaunch: () => call<MCPLaunch>('mcp.launch'),
};

/// Fired on `window` whenever sign-in state changes from this screen, so
/// anything that depends on it (the sidebar's MCP lock, onboarding) can follow
/// without this file knowing it exists. `detail` is the new `AccountInfo | null`.
export const ACCOUNT_CHANGED = 'quill:account-changed';
/// Fired once, right after a genuinely NEW account finishes creating — not on
/// sign-in, even a first one on this machine. Onboarding uses it to decide
/// whether to show the MCP intro: the ask was "as soon as they create an
/// account", and someone signing into an account they already made elsewhere
/// has likely already seen it there.
export const ACCOUNT_CREATED = 'quill:account-created';

function announce(account: AccountInfo | null): void {
  window.dispatchEvent(new CustomEvent(ACCOUNT_CHANGED, { detail: account }));
}

// MARK: - The screen

type Mode = 'signIn' | 'signUp';

const SYNCED = ['Dictation history', 'Dictionary', 'Snippets', 'Transforms', 'Learned style', 'Your AI key'];
const LOCAL = ['Settings — hotkey, microphone, speech model'];

export async function renderAccount(root: HTMLElement): Promise<void> {
  // Built off-screen and swapped in, as Settings does: this screen redraws on
  // every sign-in, sign-out and refresh, and clearing first would blank it for
  // as long as the IPC round trips took.
  const body = h('div', {});
  let mode: Mode = 'signIn';
  let account: AccountInfo | null = null;
  let attached = false;

  const draw = async (): Promise<void> => {
    account = await accountApi.get();
    clear(body);
    body.appendChild(accountCard());
    body.appendChild(h('div', { class: 'grid cols-2', style: 'margin-top:16px' },
      infoCard('Synced to your account', SYNCED),
      infoCard('Stays on this device', LOCAL)));
    if (account) {
      body.appendChild(h('div', { style: 'margin-top:16px' }, devicesCard()));
      body.appendChild(h('div', { style: 'margin-top:16px' }, passwordCard()));
    }
    if (!attached) {
      attached = true;
      clear(root);
      root.appendChild(pageHead('Account', 'Optional. Everything else in Quill works exactly the same without one.'));
      root.appendChild(body);
    }
  };

  /// A one-line status under a form. No red anywhere else in this app, so a
  /// failure is the secondary ink and a success the tertiary — said in words,
  /// not colour.
  const status = (): { element: HTMLElement; set: (text: string, isError?: boolean) => void } => {
    const element = h('div', { class: 'tiny muted', style: 'min-height:16px;margin-top:8px' });
    return {
      element,
      set: (text, isError = false) => {
        element.textContent = text;
        element.style.color = isError ? 'var(--ink-secondary)' : '';
      },
    };
  };

  const accountCard = (): HTMLElement => {
    if (account) {
      const note = status();
      return h('section', {},
        h('h2', { class: 'section-title' }, 'Signed in'),
        h('div', { class: 'card' },
          h('div', { style: 'display:flex;align-items:center;gap:12px' },
            h('div', { class: 'grow', style: 'flex:1 1 auto;min-width:0' },
              'Signed in as ', h('strong', {}, account.email)),
            h('button', {
              class: 'button secondary',
              onClick: async () => {
                note.set('Syncing, then logging out…');
                const result = await accountApi.signOut();
                if (!result.ok) { note.set(result.message, true); return; }
                announce(null);
                toast('Logged out.');
                await draw();
              },
            }, 'Log Out')),
          note.element));
    }

    const email = h('input', { class: 'field', type: 'email', placeholder: 'you@example.com', spellcheck: false });
    const password = h('input', { class: 'field', type: 'password', placeholder: 'Password' });
    const note = status();
    const primary = h('button', { class: 'button primary' }, mode === 'signIn' ? 'Log In' : 'Create Account');
    const toggle = h('button', {
      class: 'button ghost',
      onClick: () => { mode = mode === 'signIn' ? 'signUp' : 'signIn'; void draw(); },
    }, mode === 'signIn' ? 'New here? Create an account' : 'Already have an account? Log in');

    const submit = async (): Promise<void> => {
      if (primary.disabled) return;
      const address = email.value.trim();
      if (address.length === 0 || password.value.length === 0) {
        note.set('Enter an email and a password.', true);
        return;
      }
      // Disabled to say "busy", and guarded here so a click queued during the
      // wait cannot start a second request.
      primary.disabled = true;
      toggle.disabled = true;
      note.set(mode === 'signIn' ? 'Logging in…' : 'Creating your account…');
      const creating = mode === 'signUp';
      const result = creating
        ? await accountApi.signUp(address, password.value)
        : await accountApi.signIn(address, password.value);
      if (!result.ok) {
        note.set(result.message, true);
        primary.disabled = false;
        toggle.disabled = false;
        return;
      }
      announce(result.account);
      if (creating) window.dispatchEvent(new CustomEvent(ACCOUNT_CREATED));
      toast(creating ? 'Account created.' : 'Logged in.');
      await draw();
    };
    primary.addEventListener('click', () => { void submit(); });
    const onEnter = (event: KeyboardEvent): void => { if (event.key === 'Enter') void submit(); };
    email.addEventListener('keydown', onEnter);
    password.addEventListener('keydown', onEnter);

    return h('section', {},
      h('h2', { class: 'section-title' }, mode === 'signIn' ? 'Sign in' : 'Create an account'),
      h('div', { class: 'card' },
        h('div', { style: 'display:grid;gap:8px;max-width:420px' }, email, password),
        h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:12px' }, primary),
        h('div', { style: 'margin-top:6px' }, toggle),
        note.element));
  };

  /// What actually moves to a second machine, named plainly rather than left to
  /// be inferred from watching it happen — the same list as `SyncEngine`'s own
  /// doc comment, which this mirrors on purpose.
  const infoCard = (title: string, items: string[]): HTMLElement =>
    h('section', {},
      h('h2', { class: 'section-title' }, title),
      h('div', { class: 'card' },
        h('ul', { style: 'margin:0;padding-left:1.2em;display:grid;gap:4px' },
          ...items.map((item) => h('li', {}, item)))));

  /// Every device signed into this account, and when it last synced. A
  /// snapshot, not a live feed: there is no push channel for "another machine
  /// just synced", so this refreshes by asking again.
  const devicesCard = (): HTMLElement => {
    const list = h('div', {}, h('div', { class: 'muted' }, 'Loading…'));
    const noun = window.quill.platform === 'win32' ? 'this PC'
      : window.quill.platform === 'darwin' ? 'this Mac' : 'this computer';

    const refresh = async (): Promise<void> => {
      const devices = await accountApi.devices();
      clear(list);
      if (devices.length === 0) {
        list.appendChild(h('div', { class: 'muted' }, 'No devices have synced yet.'));
        return;
      }
      const rows = h('div', { class: 'rows' });
      for (const device of devices) {
        const when = device.lastSyncedAt !== null
          ? `Synced ${relativeTime(device.lastSyncedAt)}`
          : 'Not synced yet';
        rows.appendChild(h('div', { class: 'row' },
          h('div', { class: 'grow' },
            h('div', { class: 'primary' }, device.isThisDevice ? `${device.name} (${noun})` : device.name),
            h('div', { class: 'secondary' }, when))));
      }
      list.appendChild(rows);
    };
    void refresh();

    return h('section', {},
      h('div', { style: 'display:flex;align-items:baseline;justify-content:space-between' },
        h('h2', { class: 'section-title' }, 'Devices connected'),
        h('button', { class: 'button ghost small', onClick: () => { void refresh(); } }, 'Refresh')),
      list);
  };

  /// Re-proves the current password with a normal sign-in before changing it —
  /// see `AccountStore.changePassword`.
  const passwordCard = (): HTMLElement => {
    const current = h('input', { class: 'field', type: 'password', placeholder: 'Current password' });
    const next = h('input', { class: 'field', type: 'password', placeholder: 'New password' });
    const confirm = h('input', { class: 'field', type: 'password', placeholder: 'Confirm new password' });
    const note = status();
    const submit = h('button', { class: 'button primary' }, 'Update password');
    submit.addEventListener('click', async () => {
      if (submit.disabled) return;
      if (current.value.length === 0 || next.value.length === 0) {
        note.set('Enter your current and new password.', true);
        return;
      }
      if (next.value !== confirm.value) {
        note.set('The new password and its confirmation don\'t match.', true);
        return;
      }
      submit.disabled = true;
      note.set('Updating…');
      const result = await accountApi.changePassword(current.value, next.value);
      submit.disabled = false;
      if (!result.ok) { note.set(result.message, true); return; }
      current.value = '';
      next.value = '';
      confirm.value = '';
      note.set('Password updated.');
    });
    return h('section', {},
      h('h2', { class: 'section-title' }, 'Change password'),
      h('div', { class: 'card' },
        h('div', { style: 'display:grid;gap:8px;max-width:420px' }, current, next, confirm),
        h('div', { style: 'margin-top:12px' }, submit),
        note.element));
  };

  await draw();
}
