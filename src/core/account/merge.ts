/// The merge rules `SyncEngine` applies, kept apart from it so they can be
/// proven without a network, an account or a data directory.
///
/// # Merge, not overwrite
///
/// Roman's rule, exactly: signing into the same account on a second computer
/// must never look like losing what that computer already had. Every merge is a
/// union — new items added, matching items combined, nothing already on either
/// side ever dropped. The AI key is the one exception: a single credential has
/// nothing to union — see `mergeAPIKey`.
///
/// These work on the parsed JSON a store already writes to disk rather than on
/// the store's own types, for two reasons. The files are shared with a Mac whose
/// build may be a version ahead or behind this one, and a merge that rebuilds
/// each record from the fields THIS build knows about would silently strip a
/// field a newer Mac added — so unknown fields ride along untouched. And it
/// means nothing here depends on any store's internals, which are free to change.

export type JSONObject = { [key: string]: unknown };

/// Union by id — the general case. `keepExisting` decides a collision; whichever
/// side it returns wins, and the item stays in the position the LOCAL list gave
/// it, so a sync never reshuffles what someone is looking at.
export function mergeByID<T, ID>(
  local: T[],
  remote: T[],
  keyOf: (item: T) => ID,
  keepExisting: (existing: T, incoming: T) => T,
): T[] {
  const byID = new Map<ID, T>();
  const order: ID[] = [];
  for (const item of local) {
    const key = keyOf(item);
    if (!byID.has(key)) order.push(key);
    byID.set(key, item);
  }
  for (const item of remote) {
    const key = keyOf(item);
    const existing = byID.get(key);
    if (existing !== undefined) {
      byID.set(key, keepExisting(existing, item));
    } else {
      byID.set(key, item);
      order.push(key);
    }
  }
  return order.map((key) => byID.get(key) as T);
}

const idOf = (item: JSONObject): unknown => item.id;

/// Union by id, favouring whichever side already has the record. A dictation is
/// immutable once written, so a collision means "the same dictation, said on
/// both machines' histories" and either copy is right.
export function mergeHistory(local: JSONObject[], remote: JSONObject[]): JSONObject[] {
  return mergeByID(local, remote, idOf, (existing) => existing);
}

const useCountOf = (item: JSONObject): number =>
  (typeof item.useCount === 'number' ? item.useCount : 0);

/// Snippets and transforms: the copy that has been used more is the copy that
/// has seen more of this person's real life, and it carries the later edit more
/// often than not.
export function mergeByUseCount(local: JSONObject[], remote: JSONObject[]): JSONObject[] {
  return mergeByID(local, remote, idOf, (a, b) => (useCountOf(a) >= useCountOf(b) ? a : b));
}

export interface VocabularyJSON extends JSONObject { terms: string[] }

/// Case-insensitive set union, matching `VocabularyBook.add()`. Local casing
/// wins a collision — "Craigieburn" stays "Craigieburn" when the other side
/// sent "craigieburn".
export function mergeVocabulary(local: VocabularyJSON, remote: VocabularyJSON): VocabularyJSON {
  const terms = [...local.terms];
  const seen = new Set(terms.map((term) => term.toLowerCase()));
  for (const term of remote.terms) {
    const folded = term.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    terms.push(term);
  }
  return { ...local, terms };
}

/// A credential, not a collection — there is nothing to union. The rule that
/// keeps this consistent with everywhere else "local wins on a collision" is
/// used: whichever key is already on THIS machine stays, and is what gets pushed
/// up. A machine with no key yet picks up whatever the account already has; one
/// that already has a key keeps deciding for itself until someone changes it
/// there, and that change is what every other machine converges to next.
export function mergeAPIKey(local: string, _remote: string): string {
  return local;
}

// MARK: - Style

/// Votes per value, as the style file writes them.
export interface StyleTraitJSON extends JSONObject {
  votes?: Record<string, number>;
  lastObserved?: string | null;
}

export interface StylePhrasingJSON extends JSONObject {
  from: string;
  to: string;
  count?: number;
  lastObserved?: string | null;
}

export interface StyleJSON extends JSONObject {
  preset?: string;
  appTones?: Record<string, string>;
  isLearningEnabled?: boolean;
  spelling?: StyleTraitJSON;
  contractions?: StyleTraitJSON;
  formality?: StyleTraitJSON;
  oxfordComma?: StyleTraitJSON;
  exclamations?: StyleTraitJSON;
  sentenceLength?: { total?: number; count?: number };
  phrasings?: StylePhrasingJSON[];
  correctionCount?: number;
  modelAccepted?: number;
  modelReverted?: number;
  lastLearned?: string | null;
}

/// The most votes any one value can hold — `VOTE_CEILING` in the style profile,
/// repeated here as a number rather than imported so this file stays free of the
/// profile's dependencies. A test pins the two together.
export const STYLE_VOTE_CEILING = 6;
/// `MAXIMUM_PHRASINGS` in the style profile; pinned the same way.
export const STYLE_MAXIMUM_PHRASINGS = 24;

function stamp(value: string | null | undefined): number {
  if (typeof value !== 'string') return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/// The later of two optional timestamps, as the original string.
function later(a: string | null | undefined, b: string | null | undefined): string | null {
  const x = stamp(a);
  const y = stamp(b);
  if (x === Number.NEGATIVE_INFINITY && y === Number.NEGATIVE_INFINITY) return null;
  return y > x ? (b as string) : (a as string);
}

/// Combines the evidence from two machines into one trait.
///
/// Votes add, per value, capped at the same ceiling a single machine's own
/// corrections already respect — six votes of agreement is six votes of
/// agreement, whichever machine they were said on. The later `lastObserved`
/// wins, since it is the more recent fact about how this person writes now.
function mergeTrait(a: StyleTraitJSON | undefined, b: StyleTraitJSON | undefined): StyleTraitJSON {
  const votes: Record<string, number> = { ...(a?.votes ?? {}) };
  for (const [key, count] of Object.entries(b?.votes ?? {})) {
    votes[key] = Math.min(STYLE_VOTE_CEILING, (votes[key] ?? 0) + count);
  }
  return { ...(a ?? {}), votes, lastObserved: later(a?.lastObserved, b?.lastObserved) };
}

/// Everything either machine has observed, in one profile. Never fewer votes,
/// never fewer phrasings, never a smaller correction count than either side
/// already held on its own.
///
/// `preset`, `appTones` and `isLearningEnabled` are choices, not evidence —
/// there is nothing to sum. Whichever side has the more recent `lastLearned`
/// wins them, on the theory that the machine someone has been actively
/// dictating on lately is the one whose settings they meant last.
export function mergeStyle(local: StyleJSON, remote: StyleJSON): StyleJSON {
  const result: StyleJSON = { ...local };
  const remoteIsNewer = stamp(remote.lastLearned) > stamp(local.lastLearned);
  if (remoteIsNewer) {
    if (remote.preset !== undefined) result.preset = remote.preset;
    if (remote.appTones !== undefined) result.appTones = remote.appTones;
    if (remote.isLearningEnabled !== undefined) result.isLearningEnabled = remote.isLearningEnabled;
  }
  result.lastLearned = later(local.lastLearned, remote.lastLearned);

  result.spelling = mergeTrait(local.spelling, remote.spelling);
  result.contractions = mergeTrait(local.contractions, remote.contractions);
  result.formality = mergeTrait(local.formality, remote.formality);
  result.oxfordComma = mergeTrait(local.oxfordComma, remote.oxfordComma);
  result.exclamations = mergeTrait(local.exclamations, remote.exclamations);

  // A mean that forgets. `sampleCeiling` bounds how far ONE machine's own window
  // slides, so a habit from a year ago cannot outvote last week. It does not
  // apply here: both sides are already within it, so their sum is at most double
  // it, which is still an honest weighted average of real evidence — capping it
  // here would scale `count` without scaling `total` to match, which is the
  // average silently going wrong rather than merely being generous with history.
  result.sentenceLength = {
    ...(local.sentenceLength ?? {}),
    total: (local.sentenceLength?.total ?? 0) + (remote.sentenceLength?.total ?? 0),
    count: (local.sentenceLength?.count ?? 0) + (remote.sentenceLength?.count ?? 0),
  };

  // A phrasing's identity is the pair — see `phrasingID` in the style profile.
  const phrasingKey = (phrasing: StylePhrasingJSON): string => `${phrasing.from}→${phrasing.to}`;
  const byID = new Map<string, StylePhrasingJSON>();
  for (const phrasing of local.phrasings ?? []) byID.set(phrasingKey(phrasing), phrasing);
  for (const theirs of remote.phrasings ?? []) {
    const ours = byID.get(phrasingKey(theirs));
    if (ours) {
      byID.set(phrasingKey(theirs), {
        ...ours,
        count: (ours.count ?? 1) + (theirs.count ?? 1),
        lastObserved: later(ours.lastObserved, theirs.lastObserved),
      });
    } else {
      byID.set(phrasingKey(theirs), theirs);
    }
  }
  // Highest-evidence first, then most recent — the same ordering
  // `MAXIMUM_PHRASINGS` exists to protect: what survives a trim should be what
  // has actually been said more than once, not whatever happened to be listed
  // first.
  result.phrasings = [...byID.values()]
    .sort((a, b) => ((a.count ?? 1) === (b.count ?? 1)
      ? stamp(b.lastObserved) - stamp(a.lastObserved)
      : (b.count ?? 1) - (a.count ?? 1)))
    .slice(0, STYLE_MAXIMUM_PHRASINGS);

  result.correctionCount = (local.correctionCount ?? 0) + (remote.correctionCount ?? 0);
  result.modelAccepted = (local.modelAccepted ?? 0) + (remote.modelAccepted ?? 0);
  result.modelReverted = (local.modelReverted ?? 0) + (remote.modelReverted ?? 0);
  return result;
}

// MARK: - Wire dates

const FRACTIONAL = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+Z$/;

/// Rewrites every ISO-8601 timestamp with fractional seconds to whole seconds,
/// recursively.
///
/// JavaScript writes `2026-08-24T10:00:00.123Z`; Swift's `.iso8601` date
/// decoding accepts `2026-08-24T10:00:00Z` and REFUSES the fractional form. A
/// Windows machine pushing its own spelling would make every Mac decode the
/// whole field as "nothing there" — silently, since a field that will not decode
/// is treated as absent — and sync would look like it worked while delivering
/// nothing. Applied to what goes up to the cloud so the document is readable by
/// both builds; reading is unaffected, because `new Date()` takes either form.
export function normalizeDates(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = FRACTIONAL.exec(value);
    return match ? `${match[1]}Z` : value;
  }
  if (Array.isArray(value)) return value.map(normalizeDates);
  if (value && typeof value === 'object') {
    const out: JSONObject = {};
    for (const [key, child] of Object.entries(value as JSONObject)) out[key] = normalizeDates(child);
    return out;
  }
  return value;
}
