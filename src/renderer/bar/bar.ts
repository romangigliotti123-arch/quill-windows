/// The always-on bar's renderer. It draws a pill and reports two clicks; every
/// decision — whether a click starts or stops a dictation, where the bar sits —
/// belongs to the main process, which is the only place that knows whether a
/// dictation is really running.

type Anchor = 'left' | 'center' | 'right';

declare global {
  interface Window {
    quillBar: {
      onConfig(handler: (config: { anchor: Anchor; showsNewNote: boolean }) => void): void;
      onActive(handler: (active: boolean) => void): void;
      toggle(): void;
      newNote(): void;
    };
  }
}

const stage = document.getElementById('stage') as HTMLDivElement;
const pill = document.getElementById('pill') as HTMLDivElement;
const dictate = document.getElementById('dictate') as HTMLButtonElement;
const note = document.getElementById('note') as HTMLButtonElement;

// Hover is tracked on the pill itself rather than the window: the window is
// bigger than the widest the pill gets, and the empty margin around it must not
// count as "over the bar".
pill.addEventListener('mouseenter', () => { pill.dataset.hover = 'true'; });
pill.addEventListener('mouseleave', () => { pill.dataset.hover = 'false'; });

// `click`, which only fires when the press and the release are on the same
// element: a press that starts on the bar and ends elsewhere is not a request
// to dictate.
dictate.addEventListener('click', () => { window.quillBar.toggle(); });
note.addEventListener('click', () => { window.quillBar.newNote(); });

window.quillBar.onConfig((config) => {
  stage.dataset.anchor = config.anchor;
  pill.dataset.note = String(config.showsNewNote);
});

window.quillBar.onActive((active) => {
  pill.dataset.active = String(active);
  dictate.setAttribute('aria-label', active ? 'Stop dictating' : 'Dictate');
});

export {};
