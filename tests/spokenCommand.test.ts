import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCommand } from '../src/core/cleanup/spokenCommand';
import {
  applyAppContext, capitalisesSentencesFor, keepsTrailingFullStopFor,
} from '../src/core/cleanup/appContext';

// Roman dictates into Ghostty all day, because that is where Claude Code lives.
//
// `AppContext.terminal` switched off sentence casing and the trailing full stop
// on the reasoning that `Git status.` is not a command. Correct about commands,
// and wrong about the place: **of 85 real dictations in his history, 85 were
// English prose and 0 were shell commands**, and running the old rule over them
// stripped the opening capital from 76 and the closing full stop from 71.
//
// The sentences below are written for this test rather than taken from his
// history — the measurement used the real thing, but his dictations are not
// going in a public repository.

/// The expensive direction. A missing capital is invisible while you speak and
/// arrives in front of whoever you are writing to; an unwanted one on a command
/// is a single keystroke. Nothing in here may be called a command.
test('prose people actually dictate into a terminal is never a command', () => {
  const prose = [
    'Can you make the overlay bar sit on the left instead?',
    'That should do it, thanks.',
    'Also make a public GitHub repository so I can send people the link.',
    "I don't like it either.",
    'Open the settings screen and tell me what you see.',
    'Find the file I was talking about earlier.',
    'Cat that paragraph back to me so I can hear it.',
    'Make sure it still builds before you push anything.',
    'Go through it again and check the numbers.',
    'Clear up whatever is left over from the last run.',
    'Test it the way a person would actually use it.',
    'Export the whole thing as a single file.',
    'History shows I have done this three times now.',
    'Source the problem before you start changing things.',
  ];
  for (const line of prose) {
    assert.equal(looksLikeCommand(line), false, `called prose a command: ${line}`);
  }
});

/// The cheap direction, and it still has to work. Every one of these opens with
/// a real binary and has no sentence around it.
test('things someone would actually say to a shell are commands', () => {
  const commands = [
    'git status', 'git add .', 'git push', 'npm run build', 'npm install',
    'brew update', 'cd projects', 'ls', 'clear', 'swift build', 'swift test',
    'docker ps', 'git log', 'git diff', 'make clean', 'python3 main.py',
    'rm -rf build', 'grep -r todo', 'chmod +x script.sh', 'curl -O https://example.com',
  ];
  for (const line of commands) {
    assert.equal(looksLikeCommand(line), true, `missed a command: ${line}`);
  }
});

/// Shell syntax settles it wherever it appears — the recogniser does not invent
/// a pipe or a `--flag`.
test('shell syntax is decisive on its own', () => {
  assert.ok(looksLikeCommand('deploy --force'));
  assert.ok(looksLikeCommand('./configure'));
  assert.ok(looksLikeCommand('cat log | grep error'));
  assert.ok(looksLikeCommand('ls ~/Documents'));
});

/// The same opening word, one of each. This is the pair the whole design is
/// for: the window cannot tell them apart and the words can.
test('the same binary opens both a command and a sentence', () => {
  assert.ok(looksLikeCommand('open index.html'));
  assert.equal(looksLikeCommand('Open the door for me when you can.'), false);
  assert.ok(looksLikeCommand('find build'));
  assert.equal(looksLikeCommand('Find out whether that is even true.'), false);
});

test('an empty or blank utterance is not a command', () => {
  assert.equal(looksLikeCommand(''), false);
  assert.equal(looksLikeCommand('   \n '), false);
});

// MARK: - What the formatter does with the answer

test('a sentence dictated into a terminal keeps its capital and its full stop', () => {
  const sentence = 'That should do it.';
  assert.equal(applyAppContext(sentence, 'terminal'), sentence);
});

test('a command dictated into a terminal still loses both', () => {
  // `Git status.` is not a command, and this is the case the old rule was built
  // for. It has to keep working.
  assert.equal(applyAppContext('Git status.', 'terminal'), 'git status');
  assert.equal(applyAppContext('Npm run build.', 'terminal'), 'npm run build');
});

/// "Run the build." is not a shell command — the command is `npm run build` —
/// it is a sentence someone said to Claude Code, which is what a terminal
/// mostly contains now. This expectation used to be `"Run the build."` ->
/// `"run the build"`, and it was wrong about the sentence rather than about the
/// rule.
test('a sentence in a terminal is no longer treated as a command', () => {
  assert.equal(applyAppContext('Run the build.', 'terminal'), 'Run the build.');
  assert.equal(applyAppContext('Can you check that for me?', 'terminal'),
    'Can you check that for me?');
});

/// A search field is not a terminal. "melbourne weather" wants no full stop
/// whatever it looks like, so that context is unchanged.
test('a search field is unaffected by any of this', () => {
  assert.equal(capitalisesSentencesFor('query', 'That should do it.'), false);
  assert.equal(keepsTrailingFullStopFor('query', 'That should do it.'), false);
  assert.equal(applyAppContext('That should do it.', 'query'), 'that should do it');
});

test('code and prose never ask the words', () => {
  for (const context of ['code', 'prose'] as const) {
    assert.equal(capitalisesSentencesFor(context, 'git status'), true);
    assert.equal(keepsTrailingFullStopFor(context, 'git status'), true);
  }
});
