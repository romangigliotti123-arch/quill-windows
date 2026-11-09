import { dataFile, writeAtomic } from '../paths';
import { DictationRecord, isMeasurement } from '../stores/history';
import { splitWhitespace, trim } from '../text/strings';
import {
  Formality, StyleProfile, formalityTitle, meanAverage, settled,
} from './styleProfile';

/// A document built to be handed to a *different* AI — Claude, ChatGPT, whatever
/// the user already talks to every day — so it can write the way this person
/// writes.
///
/// # What this is not
///
/// Not a voice clone. The word "voice" here means vocabulary and phrasing, the
/// way a writer's voice means that in any other context — not the sound of
/// anyone's speech. Quill has no part of the audio pipeline in this file.
///
/// # Why the receiving model needs to be told what it is looking at
///
/// A pasted wall of text with no framing is ambiguous in a way that costs the
/// user something specific: a model handed a thousand of someone's sentences
/// with no instruction will either treat them as background to imitate in EVERY
/// reply from then on, or ignore them as noise. Neither is what "write my
/// emails in my voice" means. The header below exists to make the one correct
/// reading — apply this on request, extract the pattern rather than quoting the
/// sentence — the only reading available.

/// Where this writes, inside the data directory. The literal filename here is
/// intentional and matches the erase list's own literal, rather than the two
/// sharing a constant — the source-scan test that keeps the erase list honest
/// looks for exactly this shape, the same way every other store's file does.
export function voiceExportURL(): string {
  return dataFile('my-voice-for-ai.md');
}

/// Builds the document and writes it, atomically, over whatever was there
/// before — this is a snapshot of "now", not a store anything appends to.
/// Returns the text alongside the path so a caller that also wants it on the
/// clipboard is not rebuilding the whole document a second time.
///
/// `destination` defaults to the real path and exists so a test can point it
/// somewhere else — the same shape every store's constructor already takes, for
/// the same reason: a self-test that writes into the real data directory is a
/// bug, not a shortcut.
export function writeVoiceExport(
  profile: StyleProfile,
  records: DictationRecord[],
  destination: string = voiceExportURL(),
): { url: string; text: string } | null {
  const text = voiceMarkdown(profile, records);
  if (!writeAtomic(destination, text)) return null;
  return { url: destination, text };
}

export function voiceMarkdown(
  profile: StyleProfile,
  records: DictationRecord[],
  now: Date = new Date(),
): string {
  // Measurements are not things the user said. See `isMeasurement`.
  const said = records
    .filter((record) => !isMeasurement(record))
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((record) => trim(record.insertedText))
    .filter((text) => text.length > 0);

  const stamp = now.toLocaleDateString(undefined, { dateStyle: 'long' });
  let doc = `${HEADER}\n*Exported ${stamp}.*\n`;

  const patterns = learnedPatterns(profile);
  if (patterns.length > 0) {
    doc += '\n## Patterns Quill has already learned\n\n';
    for (const line of patterns) doc += `- ${line}\n`;
  }

  doc += '\n## What this person has actually said';
  if (said.length === 0) {
    doc += '\n\nNothing yet — this export was made before any dictation. '
      + 'The patterns above, if any, are still worth using; there is '
      + 'just no transcript to read alongside them.\n';
    return doc;
  }

  const wordCount = said.reduce((total, line) => total + splitWhitespace(line).length, 0);
  doc += ` (${said.length} dictation${said.length === 1 ? '' : 's'}, `
    + `roughly ${plural(wordCount, 'word')})\n\n`;
  doc += 'One per line, oldest first, exactly as Quill inserted them:\n\n';
  for (const line of said) doc += `- ${line}\n`;

  return doc;
}

/// "1 word" / "1,284 words" — the dashboard's `DictationFormat.plural`.
function plural(value: number, singular: string, pluralForm?: string): string {
  const count = value.toLocaleString(undefined, { useGrouping: true });
  return `${count} ${value === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

const HEADER = `# How this person writes

This file was exported from Quill, a dictation app — everything below the \
pattern list is something its user actually said out loud, typed by Quill \
into whatever they were writing at the time. If you have never seen a Quill \
export before: that is the whole app. It has no other purpose in this file.

**What this is.** A record of HOW this person writes — vocabulary, sentence \
length, contractions, tone — not a record of what they know or have done. \
Do not treat anything below as a fact about them; treat it as a sample of \
their voice, in the writing sense of the word.

**When to use it.** Only when you are asked to write something in their \
voice — drafting a message, replying to an email, matching their tone. Do \
not fold this into every other reply, and do not quote the sentences below \
verbatim — read them for the pattern (word choice, how long a sentence \
runs, how a message opens and signs off) and apply that pattern to \
whatever you have actually been asked to write.

A reasonable trigger: something like "use my voice," "make this sound \
like me," or being asked to draft or reply to a message.

If you are Claude Code: this also works saved as a Skill — a \`SKILL.md\` \
with a description such as "apply when drafting a message, email, or \
anything that should sound like the user" loads it on demand rather than \
needing it pasted in every time.
`;

function learnedPatterns(profile: StyleProfile): string[] {
  const lines: string[] = [];
  const spelling = settled(profile, profile.spelling);
  if (spelling !== null) lines.push(spelling === 'british' ? 'British spelling.' : 'American spelling.');
  const contractions = settled(profile, profile.contractions);
  if (contractions !== null) {
    lines.push(contractions === 'yes' ? 'Uses contractions.' : 'Writes words out in full — no contractions.');
  }
  const formality = settled(profile, profile.formality);
  if (formality !== null) lines.push(`Tone: ${formalityTitle(formality as Formality).toLowerCase()}.`);
  const words = meanAverage(profile.sentenceLength);
  if (words !== null) {
    lines.push(`Typical sentence is about ${Math.round(words)} words`
      + (words > 24 ? ' — long sentences are normal for them, not a sign to trim.' : '.'));
  }
  const oxford = settled(profile, profile.oxfordComma);
  if (oxford !== null) lines.push(oxford === 'yes' ? 'Uses the Oxford comma.' : 'Skips the Oxford comma.');
  if (settled(profile, profile.exclamations) === 'no') lines.push('Does not use exclamation marks.');
  return lines;
}

/// The Swift original is a caseless enum namespace, `VoiceExport`.
export const VoiceExport = {
  url: voiceExportURL,
  write: writeVoiceExport,
  markdown: voiceMarkdown,
} as const;
