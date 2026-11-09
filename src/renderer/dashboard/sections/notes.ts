import { api, type WireNote } from '../bridge';
import { clear, h, pageHead, relativeTime } from '../dom';
import { toast } from '../toast';

/// The Notes screen.
///
/// Two fields and nothing else: a title and a place to talk into. No folders,
/// no tags, no formatting, no manual save button — the body is a real
/// `<textarea>`, so holding the dictation key while it is focused inserts text
/// through the exact same path as dictating into any other app. That is the
/// entire feature; everything else here is just enough chrome to create one,
/// find it again, and delete it.
///
/// Exactly one thing on screen at a time — the empty state, the list, or the
/// editor — matching how simple the feature itself is.

/// Half a second after the last keystroke: long enough that a fast typist or an
/// in-progress dictation does not write to disk on every character, short
/// enough that closing the note a moment later never loses anything.
const SAVE_DELAY_MS = 500;

export async function renderNotes(root: HTMLElement): Promise<void> {
  let openId: string | null = null;
  /// Set right after creating a note, so its editor focuses the title instead
  /// of the body: "they can name it and then start talking in it."
  let focusTitle = false;
  let flushPending: (() => Promise<void>) | null = null;

  const draw = async (): Promise<void> => {
    // Called right before the editor is torn down, so navigating away
    // immediately after typing never loses the debounce window.
    if (flushPending) { await flushPending(); flushPending = null; }
    const notes = await api.notes.list();
    clear(root);
    root.appendChild(pageHead(
      'Notes',
      'A place to talk into that is not any particular app — a list, an idea, a draft that '
      + 'does not have a home yet.',
    ));

    const open = openId === null ? null : notes.find((note) => note.id === openId) ?? null;
    if (open) { drawEditor(open); return; }
    openId = null;

    root.appendChild(h('div', { style: 'display:flex;gap:8px;margin-bottom:16px' },
      h('button', { class: 'button primary', onClick: () => { void create(); } }, 'New note')));

    if (notes.length === 0) {
      root.appendChild(h('div', { class: 'card' },
        h('div', { style: 'font-weight:600;margin-bottom:6px' }, 'Nothing here yet'),
        h('div', { class: 'muted' },
          'Make a note, name it, and start talking — hold your dictation key while the note is open '
          + 'and the words land in it. Or use the New Note button on the bar.')));
      return;
    }

    const list = h('div', { class: 'list-pane' });
    for (const note of notes) {
      list.appendChild(h('div', { class: 'row' },
        h('button', {
          class: 'grow',
          style: 'all:unset;cursor:pointer;display:block;min-width:0;flex:1',
          onClick: () => { openId = note.id; void draw(); },
        },
          h('div', { class: 'primary truncate' }, displayTitle(note)),
          h('div', { class: 'secondary' }, `${relativeTime(note.updated)}`)),
        h('button', {
          class: 'button danger small',
          'aria-label': `Delete ${displayTitle(note)}`,
          onClick: async () => {
            await api.notes.delete(note.id);
            toast('Note deleted.');
            await draw();
          },
        }, 'Delete')));
    }
    root.appendChild(list);
  };

  const create = async (): Promise<void> => {
    const now = Date.now();
    const created = await api.notes.upsert({
      id: crypto.randomUUID(), title: '', body: '', created: now, updated: now,
    });
    openId = created.id;
    focusTitle = true;
    await draw();
  };

  const drawEditor = (note: WireNote): void => {
    const title = h('input', {
      class: 'field',
      value: note.title,
      placeholder: 'Name this note',
      style: 'font-size:18px;font-weight:600',
    });
    const body = h('textarea', {
      class: 'field',
      rows: 18,
      spellcheck: true,
      placeholder: 'Hold your dictation key and start talking.',
    });
    body.value = note.body;

    let timer: number | null = null;
    const save = async (): Promise<void> => {
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
      await api.notes.upsert({ ...note, title: title.value, body: body.value });
    };
    const queue = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void save(); }, SAVE_DELAY_MS);
      flushPending = save;
    };
    title.addEventListener('input', queue);
    body.addEventListener('input', queue);

    root.appendChild(h('div', { style: 'display:grid;gap:12px' },
      h('div', { style: 'display:flex;gap:8px;align-items:center' },
        h('button', {
          class: 'button ghost small',
          onClick: () => { openId = null; void draw(); },
        }, '← All notes'),
        h('button', {
          class: 'button danger small',
          style: 'margin-left:auto',
          onClick: async () => {
            flushPending = null;
            if (timer !== null) window.clearTimeout(timer);
            await api.notes.delete(note.id);
            openId = null;
            toast('Note deleted.');
            await draw();
          },
        }, 'Delete')),
      title,
      body,
      h('div', { class: 'muted tiny' }, 'Saved automatically.')));

    (focusTitle ? title : body).focus();
    focusTitle = false;
  };

  await draw();
}

function displayTitle(note: WireNote): string {
  const title = note.title.trim();
  if (title.length > 0) return title;
  const firstLine = (note.body.trim().split('\n')[0] ?? '').trim();
  return firstLine.length === 0 ? 'Untitled note' : firstLine;
}
