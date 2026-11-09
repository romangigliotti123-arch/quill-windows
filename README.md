# Quill for Windows

Dictation that runs on your PC. Hold a key, speak, let go — the words land wherever your caret already is: a terminal, a chat box, a form field, whatever you were about to type into.

This is **Quill for macOS v1.3.2 translated to Windows**. Same app, same behaviour, same thresholds, same AI cleanup model — rebuilt on Electron + TypeScript because Swift, AppKit and Apple's speech framework do not exist on Windows. Everything that is macOS-only was replaced rather than stubbed out; the table below says exactly what replaced what.

- **Speech model: Whisper large-v3-turbo**, running on your GPU through WebGPU (it falls back to Whisper Base on the CPU if the machine has no usable GPU — see [the speech model](#the-speech-model)).
- **AI cleanup model: `meta/llama-3.1-8b-instruct` on NVIDIA NIM** — the same model, endpoint, temperature and token limit as the Mac app. Optional; off until you add a free key.
- **547 automated tests**, no Electron needed to run them. CI builds the Windows installer on a real Windows runner on every push.

Upstream (macOS): <https://github.com/romangigliotti123-arch/quill> · License: MIT

---

## Setup for an AI agent (do exactly this)

If you are an agent that was handed this repository, this section is your whole job. Everything below works from a plain PowerShell prompt on Windows 10/11. Nothing needs a compiler or Visual Studio — the one native module (`uiohook-napi`) ships prebuilt binaries for `win32-x64` and `win32-arm64`.

### 0. Prerequisites

| Need | Check | Install if missing |
|---|---|---|
| Windows 10 (1903+) or 11, x64 or arm64 | `winver` | — |
| Git | `git --version` | `winget install --id Git.Git -e` |
| Node.js **22 or newer** (with npm) | `node --version` | `winget install --id OpenJS.NodeJS.LTS -e` |
| Internet, for `npm ci` and the first-run model download | — | — |
| A GPU with DirectX 12 drivers, for the default model | Task Manager ▸ Performance | Update the GPU driver. Without one, Quill uses Whisper Base on the CPU automatically. |

Open a **new** terminal after installing Git or Node so `PATH` is refreshed.

### 1. Get it and verify the code

```powershell
git clone https://github.com/romangigliotti123-arch/quill-windows.git
cd quill-windows
npm ci
npm run typecheck
npm test
```

**Expected:** `npm ci` finishes without errors (warnings about install scripts are normal). `npm run typecheck` prints nothing after the command echo. `npm test` ends with `ℹ tests 547`, `ℹ pass 547`, `ℹ fail 0`.

If `npm test` shows a failure, stop and report the failing test name — do not continue to the build.

### 2. Run it

```powershell
npm start        # builds, then launches Quill
```

**Expected:** a Quill window opens (first run shows a four-step welcome), a small pill appears at the bottom-left of the screen, and a tray icon appears (Windows may hide it in the `^` overflow chevron — drag it out to keep it visible). Hold **Right Alt**, speak, let go — the text appears in whichever app has focus.

`npm run dev` is the same but forces the dashboard open.

### 3. Build the installer

```powershell
npm run dist:win
```

**Expected:** `release\` contains an NSIS installer (`Quill Setup 1.3.2.exe`, about 224 MB, x64 and arm64 in one) and a portable executable (`Quill-1.3.2-portable.exe`, about 116 MB, x64). CI builds exactly these on every push; download them from the latest run's **Artifacts** on the Actions tab if you do not want to build. Both are **unsigned**, so Windows SmartScreen shows "Windows protected your PC" on first run — click **More info ▸ Run anyway**. That warning is honest: there is no code-signing certificate, and buying one is a yearly cost left to whoever ships this.

The installer is per-user (no admin prompt) and installs to `%LOCALAPPDATA%\Programs\Quill`.

### 4. Prove the speech path works on this machine (no microphone needed)

```powershell
npm run check:speech
```

This runs the real speech engine — model download, the local model proxy, WebGPU or WebAssembly, the model itself — over the bundled clip `tests\fixtures\speech-check.wav`, prints the transcript, and **exits non-zero if nothing came back**. The first run downloads the model (about **1.6 GB** for the default), which takes a while and is cached in `%APPDATA%\Quill\models` afterwards.

Transcribe your own file instead:

```powershell
npm run check:speech -- C:\path\to\clip.wav
```

### 5. Optional extras

```powershell
# AI cleanup (free key from https://build.nvidia.com/)
Set-Content -Path "$env:APPDATA\Quill\nim-key.txt" -Value 'nvapi-...'   # or: $env:QUILL_NIM_API_KEY = 'nvapi-...'
```

The MCP server (lets Claude read how you write) and the optional account/sync are set up from inside the app — **MCP** and **Account** tabs — and both print the exact commands for this machine. See [MCP](#mcp-claude-can-write-like-you) and [Account](#the-optional-account).

### 6. Report back

State plainly: which of steps 1–4 passed (with the test count and the transcript from step 4), and anything that failed with its full error text. Do not describe step 4 as passing unless it printed a transcript and exited 0.

---

## What it does

- **Push to talk.** Hold Right Alt and speak. Double-tap it for hands-free; tap it once to stop. Or use the **bar** — a small pill docked to a screen edge that widens on hover to a click-to-dictate button.
- **Cleans up as it goes.** Punctuation, capitalisation, filler words, repeated words ("the the"), spoken numbers written the way you choose, spoken email addresses — all offline, in milliseconds.
- **Terminals ask the words, not the window.** A shell command stays lowercase with no full stop; a sentence typed into the same terminal keeps its capital and full stop. Quill classifies the utterance, not the app.
- **Spoken self-correction.** *"Send it to Noah, no wait, send it to Carlo"* types only Carlo — offline for the clear cases, with the model for the tangled ones.
- **Finish, then Enter.** Release the key, tap it again right away, and Quill sends Return once your words have actually landed — never before.
- **Takes it back.** `Ctrl + Alt + Z` deletes exactly what Quill inserted, after checking it is still there.
- **Learns your words.** Names, tools and jargon go in the Dictionary and bias what the speech model *hears*. The **Correct** button on any dictation teaches the style profile and offers new Dictionary words (never added silently).
- **Learns from what you change.** After a dictation Quill watches only the sentence it inserted and learns from your edits. Off with one switch.
- **Snippets and transforms.** Say a phrase to expand a snippet. Hold the dictation key **plus the Windows key** and say "make that a bullet list" to reshape what you just dictated. The extra modifier is deliberate — plain dictation can never run a transform by accident just because a sentence happened to contain the words.
- **Notes.** Dictate into a note directly, or click **Note** on the bar to catch a thought in a floating bubble that saves itself.
- **Style export.** One button copies your writing voice as a plain document to hand to another AI.
- **An optional account.** Sync history, Dictionary, snippets, transforms, learned style and your AI key to another computer — including a Mac — and unlock MCP.

### Keys and shortcuts

| | |
|---|---|
| **Right Alt** (hold) | Dictate. Change it in Settings; only a bare modifier can be the dictation key. |
| **Right Alt** (double-tap) | Hands-free; tap once to stop |
| **Right Alt + Windows key** (hold) | Dictate, with voice transforms allowed |
| **Right Alt**, released then tapped | Finish, then press Enter |
| **Esc** | Cancel the dictation and take back anything already typed |
| **Ctrl + Alt + Z** | Take back the last thing Quill inserted |
| **Ctrl + Alt + Q** | Open the dashboard (a way in when the tray icon is hidden) |

> **European keyboard layouts:** Right Alt is **AltGr** there and types characters. Pick **Right Control** as the dictation key in Settings.

---

## The speech model

Apple's `SpeechAnalyzer` (what the Mac app uses) is built into macOS and **cannot run on Windows**, so the speech model is the one thing that cannot be identical. Quill for Windows uses OpenAI's Whisper, run locally through [`@huggingface/transformers`](https://github.com/huggingface/transformers.js):

| Model | Download | Notes |
|---|---|---|
| **`whisper-large-v3-turbo`** (default) | ~1.6 GB | Best accuracy. A **GPU model**: WebGPU, encoder `fp16` + decoder `q4`. |
| `whisper-small.en` | ~250 MB | More accurate than Base, slower |
| `whisper-base.en` | ~80 MB | Fast on any CPU. What the default steps down to without a GPU. |
| `whisper-tiny.en` | ~40 MB | Fastest, least accurate |

Choose in **Settings ▸ Speech model**. Models are downloaded once from Hugging Face by Quill's main process and cached in `%APPDATA%\Quill\models`; after that everything is offline.

**Automatic step-down.** Large v3 turbo on a CPU would take roughly ten times longer than real time. If the GPU switch is off, or WebGPU cannot start on this machine, Quill loads Whisper Base instead and says so in Settings and Help — the dictation key never silently turns into a minute-long wait.

Whisper is a batch model, not a streaming one, so Quill re-transcribes the whole buffer about every 900 ms to produce live partial text. That gives the live typer exactly the contract it was written against on the Mac.

### Choosing a model for your GPU (RTX 4060 Ti, 8 GB)

**Stay on the default, `whisper-large-v3-turbo`.** It is the closest match to the Mac, and an 8 GB card runs it with room to spare.

- **Accuracy.** The Mac app scored 2.37–2.81% word error rate on the 50-clip LibriSpeech corpus in its own head-to-head (Wispr Flow: 2.11%). Published LibriSpeech-clean figures put large-v3-turbo at about 1.9–2.0% and distil-large-v3 at about 2.4–2.5% ([WhisperKit's evaluation table](https://huggingface.co/argmaxinc/whisperkit-coreml/blob/20f51f218879660aa966596dfe336a762249abe8/README.md), [a faster-whisper benchmark](https://vexascribe.com/whisper-large-v3-vs-turbo); different tools and splits, so read them as a range, not a ranking to the decimal). Nothing smaller than the large family is in the Mac's accuracy class, and turbo is the most accurate of them.
- **Memory.** The files that load on the GPU are a 1.27 GB fp16 encoder and a 0.33 GB q4 decoder. Even with working memory on top, that is a few GB of the card's 8 — an estimate, not a measurement; the check below shows whether it loads.
- **Why not distil-large-v3.** It keeps the same 32-layer encoder, which is where the time goes for short dictations, so it would be no faster here and a little less accurate.
- **Speed is the one thing nobody has published for this exact setup** (Whisper through WebGPU on a 4060 Ti), so measure it instead of trusting a guess:

```powershell
$env:QUILL_TRANSCRIBE_RUNS = 5          # transcribe the clip five times
npm run check:speech                    # look at "runMs" in the output
```

The **first** number in `runMs` includes loading the model and the GPU compiling its shaders. The **later** ones are what a real dictation costs after you let go — that is the figure to compare against how the Mac feels. As a rule of thumb, if the steady-state time on a short clip is well over a second, step down; to compare another model on the same card without touching your settings:

```powershell
$env:QUILL_SPEECH_MODEL = 'onnx-community/whisper-small.en'
npm run check:speech
```

`whisper-small.en` is the next rung down: clearly faster, clearly less accurate than the Mac. Pick it only if turbo's measured speed is not good enough for you.

### The AI cleanup model (identical to the Mac)

| | |
|---|---|
| Provider | NVIDIA NIM, OpenAI-compatible: `https://integrate.api.nvidia.com/v1` |
| Model | `meta/llama-3.1-8b-instruct` |
| Temperature / max tokens | `0` / `160` |
| Deadline | 450 ms for the dictation path — if the model is slower, the deterministic result ships instead and you lose nothing but the deadline |
| Key | Free from <https://build.nvidia.com/>. `%APPDATA%\Quill\nim-key.txt`, or `QUILL_NIM_API_KEY` (takes precedence). Paste it in Settings; it takes effect immediately. |

Only the sentence being worked on is ever sent, and only when a key is set. Without a key every other feature works; only the model-backed transforms (Shorter, Summarise, More casual, Email) and the tangled self-corrections are unavailable.

---

## MCP: Claude can write like you

Quill includes a small, dependency-free MCP server (`dist\mcp\quill-mcp.js`) that exposes one tool, `get_writing_voice`: your learned writing patterns plus real excerpts of what you have dictated. It needs the optional account (sign in first).

The **MCP** tab in the dashboard prints, for this machine's real paths:

- a `claude mcp add quill …` command for Claude Code,
- the JSON to merge into `%APPDATA%\Claude\claude_desktop_config.json` for Claude Desktop,
- a prompt you can paste into Claude so it connects itself.

From a source checkout the server is simply:

```powershell
node dist\mcp\quill-mcp.js        # speaks MCP over stdio
```

In an installed build it runs on Quill's own executable with `ELECTRON_RUN_AS_NODE=1`, so nothing else needs to be installed. Smoke test:

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | node dist\mcp\quill-mcp.js
```

## The optional account

Everything works with no account. Signing in (Account tab) makes Quill sync six things with Firestore — dictation history, Dictionary, snippets, transforms, learned style, and your AI key — to any other machine signed into the same account, Mac or Windows. It uses **the same Firebase project and data layout as the macOS app**, so the two interoperate. Nothing is sent until you sign in. Sign-in tokens are sealed with Windows DPAPI (Electron `safeStorage`) when available.

The Firebase web API key in `src/core/account/firebaseConfig.ts` (and `firebase/GoogleService-Info.plist`) is a public client identifier, not a secret — it is the same one the public macOS repository already ships; access is enforced by `firebase/firestore.rules`.

---

## What replaced what (macOS → Windows)

| macOS | Windows | Cost of the substitution |
|---|---|---|
| `SpeechAnalyzer` (streaming, built in) | Whisper via `@huggingface/transformers`, WebGPU with CPU fallback | A one-time model download; partials come from re-transcribing the buffer |
| `NSStatusItem` | Electron `Tray` | Windows hides new tray icons in the `^` overflow, so the tray is a convenience — `Ctrl+Alt+Q` and the bar are the other ways in |
| `CGEventTap` | `uiohook-napi` (optional dependency with prebuilt binaries) | If it will not load, Quill still runs: the dashboard and global shortcuts work; only hold-to-talk is missing |
| `CGEventKeyboardSetUnicodeString` | Clipboard + synthetic `Ctrl+V` | The clipboard is borrowed for a few milliseconds and restored exactly |
| `AXUIElement` / `NSWorkspace` | PowerShell: active-window tracking and UI Automation text reading | Used to tell a terminal from a text field and to read the sentence being edited. When it cannot tell, text is formatted as prose |
| `NSSpellChecker` | A bundled 1.2M-word list | Deterministic across machines |
| ⌘ (transform gesture) | Windows key | Same gesture shape |
| Overlay `NSPanel`s | Frameless transparent `BrowserWindow`s (`focusable: false` so a click never steals the caret) | — |
| Codesign / TCC permissions | Nothing to grant: the keyboard hook needs no permission; Windows prompts for the microphone itself | — |
| `NSAlert` + Trash uninstall | Runs the NSIS uninstaller after erasing data (refuses, and erases nothing, for portable/dev builds) | — |

**Ported unchanged (same logic, same measured thresholds, same comments explaining why):** the dictation coordinator, hotkey gesture state machine, fast and AI cleanup passes, vocabulary corrector and homophone guards, self-correction, spoken-email, number styles, command router, transforms, insertion undo, live typer, style learner, correction learning, voice export, account merge and sync engine, MCP protocol.

**Not ported (macOS-only by nature):** the "Has it crashed?" card (reads macOS crash reports), codesign/notarisation scripts, the Wispr Flow accuracy rig under `rig/`, TCC permission screens.

---

## Your data

Everything lives in `%APPDATA%\Quill\` as plain JSON you can read and edit:

| File | Holds |
|---|---|
| `history.json` | every dictation (kept for a month by default; day / week / forever in Settings) |
| `settings.json` | hotkeys, microphone, speech model, toggles |
| `vocabulary.json` | the Dictionary |
| `snippets.json`, `transforms.json`, `notes.json` | exactly what they say |
| `style.json` | the learned writing style — **kept** by "Erase everything" and Uninstall; it has its own **Delete my style** button |
| `nim-key.txt` | the AI key |
| `account.json`, `device.json` | sign-in session and device identity |
| `models\` | downloaded speech models |

A file that exists but cannot be read is **never overwritten**: the store keeps a copy and stops writing, because replacing a damaged-but-recoverable file with defaults is the one unrecoverable mistake. Files are read key by key with defaults for anything absent, so a field added in a later version never makes older records undecodable (`tests/upgradeSurvival.test.ts` holds the exact bytes of earlier formats).

**Settings ▸ Your data ▸ Erase everything** resets the app to day one. **Settings ▸ About ▸ Uninstall** erases and runs the uninstaller.

### Environment variables

| Variable | Effect |
|---|---|
| `QUILL_DATA_DIR` | Use another data folder (for tests, screenshots, a second profile) |
| `QUILL_NIM_API_KEY` | AI key; takes precedence over the file |
| `QUILL_MODEL_DIR` | Keep the downloaded models somewhere else |
| `QUILL_SPEECH_MODEL` | Use this speech model for one run, ignoring the setting (e.g. `onnx-community/whisper-small.en`) |
| `QUILL_TRANSCRIBE_RUNS=N` | With `QUILL_TRANSCRIBE`, transcribe the file N times and report each run's time in `runMs` |
| `QUILL_TRANSCRIBE=<file.wav>` | Transcribe that file with the real speech path, print it, exit non-zero if empty |
| `QUILL_DTYPE=<json>` | Override the model weights, e.g. `{"encoder_model":"fp32","decoder_model_merged":"q4"}` |
| `QUILL_SETTINGS_FILE`, `QUILL_HISTORY_FILE`, `QUILL_VOCABULARY_FILE` | Point one store at a scratch file |
| `QUILL_PROBE=<js>`, `QUILL_CAPTURE=<dir>` | Evaluate an expression in the dashboard / render every screen to PNGs |
| `QUILL_PROXY_LOG` | Trace every model request (`QUILL_PROXY_LOG=1`) |

---

## Commands

```powershell
npm ci                 # install exactly what package-lock.json says
npm start              # build + launch
npm run dev            # same, with the dashboard open
npm test               # 547 tests, ~1 s, no Electron
npm run typecheck      # tsc --noEmit
npm run build          # bundle into dist\ without launching
npm run check:speech   # transcribe a WAV with the real engine
npm run dist:win       # unsigned NSIS installer + portable exe in release\
npm run words          # regenerate the bundled word list
```

## Repo layout

```
src/core/        everything pure — no Electron — so it is all unit-tested
  cleanup/ ai/ style/ stores/ transforms/ hotkey/ account/ insights/ text/ dictation/
src/main/        Electron main process: hotkey engine, speech engine, dictation coordinator,
                 insertion, windows (dashboard, HUD, bar, note bubble), tray, IPC, account service
src/mcp/         the stdio MCP server (separate bundle, no dependencies)
src/preload/     the narrow doors each window is allowed through
src/renderer/    dashboard, HUD, bar, note bubble, and the hidden speech window
tests/           node:test suites over src/core (+ fixtures\speech-check.wav)
scripts/         build, icon, word list, speech check
firebase/        Firestore rules and config, byte-identical to the macOS repo
.github/         CI (Windows + Linux) and the release workflow
```

`src/main/main.ts` is the only file that knows about every subsystem; everything else is constructed once and handed what it needs.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Holding the key does nothing | The keyboard hook did not load. The **Help** tab runs diagnostics and says why. Start dictation from the bar or the tray meanwhile. |
| "Push-to-talk is unavailable" | `uiohook-napi` is an optional dependency; reinstall with `npm ci` (no `--omit=optional`). |
| AltGr characters appear / key types symbols | European layout: choose Right Control in Settings. |
| Text goes to the clipboard instead of the app | The target blocked synthetic paste (an elevated app: Quill cannot type into an app running as administrator unless Quill is too). |
| First dictation is slow | The model is still downloading — see the percentage in the sidebar. Use `npm run check:speech` to prime the cache. |
| "Large v3 turbo needs a GPU and none is available" | WebGPU could not start; Base was loaded instead. Update the GPU driver, or pick Base deliberately to silence it. |
| SmartScreen warning on the installer | Expected: the build is unsigned. More info ▸ Run anyway. |
| Tray icon missing | Windows hid it. Click `^` in the taskbar and drag it out, or use `Ctrl+Alt+Q`. |

## What has and has not been verified

Be honest with whoever you hand this to:

- **Verified:** on a real `windows-latest` GitHub runner, every push: `npm ci`, type-check, all 547 tests, the bundle, and the unsigned installer + portable exe (the first run of that caught a CRLF bug in the homophone-table parser that only Windows checkouts trigger — fixed, with a regression test). Also checked during development: the MCP server answers `initialize` / `tools/list`, and the bar, first-run setup, Notes and Settings screens render correctly in a browser harness.
- **Not verified on real Windows hardware by the person who made this port** (it was developed on a Mac): hold-to-talk through the real keyboard hook, WebGPU transcription with large-v3-turbo, the UI Automation reader behind "learn from what you change", the active-window tracker, and the NSIS uninstall path. Step 4 above (`npm run check:speech`) and a manual dictation are the acceptance test for the first two; if any of them fails, the error text is what to report.
- The `fp16`-encoder / `q4`-decoder weights for large-v3-turbo are the combination the transformers.js library uses for this exact model on WebGPU; they were not benchmarked here. `QUILL_DTYPE` overrides them.

## Licence

MIT. See [LICENSE](LICENSE). Quill for macOS and this Windows port are by Roman Gigliotti.
