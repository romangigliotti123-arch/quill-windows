import { graphemeCount, isLetter, isNumber, splitWhitespace } from '../text/strings';

/// The stutter: saying the same thing twice in a row because you were still
/// deciding how the sentence went.
///
/// # Why a rule and not a model
///
/// Three disfluency taggers were downloaded and measured for this — a 4M, an 11M
/// and a 66M parameter deletion-tagger, all Apache-2.0, all shipping quantised
/// ONNX, all running in under 2ms. They are the right *class* of tool and their
/// own validation numbers are excellent (0.985 DELETE-F1 for the 11M).
///
/// On Roman's 85 real dictations they were unusable. The 11M wanted to delete 89
/// words, of which **77% were neither a filler nor a repetition** — content words
/// and prepositions. `"So sign in, sign out, create account"` became
/// `"So sign out, create account"`, losing an item from his list. `"the option
/// key for transforms"` became `"the option key transforms"`. `"Because it's
/// wrong."` lost `"wrong"`. They are trained on synthetic disfluencies injected
/// into short chat turns, and his dictations are long, technical and full of
/// deliberate lists and repetition-as-structure. Constraining them to only delete
/// where a rule agreed left six deletions across 2,735 words, one of which was
/// still wrong.
///
/// What they *did* get right was exactly this: the immediate repeat. That needs
/// no judgement, so it does not need a model. It is checkable byte for byte,
/// costs microseconds, downloads nothing, and cannot invent a word.
///
/// # What is deliberately not touched
///
/// English repeats words on purpose. "I know that that is true", "he had had
/// enough", "no no, leave it", "very very good". So a repeated single word is
/// only collapsed when it comes from a list of words that carry no emphasis and
/// cannot legitimately double — and `that`, `had`, `no`, `very`, `so`, `well`,
/// `really` and the like are all absent from it on purpose.
///
/// A repeated *phrase* is safer than a repeated word and needs no list: nobody
/// says "we need to we need to" for effect.

/// Single words where a double is always a stutter.
///
/// Function words only, and only ones that cannot be an intensifier, an
/// answer, or a determiner-plus-complementiser pair. Adding a word here that
/// can legitimately double puts a silent deletion into someone's sentence,
/// which is the one failure this whole file is written to avoid.
export const SAFE_TO_COLLAPSE: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'and', 'but', 'or',
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'i', 'we', 'you',
  'it', 'they', 'he', 'she', 'my', 'your', 'our', 'their', 'its',
  'this', 'these', 'those', 'with', 'for', 'from', 'can', 'could',
  'should', 'would', 'will', 'shall', 'have', 'has', 'get', 'got',
]);

/// The longest repeated phrase worth looking for. Beyond four words a repeat
/// is more likely to be someone deliberately restating something.
export const LONGEST_PHRASE = 4;

export function collapseRepeatedWords(text: string): string {
  // Empty tokens dropped, not preserved. Removing a filled pause leaves a
  // double space behind, and "the thing is um the thing is" then has an
  // empty string sitting between the two copies where the "um" was — so
  // the phrase either side of it never matches itself and the repeat
  // survives. Found by testing that exact sentence.
  const words = splitWhitespace(text);
  if (words.length < 2) return text;

  // Phrases first, longest first: "we need to we need to" should collapse
  // as one three-word repeat rather than as three one-word ones, which
  // would leave "we need to" spelled out of order.
  let n = Math.min(LONGEST_PHRASE, Math.floor(words.length / 2));
  while (n >= 2) {
    let i = 0;
    while (i + 2 * n <= words.length) {
      const first = words.slice(i, i + n).map(bare);
      const second = words.slice(i + n, i + 2 * n).map(bare);
      if (first.every((w, k) => w === second[k]) && !first.some((w) => w.length === 0)) {
        // Keep the SECOND copy: it carries the punctuation the
        // speaker ended on, and a restart's second attempt is the
        // one they meant.
        words.splice(i, n);
        continue;
      }
      i += 1;
    }
    n -= 1;
  }

  const out: string[] = [];
  for (const word of words) {
    const last = out[out.length - 1];
    if (last !== undefined && bare(last) === bare(word) && bare(word).length > 0
      && SAFE_TO_COLLAPSE.has(bare(word))) {
      // Same word twice. Keep whichever copy carries punctuation, so
      // "in, in" keeps the comma and "the the" keeps either.
      if (graphemeCount(last) < graphemeCount(word)) out[out.length - 1] = word;
      continue;
    }
    out.push(word);
  }
  return out.join(' ');
}

/// Lowercased, stripped of the punctuation that a repeat may or may not
/// carry. `Bare` rather than a full normalisation because a repeat has to be
/// the *same word*, not a similar one — fuzziness here deletes real words.
function bare(word: string): string {
  let out = '';
  for (const c of word.toLowerCase()) if (isLetter(c) || isNumber(c) || c === "'") out += c;
  return out;
}

/// The Swift original is a caseless enum namespace, `RepeatedWords.collapse`.
export const RepeatedWords = { collapse: collapseRepeatedWords } as const;
