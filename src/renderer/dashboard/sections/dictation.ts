import { api, type WireRecord } from '../bridge';
import { card, clear, empty, h, keycap, pageHead, relativeTime } from '../dom';
import { diffWords } from '../diff';
import { openSheet } from '../sheet';
import { toast } from '../toast';

/// What you said, and what came out.
///
/// The list is the record; the detail pane is the argument. Showing the raw
/// transcript next to what was inserted is the only way a user can tell a
/// recogniser error from a cleanup error — and it is the same split the
/// comparison rig needs, which is why the two are stored separately rather than
/// collapsed into one text column.

export async function renderDictation(root: HTMLElement): Promise<void> {
  clear(root);
  root.appendChild(pageHead('Dictation', 'Every dictation, what the recogniser heard, and what Quill actually typed.'));

  const records = await api.history.list();
  if (records.length === 0) {
    root.appendChild(empty('Nothing here yet.', 'Hold your dictation key, say something, and let go.'));
    return;
  }

  const list = h('div', { class: 'list-pane' });
  const detail = h('div', { class: 'detail-pane' });
  root.appendChild(h('div', { class: 'split' }, list, detail));

  let selected = records[0]!.id;

  const drawList = (): void => {
    clear(list);
    for (const record of records) {
      const row = h('button', {
        class: 'row',
        'aria-selected': record.id === selected ? 'true' : 'false',
        onClick: () => { selected = record.id; drawList(); drawDetail(); },
      },
        h('div', { class: 'grow' },
          h('div', { class: 'primary truncate' },
            record.insertedText.length > 0 ? record.insertedText : record.rawText),
          h('div', { class: 'secondary' }, summaryLine(record))));
      list.appendChild(row);
    }
  };

  const drawDetail = (): void => {
    const record = records.find((candidate) => candidate.id === selected);
    clear(detail);
    if (!record) return;

    detail.appendChild(card(
      h('div', { class: 'eyebrow' }, 'Inserted'),
      h('div', { class: 'transcript' },
        record.insertedText.length > 0 ? record.insertedText : '— nothing was inserted —')));

    if (record.rawText !== record.insertedText) {
      detail.appendChild(card(
        h('div', { class: 'eyebrow' }, 'What the recogniser heard, and what Quill changed'),
        h('div', { class: 'transcript diff' }, diffWords(record.rawText, record.insertedText))));
    }

    if (record.correctedText) {
      detail.appendChild(card(
        h('div', { class: 'eyebrow' }, 'Your correction'),
        h('div', { class: 'transcript' }, record.correctedText),
        h('div', { class: 'metric-note', style: 'margin-top:8px' },
          'Both versions are kept: what Quill typed, and what you changed it to. The difference is '
          + 'what it learns from.')));
    }

    if (record.insertedText.length > 0) {
      detail.appendChild(card(
        h('div', { class: 'eyebrow' }, 'Something wrong?'),
        h('div', { class: 'muted', style: 'margin-bottom:10px' },
          'Fix the text here and Quill learns from the difference — it is the only real signal it '
          + 'gets about what it got wrong. Words worth adding to your Dictionary are offered, '
          + 'never added on their own.'),
        h('button', {
          class: 'button secondary',
          onClick: () => openCorrection(record),
        }, record.correctedText ? 'Correct it again' : 'Correct this')));
    }

    const timings = record.timings;
    detail.appendChild(card(
      h('div', { class: 'eyebrow' }, 'Timings'),
      timingRows([
        ['Key release → text on screen', timings.releaseToInsertedMs],
        ['Microphone open', timings.micOpenMs],
        ['You started speaking', timings.speechOnsetMs],
        ['Recogniser’s first guess', timings.recogniserFirstWordMs],
        ['Key down → first word', timings.timeToFirstWordMs],
        ['Final transcript → inserted', timings.finalToInsertedMs],
        ['Whole interaction', timings.endToEndMs],
        ['Length of what you said', timings.audioDurationMs],
      ]),
      h('div', { class: 'metric-note', style: 'margin-top:10px' },
        timings.usedThoroughCleanup
          ? 'The AI cleanup pass beat its deadline and its answer was used.'
          : 'The deterministic cleanup shipped — either nothing needed the model, or it missed its deadline.')));

    detail.appendChild(card(
      h('div', { class: 'eyebrow' }, 'Recorded'),
      h('div', {}, new Date(record.date).toLocaleString()),
      h('div', { class: 'metric-note' },
        record.inputDevice ? `Microphone: ${record.inputDevice}` : 'Microphone: system default')));
  };

  /// The editor sheet, then — if the fix suggests words the Dictionary should
  /// know — a second sheet that asks, because a wrong term biases every future
  /// dictation towards a mistake.
  const openCorrection = (record: WireRecord): void => {
    const field = h('textarea', { class: 'field', rows: 6, spellcheck: true });
    field.value = record.correctedText ?? record.insertedText;
    openSheet({
      title: 'Correct this dictation',
      body: h('div', {},
        h('div', { class: 'metric-note', style: 'margin-bottom:8px' },
          'What Quill typed. Change it to what you meant.'),
        field),
      confirm: 'Save correction',
      run: async () => {
        const text = field.value.trim();
        if (text.length === 0) return false;
        const outcome = await api.history.correct(record.id, text);
        if (!outcome) { toast('Nothing changed.'); return true; }
        record.correctedText = outcome.now;
        drawDetail();
        toast('Saved. Quill learned from that.');
        if (outcome.dictionaryCandidates.length > 0) {
          // After this sheet finishes closing, or its own close would take the
          // next one with it.
          window.setTimeout(() => offerDictionaryTerms(outcome.dictionaryCandidates), 0);
        }
        return true;
      },
    });
  };

  const offerDictionaryTerms = (candidates: string[]): void => {
    const chosen = new Set(candidates);
    const rows = candidates.map((term) => {
      const box = h('input', { type: 'checkbox' });
      box.checked = true;
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(term); else chosen.delete(term);
      });
      return h('label', { class: 'row', style: 'display:flex;gap:10px;align-items:center' },
        box, h('span', { class: 'grow' }, term));
    });
    openSheet({
      title: 'Add to your Dictionary?',
      body: h('div', {},
        h('p', { class: 'muted' },
          'These looked like words the recogniser had no reason to know. In the Dictionary they '
          + 'change what Quill hears, so it comes out right next time. Untick any that are not '
          + 'worth remembering.'),
        ...rows),
      confirm: 'Add selected',
      cancel: 'Not now',
      run: async () => {
        let added = 0;
        for (const term of chosen) if (await api.vocabulary.add(term)) added += 1;
        if (added > 0) toast(`Added ${added} ${added === 1 ? 'word' : 'words'} to the Dictionary.`);
        return true;
      },
    });
  };

  drawList();
  drawDetail();
}

function summaryLine(record: WireRecord): string {
  const parts: string[] = [`${record.wordCount} ${record.wordCount === 1 ? 'word' : 'words'}`];
  if (record.timings.audioDurationMs !== null) {
    parts.push(`${(record.timings.audioDurationMs / 1000).toFixed(2)} s`);
  }
  parts.push(record.timings.usedThoroughCleanup ? 'AI cleanup' : 'clean');
  parts.push(relativeTime(record.date));
  return parts.join(' · ');
}

function timingRows(rows: [string, number | null][]): HTMLElement {
  const wrap = h('div', { style: 'display:grid;gap:6px;margin-top:8px' });
  for (const [label, value] of rows) {
    wrap.appendChild(h('div', { style: 'display:flex;justify-content:space-between;gap:12px' },
      h('span', { class: 'muted tiny' }, label),
      h('span', { class: 'mono tiny' }, value === null ? '—' : `${value} ms`)));
  }
  return wrap;
}

export function dictationHint(holdKeyDisplay: string): HTMLElement {
  return h('div', { class: 'muted tiny' },
    'Hold ', keycap(holdKeyDisplay), ' and speak. Double-tap it for hands-free.');
}
