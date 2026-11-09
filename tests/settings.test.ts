import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuillSettings, defaultSettings } from '../src/core/settings';

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), 'quill-settings-')), 'settings.json');
}

test('the default speech model is large-v3-turbo', () => {
  assert.equal(defaultSettings().speechModel, 'onnx-community/whisper-large-v3-turbo');
});

test('the always-on bar, finish-then-enter and learning are on by default', () => {
  const d = defaultSettings();
  assert.equal(d.overlayBarEnabled, true);
  assert.equal(d.overlayBarPosition, 'bottomLeft');
  assert.equal(d.overlayShowsNewNoteButton, true);
  assert.equal(d.finishThenEnterEnabled, true);
  assert.equal(d.learnFromEdits, true);
  assert.equal(d.lastLaunchedVersion, null);
});

test('a chosen microphone survives a restart', () => {
  // The nullable string fields default to null, whose typeof is "object". A
  // typeof comparison against the default threw every stored string away.
  const path = scratch();
  const first = new QuillSettings(path);
  first.set('inputDeviceId', 'abc123');
  first.set('inputDeviceLabel', 'USB microphone');
  const second = new QuillSettings(path);
  assert.equal(second.inputDeviceId, 'abc123');
  assert.equal(second.current.inputDeviceLabel, 'USB microphone');
});

test('markConfigured creates the file even when nothing changed', () => {
  const path = scratch();
  const settings = new QuillSettings(path);
  assert.equal(existsSync(path), false);
  settings.set('numberStyle', settings.numberStyle); // a no-op, which update() swallows
  assert.equal(existsSync(path), false);
  settings.markConfigured();
  assert.equal(existsSync(path), true);
});

test('noteLaunch answers what the previous version was', () => {
  const path = scratch();
  const settings = new QuillSettings(path);
  assert.equal(settings.noteLaunch('1.3.2'), null);
  assert.equal(settings.noteLaunch('1.3.2'), '1.3.2');
  assert.equal(settings.noteLaunch('1.4.0'), '1.3.2');
  assert.equal(new QuillSettings(path).lastLaunchedVersion, '1.4.0');
});

test('an unreadable settings file is kept and never written over', () => {
  const path = scratch();
  const junk = '{ "holdKey": "AltRight", ';
  writeFileSync(path, junk);
  const settings = new QuillSettings(path);
  // The app still runs, on defaults in memory.
  assert.equal(settings.holdKey, 'AltRight');
  settings.set('numberStyle', 'alwaysDigits');
  settings.markConfigured();
  assert.equal(readFileSync(path, 'utf8'), junk);
  const dir = readdirSync(join(path, '..'));
  assert.ok(dir.some((name) => name.startsWith('settings.json.unreadable-')));
});

test('an unknown overlay position falls back to the default', () => {
  const path = scratch();
  writeFileSync(path, JSON.stringify({ overlayBarPosition: 'middleOfTheScreen' }));
  assert.equal(new QuillSettings(path).overlayBarPosition, 'bottomLeft');
});

// MARK: - Overlay bar placement

import { BAR_METRICS, anchorFor, barOrigin } from '../src/core/overlayBar';

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

test('the bar docks to the edge it was told to', () => {
  const left = barOrigin(AREA, 'bottomLeft');
  const right = barOrigin(AREA, 'bottomRight');
  const centre = barOrigin(AREA, 'bottomCenter');
  assert.equal(left.x, BAR_METRICS.edgeGap);
  assert.equal(right.x, 1920 - BAR_METRICS.panelWidth - BAR_METRICS.edgeGap);
  assert.equal(centre.x, Math.round((1920 - BAR_METRICS.panelWidth) / 2));
  assert.equal(left.y, 1040 - BAR_METRICS.panelHeight - BAR_METRICS.edgeGap);
  assert.equal(barOrigin(AREA, 'topLeft').y, BAR_METRICS.edgeGap);
});

test('a second display with an offset work area is respected', () => {
  const second = { x: 1920, y: 0, width: 2560, height: 1400 };
  assert.equal(barOrigin(second, 'bottomLeft').x, 1920 + BAR_METRICS.edgeGap);
});

test('the pill grows away from the screen edge it is docked to', () => {
  assert.equal(anchorFor('bottomLeft'), 'left');
  assert.equal(anchorFor('topLeft'), 'left');
  assert.equal(anchorFor('bottomRight'), 'right');
  assert.equal(anchorFor('topRight'), 'right');
  assert.equal(anchorFor('bottomCenter'), 'center');
});

test('the panel is sized for the widest the pill can ever be', () => {
  assert.equal(BAR_METRICS.maxExpandedWidth, BAR_METRICS.expandedWidth + BAR_METRICS.secondSegmentWidth);
  assert.equal(BAR_METRICS.panelWidth, BAR_METRICS.maxExpandedWidth + 32);
});

import { bubbleOrigin, NOTE_BUBBLE } from '../src/core/overlayBar';

test('the note bubble opens above a bottom-docked bar', () => {
  const pill = { x: 30, y: 960, width: 224, height: 36 };
  const origin = bubbleOrigin(pill, AREA);
  assert.equal(origin.y, 960 - NOTE_BUBBLE.gap - NOTE_BUBBLE.height);
});

test('the note bubble opens below a top-docked bar, where there is no room above', () => {
  const pill = { x: 30, y: 30, width: 224, height: 36 };
  const origin = bubbleOrigin(pill, AREA);
  assert.equal(origin.y, 30 + 36 + NOTE_BUBBLE.gap);
});

test('the note bubble is kept on the screen', () => {
  const pill = { x: 0, y: 960, width: 36, height: 36 };
  assert.ok(bubbleOrigin(pill, AREA).x >= NOTE_BUBBLE.gap);
  const right = { x: 1900, y: 960, width: 36, height: 36 };
  assert.ok(bubbleOrigin(right, AREA).x + NOTE_BUBBLE.width <= 1920 - NOTE_BUBBLE.gap);
});
