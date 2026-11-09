import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteStore, makeNote, noteDisplayTitle, noteIsBlank } from '../src/core/stores/notes';

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), 'quill-notes-')), 'notes.json');
}

test('a fresh store is empty', () => {
  const store = new NoteStore(scratch());
  assert.equal(store.isEmpty, true);
  assert.deepEqual(store.all, []);
});

test('upsert adds, then updates the same note', () => {
  const store = new NoteStore(scratch());

  const created = store.upsert(makeNote({ title: 'Groceries', body: 'Milk' }));
  assert.equal(store.all.length, 1);

  const updated = store.upsert({ ...created, body: 'Milk, eggs' });
  assert.equal(store.all.length, 1, 'a second upsert of the same id updated in place rather than duplicating');
  assert.equal(updated.body, 'Milk, eggs');
});

test('upsert stamps updated regardless of what the caller passed in', () => {
  const store = new NoteStore(scratch());
  const stale = makeNote({ title: 'x', body: 'y', updated: new Date(0) });
  const saved = store.upsert(stale);
  assert.ok(saved.updated.getTime() > 0,
    "the store's own clock decides `updated`, not whatever the caller had lying around");
});

test('remove deletes exactly that note', () => {
  const store = new NoteStore(scratch());
  const a = store.upsert(makeNote({ title: 'A' }));
  const b = store.upsert(makeNote({ title: 'B' }));
  store.remove(a.id);
  assert.deepEqual(store.all.map((note) => note.id), [b.id]);
  assert.equal(store.note(a.id), null);
  assert.equal(store.note(b.id)?.title, 'B');
});

test('the earlier build\'s delete name still works', () => {
  const store = new NoteStore(scratch());
  const a = store.upsert(makeNote({ title: 'A' }));
  store.delete(a.id);
  assert.equal(store.isEmpty, true);
});

test('ordered is most recently edited first', async () => {
  const store = new NoteStore(scratch());
  const older = store.upsert(makeNote({ title: 'older' }));
  // A real clock tick between the two upserts, so `updated` genuinely differs.
  await new Promise((resolve) => setTimeout(resolve, 15));
  const newer = store.upsert(makeNote({ title: 'newer' }));
  assert.deepEqual(store.ordered.map((note) => note.id), [newer.id, older.id]);
  // `all` is not reordered by asking for `ordered`.
  assert.deepEqual(store.all.map((note) => note.id), [older.id, newer.id]);
});

test('persists across instances of the same file', () => {
  const path = scratch();
  new NoteStore(path).upsert(makeNote({ title: 'Survives a relaunch', body: 'Because it went to disk' }));

  const second = new NoteStore(path);
  assert.equal(second.all.length, 1);
  assert.equal(second.all[0]!.title, 'Survives a relaunch');
});

test('a damaged file is not treated as empty', () => {
  // Same rule as every other store here — see `readStoreFile`: a file that
  // exists but will not decode is NOT zero notes, and the next write must not be
  // allowed to overwrite it with `[]`.
  const path = scratch();
  writeFileSync(path, 'not json');

  const store = new NoteStore(path);
  assert.deepEqual(store.all, [], 'nothing decodable, so nothing in memory');
  store.upsert(makeNote({ title: 'should not be written' }));
  assert.equal(readFileSync(path, 'utf8'), 'not json', 'a damaged file must never be silently overwritten');
});

test('an in-memory store never touches disk and does not alias its input', () => {
  const seed = makeNote({ title: 'kept' });
  const store = NoteStore.inMemory([seed]);
  store.upsert({ ...seed, title: 'changed' });
  assert.equal(seed.title, 'kept');
  assert.equal(store.all[0]!.title, 'changed');
});

// MARK: - Note itself

test('displayTitle falls back to the first line of the body', () => {
  assert.equal(noteDisplayTitle(makeNote({ title: '', body: 'Call the vet\nabout the appointment' })),
    'Call the vet');
});

test('displayTitle is "Untitled note" when there is nothing at all', () => {
  assert.equal(noteDisplayTitle(makeNote({ title: '', body: '' })), 'Untitled note');
  assert.equal(noteDisplayTitle(makeNote({ title: '  ', body: '\n \t' })), 'Untitled note');
});

test('displayTitle prefers an actual title over the body', () => {
  assert.equal(noteDisplayTitle(makeNote({ title: 'Groceries', body: 'Milk, eggs' })), 'Groceries');
});

test('isBlank ignores whitespace only', () => {
  assert.equal(noteIsBlank(makeNote({ title: '  ', body: '\n \t' })), true);
  assert.equal(noteIsBlank(makeNote({ title: '', body: 'x' })), false);
  assert.equal(noteIsBlank(makeNote({ title: 'x', body: '' })), false);
});

test('a note\'s dates round-trip through disk', () => {
  const path = scratch();
  const created = new Date('2026-08-23T09:00:21Z');
  const store = new NoteStore(path);
  store.upsert(makeNote({ id: 'fixed-id', title: 't', created }));
  const back = new NoteStore(path).note('fixed-id')!;
  assert.equal(back.created.toISOString(), created.toISOString());
  assert.ok(back.updated.getTime() >= created.getTime());
});
