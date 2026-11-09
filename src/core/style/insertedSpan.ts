import { graphemeCount, graphemes, trim } from '../text/strings';

/// Finding what happened to the sentence Quill inserted, after the user had a
/// go at it.
///
/// This is the pure half of watching an edit, and it is pure for the same reason
/// `styleLearner` is: the impure version can only be checked by dictating into a
/// real app and reading the profile afterwards, which is how a learning feature
/// ships with a detector that has never once fired. Strings in, a verdict out,
/// no accessibility API, no clock, no store.
///
/// # Why it works by anchors rather than by diffing
///
/// The field holds a whole document. Quill's sentence is somewhere inside it, and
/// after an edit it is somewhere slightly different, a slightly different length,
/// with the user's cursor having moved around in between. Diffing the two whole
/// documents finds every change in all of them — including the paragraph they
/// wrote afterwards, which says nothing about how they correct dictation.
///
/// So: remember the few characters either side of where the sentence landed, find
/// those again, and read out what is now between them. What that returns is only
/// ever the span Quill itself produced.
///
/// # Only the span, deliberately
///
/// Nothing here keeps the document. The anchors are short and the verdict carries
/// the edited sentence and nothing else, because the alternative — holding a
/// user's whole email in memory to compare it later, in an app whose entire pitch
/// is that nothing leaves the machine — is not a trade worth making for a
/// spelling preference.

/// How much context either side is enough to find the sentence again.
///
/// Long enough to be unique in an ordinary document; short enough that it is
/// not a copy of the surrounding text. 24 characters of the preceding
/// sentence is not a document.
export const ANCHOR_LENGTH = 24;

export interface Anchors {
  /// The text immediately before where the sentence landed, truncated.
  left: string;
  /// The text immediately after it, truncated. Empty when the sentence
  /// landed at the very end of the field, which is the common case.
  right: string;
  /// What Quill actually inserted.
  inserted: string;
}

export type VerdictReason =
  /// The field never contained the sentence — the insertion did not land where
  /// we thought, or the app rewrote it on arrival.
  | 'notFound'
  /// It appears more than once. Which copy did they edit?
  | 'ambiguous'
  /// The anchors no longer locate anything. The user moved or deleted the
  /// surrounding text.
  | 'anchorsLost'
  /// The sentence is gone. Deleting a dictation is not a style preference — it
  /// usually means Quill misheard entirely, or the undo chord.
  | 'deleted'
  /// What is there now is a different sentence rather than a corrected one.
  /// Learning from a rewrite teaches the tone of whatever they wrote next.
  | 'rewritten';

export type Verdict =
  /// The sentence is still exactly as Quill wrote it. Includes the case where
  /// the user kept it and carried on writing after it.
  | { kind: 'unchanged' }
  /// The sentence is now this. The only case that teaches anything.
  | { kind: 'corrected'; text: string }
  /// Cannot tell, and saying so is the whole point. A guess here does not fail
  /// visibly — it quietly teaches the profile something the user never did.
  | { kind: 'notComparable'; reason: VerdictReason };

/// The last `count` visible characters of `text`.
function suffixOf(text: string, count: number): string {
  return graphemes(text).slice(-count).join('');
}

/// The first `count` visible characters of `text`.
function prefixOf(text: string, count: number): string {
  return graphemes(text).slice(0, count).join('');
}

/// Remember where the sentence landed. Null when the field does not contain it
/// exactly once, in which case there is nothing to watch.
export function anchorsFor(inserted: string, field: string): Anchors | null {
  if (inserted.length === 0) return null;
  let found = -1;
  let searchFrom = 0;
  for (;;) {
    const at = field.indexOf(inserted, searchFrom);
    if (at < 0) break;
    if (found >= 0) return null; // ambiguous; see VerdictReason 'ambiguous'
    found = at;
    searchFrom = at + inserted.length;
  }
  if (found < 0) return null;
  return {
    left: suffixOf(field.slice(0, found), ANCHOR_LENGTH),
    right: prefixOf(field.slice(found + inserted.length), ANCHOR_LENGTH),
    inserted,
  };
}

/// What the sentence has become in `field` now.
export function verdictFor(anchors: Anchors, field: string): Verdict {
  // Still there, untouched, wherever it has moved to. Checked first and
  // cheaply: it is the answer almost every time.
  if (field.includes(anchors.inserted)) return { kind: 'unchanged' };

  // Anchors are matched with their inner whitespace trimmed off, because
  // deleting or replacing the text between them usually takes one of the
  // adjacent spaces with it. Anchored on the literal " Cheers." with its
  // leading space, deleting the sentence out of "Morning. <it> Cheers."
  // leaves "Morning. Cheers." — where that space no longer exists — and the
  // whole thing reads as anchors lost rather than as the deletion it is.
  // Found by writing the deletion test and watching it fail.
  const left = anchors.left.replace(/\s+$/u, '');
  const right = anchors.right.replace(/^\s+/u, '');

  const start = onlyRange(left, field, true);
  if (start === null) return { kind: 'notComparable', reason: 'anchorsLost' };

  const after = field.slice(start);
  let candidate: string;
  if (right.length === 0) {
    // The sentence ran to the end of the field. Anything after the left
    // anchor is either the edited sentence or the edited sentence plus
    // whatever they wrote next — and there is no marker between the two,
    // so the tail is all we have.
    candidate = after;
  } else {
    // First match, deliberately. If the edited sentence happens to
    // contain the anchor text the candidate comes out short, which fails
    // the ratio guard below — the conservative direction. A last match
    // would instead swallow whatever came after it.
    const end = after.indexOf(right);
    if (end < 0) return { kind: 'notComparable', reason: 'anchorsLost' };
    candidate = after.slice(0, end);
  }

  const edited = trim(candidate);
  if (edited.length === 0) return { kind: 'notComparable', reason: 'deleted' };
  if (edited === trim(anchors.inserted)) return { kind: 'unchanged' };

  // A correction is a version of the same sentence. Anything far longer or
  // far shorter is a different one, and the ratio is the only signal here
  // that does not need to understand the language.
  const originalLength = graphemeCount(anchors.inserted);
  const ratio = graphemeCount(edited) / Math.max(originalLength, 1);
  if (ratio < 0.4 || ratio > 2.5) return { kind: 'notComparable', reason: 'rewritten' };

  return { kind: 'corrected', text: edited };
}

/// The position just after a range that occurs exactly once, or null.
/// Ambiguity is a refusal, not a coin toss — the wrong copy teaches the wrong
/// lesson silently.
function onlyRange(needle: string, haystack: string, allowEmpty: boolean): number | null {
  if (needle.length === 0) return allowEmpty ? 0 : null;
  let found: number | null = null;
  let searchFrom = 0;
  for (;;) {
    const at = haystack.indexOf(needle, searchFrom);
    if (at < 0) break;
    if (found !== null) return null;
    found = at + needle.length;
    searchFrom = found;
  }
  return found;
}

/// The Swift original is a caseless enum namespace, `InsertedSpan`.
export const InsertedSpan = {
  anchors: anchorsFor,
  verdict: verdictFor,
  anchorLength: ANCHOR_LENGTH,
} as const;
