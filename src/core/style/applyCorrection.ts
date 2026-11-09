import type { HistoryStore } from '../stores/history';
import { isRealEnglishWord } from '../text/dictionary';
import { learnFromCorrection, type KnownWord } from './correctionLearning';
import type { StyleStore } from './styleProfile';

/// What saving a correction from the Dictation screen does, end to end.
///
/// The macOS build did this inside the detail view's save handler. It is lifted
/// out here so the IPC layer can call one function, and so the whole chain —
/// keep both versions, teach the style profile, offer Dictionary terms — can be
/// tested without a window.
///
/// Three effects, in this order:
///
///  1. **The history keeps both versions.** The pair is the evidence, and
///     overwriting what Quill inserted would throw away the only record of what
///     needed correcting.
///  2. **The style profile learns from the difference** — what it changes about
///     the *writing*.
///  3. **Dictionary candidates are worked out and returned, never applied.**
///     This is what changes what is *heard*: Dictionary terms bias the speech
///     model, so a word learned here comes out right next time rather than being
///     repaired after the fact. But a Dictionary term biases every future
///     dictation towards that word, so a wrong one pulls speech towards a
///     mistake — one typed correction is not evidence enough to add it silently.
///     The caller shows them to the user and adds only what they accept.
///
/// Returns null when nothing changed (the text was blank or identical), in which
/// case nothing was learned and nothing was written.
export interface CorrectionResult {
  was: string;
  now: string;
  /// Words worth offering for the Dictionary. Possibly empty.
  dictionaryCandidates: string[];
}

export function applyDictationCorrection(options: {
  history: HistoryStore;
  style: StyleStore;
  /// The Dictionary as it stands, so a word already in it is not offered twice.
  existingTerms: string[];
  id: string;
  text: string;
  /// Defaults to the bundled English word list.
  isKnownWord?: KnownWord;
}): CorrectionResult | null {
  const pair = options.history.correct(options.id, options.text);
  if (!pair) return null;

  options.style.recordCorrection(pair.was, pair.now);

  const outcome = learnFromCorrection(
    pair.was,
    pair.now,
    options.existingTerms,
    options.isKnownWord ?? isRealEnglishWord,
  );
  return { was: pair.was, now: pair.now, dictionaryCandidates: outcome.dictionaryCandidates };
}
