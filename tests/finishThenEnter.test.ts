import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FinishThenEnter, FINISH_THEN_ENTER_WINDOW_MS } from '../src/core/dictation/finishThenEnter';
import { classifyTrigger } from '../src/core/hotkey/binding';

// "Finish, then Enter" — a quick tap right after a dictation sends Return once
// the text has actually landed, never before. These drive the same decision the
// coordinator makes, with a counting Return rather than a real one.

function make(enabled = true) {
  let returns = 0;
  let time = 1_000;
  const gesture = new FinishThenEnter(() => enabled, () => { returns += 1; }, () => time);
  return {
    gesture,
    advance: (ms: number) => { time += ms; },
    get returns() { return returns; },
  };
}

test('a tap right after insertion sends Return exactly once', () => {
  const t = make();
  t.gesture.noteInsertion();
  t.gesture.tap(false);
  assert.equal(t.returns, 1, `one tap sent ${t.returns} Returns`);
  // Nothing left armed to fire a second one.
  t.gesture.fireIfPending();
  assert.equal(t.returns, 1);
});

test('a tap with no dictation before it sends nothing', () => {
  // An ordinary stray tap stays exactly what it already was, a silent no-op,
  // not a stray Return into whatever the user is typing.
  const t = make();
  t.gesture.tap(false);
  assert.equal(t.returns, 0);
  assert.equal(t.gesture.armed, false);
});

test('the setting off means no Return, ever', () => {
  const t = make(false);
  t.gesture.noteInsertion();
  t.gesture.tap(false);
  t.gesture.tap(true);
  t.gesture.noteInsertion();
  assert.equal(t.returns, 0);
});

test('a tap while the dictation is still finalising waits for the text', () => {
  const t = make();
  t.gesture.tap(true);
  assert.equal(t.returns, 0, 'sent Return before the words had landed');
  assert.equal(t.gesture.armed, true);
  t.gesture.noteInsertion();
  assert.equal(t.returns, 1);
});

test('a tap too long after the text landed is left alone', () => {
  const t = make();
  t.gesture.noteInsertion();
  t.advance(FINISH_THEN_ENTER_WINDOW_MS + 1);
  t.gesture.tap(false);
  assert.equal(t.returns, 0);
});

test('a tap armed after insertion but before the finalise exits still fires', () => {
  // The tap lands after `noteInsertion` ran, with the coordinator still
  // finalising; the finalise's own exit has to send it.
  const t = make();
  t.gesture.noteInsertion();
  t.gesture.tap(true);
  assert.equal(t.returns, 0);
  t.gesture.fireIfPending();
  assert.equal(t.returns, 1);
});

test('a second held dictation leaves nothing armed', () => {
  // Holding the key again is an ordinary second dictation, not the tap
  // gesture: it never calls tap(), so no Return is left armed to land in the
  // middle of what the second dictation types.
  const t = make();
  t.gesture.noteInsertion();
  t.gesture.noteInsertion();
  assert.equal(t.returns, 0);
  assert.equal(t.gesture.armed, false);
});

// MARK: - The transform gesture

const ALT_RIGHT = 3640;
const META_LEFT = 3675;
const CTRL_LEFT = 29;
const SHIFT_LEFT = 42;

test('a lone trigger is isolated and is not the transform gesture', () => {
  assert.deepEqual(classifyTrigger(new Set([ALT_RIGHT]), ALT_RIGHT),
    { isolated: true, includesMeta: false });
});

test('trigger plus Meta is the transform gesture', () => {
  assert.deepEqual(classifyTrigger(new Set([ALT_RIGHT, META_LEFT]), ALT_RIGHT),
    { isolated: true, includesMeta: true });
});

test('trigger plus Meta plus anything else is a chord, refused', () => {
  assert.deepEqual(classifyTrigger(new Set([ALT_RIGHT, META_LEFT, SHIFT_LEFT]), ALT_RIGHT),
    { isolated: false, includesMeta: false });
});

test('trigger plus another modifier is a chord, refused', () => {
  assert.deepEqual(classifyTrigger(new Set([ALT_RIGHT, CTRL_LEFT]), ALT_RIGHT),
    { isolated: false, includesMeta: false });
});

test('when Meta is the hold key, "plus Meta" means nothing', () => {
  assert.deepEqual(classifyTrigger(new Set([META_LEFT, 3676]), META_LEFT),
    { isolated: false, includesMeta: false });
  assert.deepEqual(classifyTrigger(new Set([META_LEFT]), META_LEFT),
    { isolated: true, includesMeta: false });
});

test('non-modifier keys held down do not make a trigger non-isolated', () => {
  assert.deepEqual(classifyTrigger(new Set([ALT_RIGHT, 30]), ALT_RIGHT),
    { isolated: true, includesMeta: false });
});
