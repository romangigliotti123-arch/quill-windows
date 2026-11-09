#!/usr/bin/env node
// Does this machine turn audio into words? One command, no microphone.
//
//   npm run check:speech [-- path/to/clip.wav]
//
// Runs the REAL speech path — model download, the model proxy, WebGPU or
// WebAssembly, the model itself — over a WAV file and prints what came out.
// Exits non-zero when nothing came back, which is the only way every failure in
// that chain ends (a model that would not load, a proxy that 404s, a decoder the
// runtime cannot build a session for). The first run downloads the model, which
// for the default large-v3-turbo is about 1.6 GB; later runs read it from the
// cache in %APPDATA%\Quill\models.
//
// Uses a scratch data directory, never the real one: a check that writes into
// somebody's dictation history changes the thing it is measuring.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clip = resolve(process.argv[2] ?? join(root, 'tests', 'fixtures', 'speech-check.wav'));
if (!existsSync(clip)) {
  console.error(`No audio file at ${clip}`);
  process.exit(1);
}
if (!existsSync(join(root, 'dist', 'main', 'main.js'))) {
  console.error('Run `npm run build` first.');
  process.exit(1);
}

// The data directory is scratch, but the MODEL cache normally lives inside the
// real one — a scratch directory per run would re-download 1.6 GB every time. So
// the models folder is pointed at the real location (or QUILL_MODEL_DIR).
const scratch = mkdtempSync(join(tmpdir(), 'quill-check-'));
const realData = process.platform === 'win32'
  ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Quill')
  : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Quill')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'quill');
const models = process.env.QUILL_MODEL_DIR ?? join(realData, 'models');
const electron = createRequire(import.meta.url)('electron');

console.log(`==> Transcribing ${clip}`);
const result = spawnSync(electron, [root], {
  stdio: 'inherit',
  env: {
    ...process.env,
    QUILL_TRANSCRIBE: clip,
    QUILL_DATA_DIR: process.env.QUILL_DATA_DIR ?? scratch,
    QUILL_MODEL_DIR: models,
  },
});
process.exit(result.status ?? 1);
