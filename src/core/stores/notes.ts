import { dataFile, writeAtomic } from '../paths';
import { encodeJSON, fromISO, readStoreFile, toISO, uuid } from './storeFile';
import { trim } from '../text/strings';

/// A named place to dictate into that isn't any particular app — a running
/// list, a set of ideas, a draft that doesn't have a home yet. Deliberately two
/// fields and nothing else: no folders, no tags, no formatting. The ask this
/// answers is "start talking and it's saved somewhere," not a second document
/// editor living inside a dictation app.
export interface Note {
  id: string;
  title: string;
  body: string;
  created: Date;
  updated: Date;
}

export function makeNote(partial: Partial<Note> = {}): Note {
  const now = new Date();
  return {
    id: partial.id ?? uuid(),
    title: partial.title ?? '',
    body: partial.body ?? '',
    created: partial.created ?? now,
    updated: partial.updated ?? now,
  };
}

/// What a list row shows when there's no title yet — the first line of what was
/// actually said, same idea as a Finder icon preview.
export function noteDisplayTitle(note: Note): string {
  const title = trim(note.title);
  if (title.length > 0) return title;
  const firstLine = trim(note.body).split('\n')[0] ?? '';
  return firstLine.length === 0 ? 'Untitled note' : firstLine;
}

export function noteIsBlank(note: Note): boolean {
  return trim(note.title).length === 0 && trim(note.body).length === 0;
}

/// Key by key, so a field added in a future release cannot make every note
/// written before it undecodable. See `history.ts` — the whole array is read at
/// once, so one missing key costs the user every note they have, not one field
/// of one note.
///
/// `updated` also reads the `modified` key an earlier Windows/Linux build wrote
/// for the same thing, so a note from that build keeps its place in the list.
function validate(value: unknown): Note[] | null {
  if (!Array.isArray(value)) return null;
  const out: Note[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const created = fromISO(raw.created) ?? new Date();
    out.push({
      id: typeof raw.id === 'string' ? raw.id : uuid(),
      title: typeof raw.title === 'string' ? raw.title : '',
      body: typeof raw.body === 'string' ? raw.body : '',
      created,
      updated: fromISO(raw.updated) ?? fromISO(raw.modified) ?? created,
    });
  }
  return out;
}

function encode(notes: Note[]): unknown {
  return notes.map((note) => ({
    id: note.id,
    title: note.title,
    body: note.body,
    created: toISO(note.created),
    updated: toISO(note.updated),
  }));
}

/// Disk-backed, same shape as `SnippetStore`: written atomically, injectable
/// with a path so a test never touches the real file.
export class NoteStore {
  private readonly url: string | null;
  private items: Note[] = [];
  /// Set when the file exists and could not be read. While it is true nothing
  /// is written, because the alternative is replacing notes that are probably
  /// still recoverable with the empty list we fell back to.
  private loadFailed = false;

  private static sharedStore: NoteStore | null = null;
  static shared(): NoteStore {
    if (!NoteStore.sharedStore) NoteStore.sharedStore = new NoteStore();
    return NoteStore.sharedStore;
  }

  /// Memory only — for tests and the dashboard preview renderer.
  static inMemory(notes: Note[]): NoteStore {
    const store = new NoteStore(null);
    store.items = notes.map((note) => ({ ...note }));
    return store;
  }

  /// Nothing. A new install has an empty list.
  constructor(url: string | null = dataFile('notes.json')) {
    this.url = url;
    if (!url) return;
    const outcome = readStoreFile(url, validate);
    switch (outcome.kind) {
      case 'missing': this.items = []; break;
      case 'decoded': this.items = outcome.value; break;
      case 'unreadable':
        this.items = [];
        this.loadFailed = true;
        break;
    }
  }

  get all(): Note[] { return this.items.map((note) => ({ ...note })); }
  get isEmpty(): boolean { return this.items.length === 0; }

  /// Most recently edited first — the one you were just talking into is the one
  /// you want back.
  get ordered(): Note[] {
    return this.all.sort((a, b) => b.updated.getTime() - a.updated.getTime());
  }

  /// The store's own clock decides `updated`, not whatever the caller had lying
  /// around.
  upsert(note: Note): Note {
    const stamped: Note = { ...note, updated: new Date() };
    const index = this.items.findIndex((existing) => existing.id === note.id);
    if (index >= 0) this.items[index] = stamped;
    else this.items.push(stamped);
    this.persist();
    return { ...stamped };
  }

  remove(id: string): void {
    this.items = this.items.filter((note) => note.id !== id);
    this.persist();
  }

  /// The name an earlier build's IPC layer calls. `remove` is the macOS name and
  /// the one new code should use.
  delete(id: string): void { this.remove(id); }

  note(id: string): Note | null {
    const found = this.items.find((note) => note.id === id);
    return found ? { ...found } : null;
  }

  private persist(): void {
    if (this.loadFailed || !this.url) return;
    writeAtomic(this.url, encodeJSON(encode(this.items)));
  }
}
