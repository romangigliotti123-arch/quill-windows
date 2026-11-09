import { api, type SpeechStatus } from './bridge';
import { clear, h } from './dom';

/// First-run setup: four short steps, shown once, on a machine that has never
/// run Quill.
///
/// The macOS build's version has a "Three permissions" step, because macOS makes
/// an app earn Microphone, Accessibility and Input Monitoring one by one and
/// each fails silently when missing. Windows has none of that — the keyboard
/// hook needs no grant and the microphone prompt appears by itself — so this
/// version's second step is the thing that actually costs a new user time here:
/// the speech model, which is a ~1.6 GB first download.
///
/// "First run" is "settings.json does not exist", decided by the main process
/// before anything can create it. Finishing creates it even when every default
/// was accepted, so this never comes back for someone who simply clicked
/// through.

type StepId = 'welcome' | 'setup' | 'account' | 'ready';

const STEPS: { id: StepId; title: string }[] = [
  { id: 'welcome', title: 'Quill types what you say' },
  { id: 'setup', title: 'Get ready' },
  { id: 'account', title: 'An account, if you want one' },
  { id: 'ready', title: 'That’s it' },
];

export async function maybeShowOnboarding(go: (section: string) => void): Promise<void> {
  if (!(await api.app.isFirstRun())) return;
  const settings = await api.settings.get();
  show(settings.holdKey === 'AltRight' ? 'Right Alt' : settings.holdKey, go);
}

function row(title: string, detail: string, trailing?: Node | null): HTMLElement {
  return h('div', { class: 'onboarding-row' },
    h('div', { class: 'grow' },
      h('div', { style: 'font-weight:600' }, title),
      h('div', { class: 'metric-note' }, detail)),
    trailing ?? null);
}

function show(holdKeyName: string, go: (section: string) => void): void {
  const overlay = h('div', { id: 'onboarding', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Welcome to Quill' });
  document.body.appendChild(overlay);

  let index = 0;
  let stop: (() => void) | null = null;

  const finish = async (destination?: string): Promise<void> => {
    stop?.();
    await api.app.completeOnboarding();
    overlay.remove();
    if (destination) go(destination);
  };

  const draw = (): void => {
    stop?.();
    stop = null;
    clear(overlay);
    const step = STEPS[index]!;

    const body = h('div', { class: 'onboarding-body' });
    if (step.id === 'welcome') {
      body.append(
        row('On-device transcription',
          'Whisper large-v3-turbo runs on this PC. Your voice never leaves it.'),
        row(`Hold ${holdKeyName} to talk`,
          'Let go and the words land wherever your cursor already is. No window to open first.'),
        row('It learns your words',
          'Names, tools and jargon go in the Dictionary and stop coming out wrong.'));
    } else if (step.id === 'setup') {
      const mic = h('span', { class: 'chip' }, 'not checked');
      const model = h('span', { class: 'chip' }, 'not loaded');
      const hook = h('span', { class: 'chip' }, 'checking…');
      const paint = (speech: SpeechStatus): void => {
        model.className = speech.ready ? 'chip good' : speech.downloading ? 'chip accent' : 'chip';
        model.textContent = speech.ready
          ? (speech.device === 'webgpu' ? 'ready · GPU' : 'ready · CPU')
          : speech.downloading ? `downloading ${Math.round(speech.downloading.progress)}%` : 'not loaded';
      };
      void api.speech.status().then(paint);
      api.on('speech', (payload) => paint(payload as SpeechStatus));
      void api.app.diagnostics().then((report) => {
        hook.className = report.keyboardHook ? 'chip good' : 'chip warn';
        hook.textContent = report.keyboardHook ? 'working' : 'unavailable';
      });
      body.append(
        row('Microphone', 'Windows asks the first time. Allow it so Quill can hear you.',
          h('span', { style: 'display:flex;gap:8px;align-items:center' }, mic,
            h('button', {
              class: 'button secondary small',
              onClick: async () => {
                const devices = await api.speech.devices().catch(() => []);
                mic.className = devices.length > 0 ? 'chip good' : 'chip warn';
                mic.textContent = devices.length > 0
                  ? `${devices.length} found` : 'none found — check Windows privacy settings';
              },
            }, 'Allow'))),
        row('Speech model',
          'Downloads once (about 1.6 GB for large-v3-turbo; Base is 80 MB if you pick it in Settings), '
          + 'then works offline. Start it now so your first dictation is instant.',
          h('span', { style: 'display:flex;gap:8px;align-items:center' }, model,
            h('button', {
              class: 'button secondary small',
              onClick: () => { void api.speech.prepare(); },
            }, 'Download'))),
        row('Push-to-talk key', `Quill watches ${holdKeyName} to know when you are talking.`, hook));
    } else if (step.id === 'account') {
      body.append(
        row('Optional, and everything works without it',
          'Sign in and Quill can sync your history, Dictionary, snippets, transforms and learned '
          + 'style to another computer — including a Mac — and unlocks MCP, so Claude can write in '
          + 'your voice.'),
        row('Your AI key is separate',
          'The free NVIDIA key for the optional cleanup model goes in Settings, not here.'));
    } else {
      body.append(
        row(`Hold ${holdKeyName} and say something`, 'Let go and it types.'),
        row('Ctrl + Alt + Z takes it back', 'Quill deletes exactly what it inserted, after checking it is still there.'),
        row('Tap again to send', 'Tap the key right after letting go and Quill presses Enter once your words have landed.'),
        row('If the key does nothing', 'Open Help — it runs a diagnostic and says which part is not working.'));
    }

    const isLast = index === STEPS.length - 1;
    const actions = h('div', { class: 'onboarding-actions' },
      index > 0
        ? h('button', { class: 'button ghost', onClick: () => { index -= 1; draw(); } }, 'Back')
        : h('span', {}),
      h('span', { class: 'onboarding-dots', 'aria-hidden': 'true' },
        ...STEPS.map((_, dot) => h('i', { class: dot === index ? 'on' : '' }))),
      step.id === 'account'
        ? h('span', { style: 'display:flex;gap:8px' },
          h('button', { class: 'button ghost', onClick: () => { index += 1; draw(); } }, 'Continue without an account'),
          h('button', { class: 'button secondary', onClick: () => { void finish('account'); } }, 'Create an account'))
        : h('button', {
          class: 'button primary',
          onClick: () => { if (isLast) void finish(); else { index += 1; draw(); } },
        }, isLast ? 'Start using Quill' : 'Continue'));

    overlay.append(h('div', { class: 'onboarding-panel' },
      h('h2', {}, step.title), body, actions));
  };

  draw();
}
