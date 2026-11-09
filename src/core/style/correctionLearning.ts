import { graphemeCount, graphemes, isLetter, trimCharacters } from '../text/strings';

/// What one correction should teach.
///
/// # Why this is the part that makes the app get better
///
/// Three separate measurements said there is nothing to mine from a dictation
/// history on its own. Harvesting jargon from Roman's 85 dictations proposed
/// exactly one word, and it was his own pronunciation rather than a missing
/// term. Looking for retraction cues found two genuine self-corrections in 85,
/// both already handled, while the cue words themselves — "actually", "I mean" —
/// were ordinary speech five times out of seven. Looking for repeated phrases
/// worth a snippet found four, all of them connectives like "and then they can".
///
/// A transcript records what the recogniser *did*. It cannot say what was wrong
/// with it. Only the user can, and the only moment they do is when they correct
/// something — which is why that moment has to be worth as much as possible.
///
/// So a correction feeds two things, not one:
///
///  1. **The style profile**, through `styleLearner` — spelling, contractions,
///     tone, the phrasings pairs. This changes how the model cleanup writes.
///  2. **The Dictionary**, which is the one that changes what is *heard*. The
///     terms in it are handed to the speech model as a prompt, so they bias
///     recognition itself. A word learned here does not get corrected after
///     the fact next time — it comes out right.
///
/// Only (2) makes recognition better, and nothing in the app was feeding it from
/// use. `vocabularyHarvest` reads the filesystem — project folders, git remotes —
/// which is a good source and a fixed one: it knows the same words on day 400 as
/// on day 1.
///
/// # Proposed, never applied
///
/// Same rule `vocabularyHarvest` already follows, and for a stronger reason here.
/// A Dictionary entry biases every future dictation towards that word, so a
/// wrong one does not sit inertly — it actively pulls speech towards a mistake.
/// One typed correction is not evidence enough to do that silently.

/// Whether a word is already ordinary English. Behind a seam because the real
/// one asks the bundled word list, and a test must not depend on whether that
/// 1.2M-word file has been loaded.
export type KnownWord = (word: string) => boolean;

export interface CorrectionOutcome {
  /// Words worth offering for the Dictionary: they appear in what the user
  /// wrote, not in what Quill produced, and no dictionary knows them.
  dictionaryCandidates: string[];
}

/// What changed, and what to do about it.
///
/// `existingTerms` is the Dictionary as it stands, so a word already in it is
/// not offered twice.
export function learnFromCorrection(
  was: string,
  now: string,
  existingTerms: string[],
  isKnownWord: KnownWord,
): CorrectionOutcome {
  const before = new Set(wordsIn(was).map((word) => word.toLowerCase()));
  const known = new Set(
    existingTerms.flatMap((term) => term.split(' ').filter((p) => p.length > 0).map((p) => p.toLowerCase())),
  );

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const word of wordsIn(now)) {
    const key = word.toLowerCase();
    // Only words the correction introduced. A word that was already there
    // was not what the user was fixing.
    if (before.has(key)) continue;
    if (known.has(key)) continue;
    if (seen.has(key)) continue;
    // Two letters is an abbreviation or a typo, and the recogniser does
    // not mishear those into something a dictionary would fix.
    if (graphemeCount(word) < 3) continue;
    if (isKnownWord(word)) continue;
    seen.add(key);
    candidates.push(word);
  }
  return { dictionaryCandidates: candidates };
}

/// Letters, apostrophes and internal hyphens. Punctuation and digits are not
/// words a dictionary can bias towards.
export function wordsIn(text: string): string[] {
  const out: string[] = [];
  let current = '';
  const flush = (): void => {
    const trimmed = trimCharacters(current, "-'");
    if (trimmed.length > 0) out.push(trimmed);
    current = '';
  };
  for (const c of graphemes(text)) {
    if (isLetter(c) || c === "'" || c === '-') current += c;
    else flush();
  }
  flush();
  return out;
}

/// The Swift original is a caseless enum namespace, `CorrectionLearning`.
export const CorrectionLearning = { learn: learnFromCorrection, words: wordsIn } as const;
