import nlp from 'compromise';
import { IMPERATIVE_VERBS } from './imperative-verbs.js';
import type { Sentence, Word } from './types.js';

/**
 * POS-tagging substrate for the old `IMPERATIVE_VERBS`/`FUNCTION_WORDS` list-membership checks.
 *
 * PROVENANCE: backed by the `compromise` npm package (real grammatical tagging: mood, tense,
 * word class), not by enumeration. `compromise`'s general-English lexicon does not know most of
 * this project's technical/procedural vocabulary out of the box (`torque`, `flash`, `mark` as a
 * verb, `source`, `sync`, `query`, `rebase`, `unset`, `serialise` all default to a non-verb
 * reading until taught) — confirmed by direct testing against the installed package, not assumed.
 * `IMPERATIVE_VERBS` therefore survives as a **domain lexicon**, taught to `compromise` via
 * `addWords` for the duration of each of this module's own public entry-point calls (see
 * {@link withLexicons}) so its own context-sensitive tagger decides, per occurrence, whether a
 * taught word is actually functioning as a verb here (`record` still tags as `Noun` in "the
 * maintenance record", `Verb` in "Record the value" — verified directly; `addWords` teaches a
 * possible tag, it does not force one). The list also backs the small fallback described on
 * {@link isImperativeVerbWord} below.
 *
 * The domain lexicon is **not** taught permanently at module load: `compromise` is a single
 * module-global singleton shared by the whole Node process (see {@link LexiconStore}'s own
 * PROVENANCE), so a host application embedding this package alongside its own use of `compromise`
 * would otherwise see this module's technical vocabulary leak into its own tagging, forever, merely
 * by importing this module — whether or not any of its rules ever ran. Instead, {@link
 * withLexicons} teaches the domain lexicon (and any requested `extraImperativeVerbs`) at the start
 * of a call and restores the shared singleton to exactly what it was immediately before, once that
 * call's own work is completely done — so the mutation is never observable by any other consumer of
 * the shared singleton, at any point between two of this module's calls.
 *
 * Critically, `addWords` is only called for words `compromise` does **not** already tag as a verb
 * on its own. Calling it unconditionally for the whole list was tried first and found, by direct
 * testing, to *regress* words `compromise` already handles well: `addWords({build: 'Verb'})`
 * changes "Build, flash, and run a sample application" from tagging `Build` as
 * `Verb·PresentTense·Infinitive` to `Verb·PastTense` — `addWords` replaces `compromise`'s own
 * richer, conjugation-aware entry for a known irregular verb with the flat tag supplied, rather
 * than adding to it. Every word is therefore checked against a pristine tag lookup before the
 * lexicon is ever mutated, and only the words that fail that check are taught.
 *
 * `FUNCTION_WORDS` (below) plays the equivalent fallback role for closed-class words.
 */

interface CompromiseOffsetTerm {
  readonly tags?: readonly string[];
  readonly offset?: { readonly start: number; readonly length: number };
}
interface CompromiseOffsetSentence {
  readonly terms?: readonly CompromiseOffsetTerm[];
}

/** Tags of the first term of the first sentence `compromise` finds in `text`, if any. */
function firstTermTags(text: string): readonly string[] | undefined {
  // `compromise` ships no type declarations for `.json()`'s return shape; `CompromiseOffsetSentence`
  // is this module's own, deliberately partial, description of the fields it actually reads.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const data = nlp(text).json() as readonly CompromiseOffsetSentence[];
  return data[0]?.terms?.[0]?.tags;
}

/** Does `compromise`, unmodified, already tag `word` (in isolation) as a verb? */
function alreadyKnownAsVerb(word: string): boolean {
  const tags = firstTermTags(word);
  return tags !== undefined && tags.includes('Verb');
}

/**
 * The domain lexicon (see {@link IMPERATIVE_VERBS}) as an `addWords` payload: only the words
 * `compromise` does not already tag as a verb on its own (see {@link alreadyKnownAsVerb}). Computed
 * once, lazily, on first use and cached — the underlying word list is static, so which words need
 * teaching never changes between calls; only *whether* they are currently taught does (see
 * {@link withLexicons} below, which teaches this dict at the start of every public entry-point call
 * and restores it at the end of that same call, never leaving it taught in between).
 */
let cachedDomainLexicon: Record<string, string> | undefined;
function domainLexiconDict(): Record<string, string> {
  if (cachedDomainLexicon === undefined) {
    const lexicon: Record<string, string> = {};
    for (const verb of IMPERATIVE_VERBS) {
      if (!alreadyKnownAsVerb(verb)) lexicon[verb] = 'Verb';
    }
    cachedDomainLexicon = lexicon;
  }
  return cachedDomainLexicon;
}

// ---------------------------------------------------------------------------
// Per-configuration ("extra") vocabulary — scoped, not a permanent ratchet
// ---------------------------------------------------------------------------

/**
 * The two lexicon stores `addWords` writes into. PROVENANCE: `compromise` exposes no per-instance
 * or per-document tagger — `nlp.world()` is documented as a "reach-into internals" escape hatch
 * (`node_modules/compromise/src/nlp.js`) and returns the package's one module-global `world`
 * object, confirmed by direct inspection (`world.model.one.lexicon`,
 * `world.model.one._multiCache`) to be exactly what `addWords` (`1-one/lexicon/lib.js`) mutates,
 * in place, for every future `nlp(...)` call in the process — there is no `removeWords`.
 */
interface LexiconStore {
  readonly model: {
    readonly one: {
      lexicon: Record<string, unknown>;
      _multiCache: Record<string, unknown>;
    };
  };
}

function lexiconStore(): LexiconStore {
  // `nlp.world()` is untyped (see the `LexiconStore` PROVENANCE note above) — the cast is this
  // module's own confirmed-by-inspection description of the shape it reaches into, not something a
  // type guard could verify from the outside.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return nlp.world() as unknown as LexiconStore;
}

/**
 * Sentinel meaning "this key was absent from the store", distinct from a key present with value
 * `undefined` (which `addWords` never actually writes, but the distinction is cheap to keep
 * correct rather than assume).
 */
const ABSENT: unique symbol = Symbol('lexicon key absent');
/** A captured lexicon/`_multiCache` value, or {@link ABSENT} if the key did not exist. */
type KeyValue = unknown;

function readKey(store: Record<string, unknown>, key: string): KeyValue {
  return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ABSENT;
}

/** Restore `store[key]` to a value previously captured by {@link readKey} — delete if it was absent. */
function writeKey(store: Record<string, unknown>, key: string, value: KeyValue): void {
  if (value === ABSENT) delete store[key];
  else store[key] = value;
}

/**
 * What one {@link teachAndTrack} call did to one `lexicon`/`_multiCache` key: `prev` is what was
 * there immediately before that call (`ABSENT` if the key did not exist yet), `written` is what
 * that call actually changed it to.
 */
interface TouchedKey {
  readonly prev: KeyValue;
  readonly written: KeyValue;
}

/**
 * Exactly which `lexicon`/`_multiCache` keys one {@link teachAndTrack} call actually changed, and
 * what each one was doing immediately before and after that call. Returned by {@link teachAndTrack}
 * and consumed by {@link restoreTracked} to put the shared singleton back the way it was, key by
 * key, once the call that needed those words taught is done with them.
 *
 * PROVENANCE: an earlier version of this fix restored a whole-object snapshot of the shared
 * lexicon/`_multiCache` taken once, right after the (then-permanent) domain lexicon loaded.
 * `compromise` is imported as a module-global singleton (`import nlp from 'compromise'`), shared
 * by the entire Node process — a host application embedding this package as a library, or another
 * package doing the same thing, can call `nlp.addWords()` directly on that same singleton. A
 * whole-object restore has no way to distinguish "a key this module itself taught" from "a key
 * some other consumer of the shared singleton wrote, before or after this module's baseline
 * snapshot was captured" — it silently deletes the latter (or stomps it back to a stale value).
 * Found by `chatgpt-codex-connector` review against that version; reproduced directly in
 * `test/unit/pos-tags.test.ts` ("leaves a word added by another compromise consumer...") before
 * this fix, using `nlp.addWords()` from the test itself to stand in for the other consumer.
 *
 * Fixed by tracking only the specific keys this call itself wrote, key-by-key, instead of a
 * snapshot of the whole shared object: {@link restoreTracked} puts back exactly what was at each
 * of *this call's own* touched keys (deleting a key that did not exist before, restoring one that
 * did) and leaves every other key in the shared lexicon/`_multiCache` — whoever wrote it,
 * whenever — completely untouched. The `prev` value for each key is captured immediately before
 * that key's own `addWords` call (not once, globally), so it reflects whatever was really there at
 * that moment, including a value some other consumer had already written by then.
 *
 * `written` exists for a second, related bug in that same key-local fix (`chatgpt-codex-connector`,
 * P2): tracking `prev` alone tells this module what to put back, but not whether it is still safe
 * to do so. If another consumer of the shared singleton writes a *newer* value to a key this module
 * also touched — e.g. this package teaches `cache` as a configured verb, and the host then calls
 * `nlp.addWords({ cache: 'Noun' })` — the restore has no way to tell "nothing has touched this key
 * since I wrote it" from "someone wrote something newer since I wrote it", and would unconditionally
 * restore over that newer value either way, discarding it. Recording `written` — a second diff read,
 * immediately after the `addWords` call, of the same candidate keys — fixes that:
 * {@link restoreTracked} only restores a key if its *current* live value still equals `written`; a
 * live value that differs means something else changed it since, and that key is left alone.
 *
 * Populated by diffing a small set of *candidate* keys (the words just taught, plus the first
 * token of any multi-word entry among them, which is `compromise`'s own `_multiCache` key scheme
 * — confirmed directly against `expandLexicon` in
 * `node_modules/compromise/src/1-one/lexicon/methods/expand.js` and
 * `.../2-two/preTagger/methods/expand/index.js`) before and after the `addWords` call, rather than
 * by re-implementing `addWords`'s own internal decision of which keys it touches: for a
 * single-word `'Verb'` entry (the only shape this module ever teaches — no tag in `byTag.js`
 * handles a bare `'Verb'` tag, so no conjugation/expansion runs) `addWords` only ever writes
 * `lexicon[word]`, never `_multiCache`, confirmed directly; the `_multiCache` bookkeeping here
 * exists defensively, for a hypothetical multi-word `extraImperativeVerbs` entry, since nothing in
 * `SteAiConfig` forbids one.
 */
interface LexiconDiff {
  readonly lexicon: Map<string, TouchedKey>;
  readonly multiCache: Map<string, TouchedKey>;
}

function candidateMultiCacheKeysFor(lexiconKeys: readonly string[]): string[] {
  return [
    ...new Set(
      lexiconKeys
        .map((word) => word.split(/\s+/)[0])
        .filter((first): first is string => first !== undefined && first.length > 0),
    ),
  ];
}

/**
 * Teach `lexicon` (a `word -> 'Verb'` `addWords` payload) to the shared singleton and record
 * exactly which `lexicon`/`_multiCache` keys that changed, and to what — see {@link LexiconDiff}.
 * A no-op (no `addWords` call, empty diff) when `lexicon` is empty, which is the common case for
 * the extra/per-configuration lexicon (most sentences in most documents configure no extra verbs).
 */
function teachAndTrack(store: LexiconStore, lexicon: Record<string, string>): LexiconDiff {
  const lexiconKeys = Object.keys(lexicon);
  if (lexiconKeys.length === 0) return { lexicon: new Map(), multiCache: new Map() };

  const multiCacheKeys = candidateMultiCacheKeysFor(lexiconKeys);
  const beforeLexicon = lexiconKeys.map((k) => [k, readKey(store.model.one.lexicon, k)] as const);
  const beforeMultiCache = multiCacheKeys.map(
    (k) => [k, readKey(store.model.one._multiCache, k)] as const,
  );

  nlp.addWords(lexicon);

  const lexiconDiff = new Map<string, TouchedKey>();
  for (const [k, prev] of beforeLexicon) {
    const after = readKey(store.model.one.lexicon, k);
    if (after !== prev) lexiconDiff.set(k, { prev, written: after });
  }
  const multiCacheDiff = new Map<string, TouchedKey>();
  for (const [k, prev] of beforeMultiCache) {
    const after = readKey(store.model.one._multiCache, k);
    if (after !== prev) multiCacheDiff.set(k, { prev, written: after });
  }
  return { lexicon: lexiconDiff, multiCache: multiCacheDiff };
}

/**
 * Undo exactly what one earlier {@link teachAndTrack} call did: put each touched key back to what
 * `compromise` itself had there before that call, or delete it if it had nothing — but only if the
 * key's *current* live value still equals what that call actually wrote there (see
 * {@link LexiconDiff}'s own PROVENANCE for why that guard exists). Every other key in the shared
 * lexicon/`_multiCache` — including any another consumer wrote, before, during, or after — is left
 * untouched.
 */
function restoreTracked(store: LexiconStore, diff: LexiconDiff): void {
  for (const [k, { prev, written }] of diff.lexicon) {
    if (readKey(store.model.one.lexicon, k) === written) writeKey(store.model.one.lexicon, k, prev);
  }
  for (const [k, { prev, written }] of diff.multiCache) {
    if (readKey(store.model.one._multiCache, k) === written) {
      writeKey(store.model.one._multiCache, k, prev);
    }
  }
}

/**
 * Normalised `extraVerbs` entries: lower-cased, blank-filtered, de-duplicated. Each entry is kept
 * intact, including a multi-word phrase's own internal space — never re-split — so a caller can
 * always tell "one phrase" from "several separate words" apart.
 */
function normalizeExtraVerbs(extraVerbs: readonly string[]): string[] {
  return [...new Set(extraVerbs.map((v) => v.toLowerCase()).filter((v) => v.length > 0))];
}

/**
 * Canonical identity of an `extraVerbs` list — same entries, any order or case, same identity.
 *
 * PROVENANCE: an earlier version joined normalised entries with a plain space (`' '`) to build
 * this identity string, and the teaching step then re-split that same joined string on whitespace
 * to decide what to actually teach `compromise` — found by `chatgpt-codex-connector` (P2) to
 * conflate two different things a plain space can mean: the delimiter between separate entries,
 * and a multi-word phrase's own internal space. A configured `["power cycle"]` (one phrase) was
 * taught as the two independent single-word verbs "power" and "cycle" instead of the phrase
 * "power cycle", because the teaching loop split the identity string apart the same way regardless
 * of which entries produced it. Using `\u0000` (a character no real `extraVerbs` entry can contain)
 * as the join delimiter here, instead of a space, is *sufficient* to prevent that specific bug from
 * recurring by fixing this string's own ambiguity, but the actual fix is in
 * {@link extraLexiconDict}: it teaches directly from the normalised entry list (see
 * {@link normalizeExtraVerbs}), never by re-splitting this identity string, so nothing downstream
 * depends on this particular choice of delimiter either way. This identity string now exists only
 * to key the small teach-dict cache below, not to decide what gets restored — restoring happens
 * every call regardless of identity (see {@link withLexicons}).
 */
function extraVerbsKey(extraVerbs: readonly string[]): string {
  return normalizeExtraVerbs(extraVerbs).toSorted().join('\u0000');
}

/**
 * The extra/per-configuration lexicon (see {@link extraVerbsKey}) as an `addWords` payload for one
 * `extraVerbs` configuration: only the entries `compromise` does not already tag as a verb on its
 * own (see {@link alreadyKnownAsVerb}). Cached by `key`, one entry deep — a call requesting the
 * same configuration as the one most recently computed reuses the same dict rather than
 * recomputing `alreadyKnownAsVerb` for every entry again, which is the one piece of the old
 * same-config no-op optimisation that survives the move to restore-after-every-call (see
 * {@link withLexicons}): the teach/restore round trip itself still runs on every call — it has
 * to, so the shared singleton is never left mutated between calls — but the relatively more
 * expensive "which of these words does compromise not already know" computation does not.
 */
let cachedExtraLexicon: { readonly key: string; readonly dict: Record<string, string> } | undefined;

function extraLexiconDict(entries: readonly string[], key: string): Record<string, string> {
  if (cachedExtraLexicon !== undefined && cachedExtraLexicon.key === key) {
    return cachedExtraLexicon.dict;
  }
  const dict: Record<string, string> = {};
  // Teach directly from `entries` — the normalised list, each entry intact — never by re-deriving
  // words from `key`. PROVENANCE (`chatgpt-codex-connector`, P2): an earlier version looped over
  // `key.split(' ')` here, which re-split a multi-word `extraVerbs` entry (e.g. `"power cycle"`)
  // apart on the very same space that joined it to any other entries in `key`, teaching "power"
  // and "cycle" as two independent single-word verbs instead of the phrase "power cycle". See
  // {@link extraVerbsKey}'s own PROVENANCE note.
  for (const verb of entries) {
    if (!alreadyKnownAsVerb(verb)) dict[verb] = 'Verb';
  }
  cachedExtraLexicon = { key, dict };
  return dict;
}

/**
 * Run `fn` with `compromise`'s shared lexicon reflecting exactly this call's domain lexicon (see
 * {@link domainLexiconDict}) and `extraVerbs` (see {@link extraLexiconDict}) — restoring the shared
 * singleton to exactly what it was immediately before, once `fn` (and everything it calls
 * internally) is completely done, before this function returns to *its* caller.
 *
 * `addWords` mutates a lexicon that is `compromise`'s own module-global singleton (see
 * {@link LexiconStore}), not scoped to a document, a configuration, or a call. Every public
 * entry point into this module that queries `compromise` ({@link sentenceOpensImperative},
 * {@link tagByOffset}) routes its own `nlp()` work through this function so that neither the
 * domain lexicon nor any requested extra lexicon is ever left taught once that entry point has
 * returned to its caller — not even until "the next call arrives with a different configuration".
 *
 * PROVENANCE (`chatgpt-codex-connector` round 4, two findings against the previous, lazier design):
 *
 *  - (finding B, `discussion_r3698561014`) the domain lexicon was taught once, permanently, at
 *    module load, and never restored — any process importing this module carried that mutation to
 *    its shared `compromise` singleton forever, whether or not `extraImperativeVerbs` was ever
 *    used.
 *  - (finding A, `discussion_r3698561010`) the extra lexicon's own restore ran lazily, only when a
 *    *later* call arrived with a *different* `extraVerbs` configuration — between the end of one
 *    call and the start of the next differently-configured one, the shared singleton sat mutated,
 *    observable by any other consumer of the same process's `compromise` import during that
 *    window.
 *
 * Both are fixed by the same shape: teach at the start of *this* call's work, restore at the end of
 * *this* call's work, unconditionally, rather than leaving either lexicon taught across a call
 * boundary for any later call (or nothing at all) to clean up. `fn` may call other internal helpers
 * of this module any number of times while both lexicons are taught (e.g. {@link tagByOffset}
 * tagging every term of a multi-sentence document in one pass) — restoration happens exactly once,
 * after `fn` (this call's *entire* body of work) returns or throws, never between two of this
 * module's own internal sub-steps.
 *
 * This does reintroduce, by design, a teach/restore round trip for the domain lexicon on every
 * call — a real cost the previous, permanently-loaded-once design did not pay, accepted here
 * because leaving the domain lexicon taught between calls is exactly finding B. The extra lexicon's
 * relatively more expensive "which entries need teaching" computation is still cached across calls
 * (see {@link extraLexiconDict}), and a call configuring no extra verbs at all — the common case —
 * pays no extra-lexicon `addWords`/restore cost either way, since {@link teachAndTrack} is a no-op
 * on an empty dict.
 */
function withLexicons<T>(extraVerbs: readonly string[], fn: () => T): T {
  const store = lexiconStore();
  const domainDiff = teachAndTrack(store, domainLexiconDict());
  const entries = normalizeExtraVerbs(extraVerbs);
  const key = extraVerbsKey(extraVerbs);
  const extraDiff = teachAndTrack(store, extraLexiconDict(entries, key));
  try {
    return fn();
  } finally {
    restoreTracked(store, extraDiff);
    restoreTracked(store, domainDiff);
  }
}

// ---------------------------------------------------------------------------
// Sentence-opener imperative mood
// ---------------------------------------------------------------------------

/**
 * A leading negative-imperative adverb. `compromise` tags `Never touch...`/`Do not remove...` as
 * `#Imperative` on their bare verb correctly (verified directly), but does *not* tag `Always
 * check the gauge first.` as imperative — the leading adverb defeats its verb-initial heuristic.
 * This prefix check is a documented supplement to `compromise`'s own tagging, not a replacement
 * for it, and matches the previous heuristic's own special case exactly.
 */
const NEGATIVE_IMPERATIVE_PREFIX = /^(?:do not|don't|never|always)\b/i;

/**
 * Words `compromise`'s stock lexicon tags as a possible bare-imperative verb, but that corpus
 * validation against `fixtures/original/*.md` showed produce a false sentence-opener
 * classification: the verb reading is valid general English, but is never the reading in this
 * project's technical prose.
 *
 *  - `vacuum`: PostgreSQL's own maintenance command name ("VACUUM reclaims storage occupied by
 *    dead tuples.") — `compromise` tags capitalised sentence-initial `VACUUM` as `Verb Imperative`
 *    (confirmed directly), which then cascades into mistagging the real verb "reclaims" as a
 *    noun. `vacuum` is deliberately absent from the technical domain lexicon in
 *    `imperative-verbs.ts` for the same reason the file documents for `file`/`place`/`test`/etc:
 *    it is common-noun/proper-noun-shaped and causes frequent misclassification. `compromise`'s
 *    own base lexicon does not share that exclusion, so it is enforced here instead.
 *  - `list`: a heading rendered as a run-on Title Case line ("List Of PRAGMAs
 *    analysis_limit application_id …", `fixtures/original/sqlite-pragma-hard-negative.md`, a
 *    fixture named for exactly this kind of trap) — `compromise` tags `List` as `Verb Imperative`
 *    on its own (confirmed directly), same as any other reading of "List the files." `list` is
 *    absent from the technical domain lexicon for the same common-noun-shaped reason as `vacuum`.
 *
 * This is a small, empirically-justified override list, not a return to list-based detection: it
 * exists to suppress a specific false positive `compromise` produces on its own, not to decide
 * what counts as imperative in the first place.
 */
const FALSE_IMPERATIVE_OPENERS: ReadonlySet<string> = new Set(['vacuum', 'list']);

/**
 * Does `text` open with an imperative-mood verb (a command form), e.g. "Install the driver."?
 *
 * `extraVerbs` are user-configured technical verbs (`extraImperativeVerbs`); they are taught to
 * `compromise` the same way the built-in domain lexicon is, so a configured verb genuinely
 * participates in mood detection rather than being matched by a second, parallel mechanism.
 */
export function sentenceOpensImperative(text: string, extraVerbs: readonly string[] = []): boolean {
  // Deliberately excludes `MASK_CHAR`: a masked run at the very front of `text` can be either
  // decorative structural markup (a blockquote arrow, an emphasis marker) or a protected
  // content-bearing token (an inline-code identifier, a URL, a quantity) standing in the sentence's
  // actual subject position — `sentenceOpensImperative` cannot tell which from the text alone, and
  // the two cases need opposite treatment. Stripping it here unconditionally, the same way leading
  // whitespace is stripped, was found (chatgpt-codex-connector, P2) to treat both alike: on the
  // direct `analyseDocument`/`scanBlocks` path, "`workers` run the service and emit metrics." masks
  // to a run of `MASK_CHAR` standing for the backticked "workers" followed by " run the service...",
  // and skipping straight through it left "run" reading as a bare sentence-opening imperative even
  // though "workers" is the real subject.
  //
  // Leaving `MASK_CHAR` unstripped does not regress the structural-markup case: `compromise`'s own
  // tokeniser silently folds a masked run that is *directly, contiguously* adjacent to the following
  // letters (no separating space — the case for a masked blockquote arrow or emphasis marker, whose
  // protected region also consumes the single space after it) into that word's own token, so the
  // verb is still tagged and found as the sentence's first term regardless (confirmed directly:
  // `nlp('��Install the driver.')` still tags `Install` `Verb Imperative` as its first
  // term). A masked content-bearing token is followed by a real, unmasked space before the next
  // word, so `compromise` tokenises the masked run as its own (non-verb) term instead — which is
  // exactly the "unknown, non-imperative opener" reading this case needs, and every check below
  // (`#Imperative`, the colon-label guard, the bare-verb-tag-set fallback) already treats a
  // non-verb-tagged first term as "not imperative" on its own, with no additional guard required.
  const leading = new RegExp(`^[\\s>*_-]+`, 'u');
  const stripped = text.replace(leading, '');
  if (stripped.length === 0) return false;
  if (NEGATIVE_IMPERATIVE_PREFIX.test(stripped)) return true;
  // Domain + extra lexicon teaching/restoration is scoped to this one call (see
  // {@link withLexicons}): both lexicons are taught before the checks below run and restored
  // before this function returns, so `compromise`'s shared singleton is never left mutated once
  // control passes back to this function's own caller.
  return withLexicons(extraVerbs, () => {
    const first = nlp(stripped).terms().first();
    if (!first.found) return false;
    const firstWord = /^[\p{L}]+/u.exec(stripped)?.[0]?.toLowerCase();
    if (firstWord !== undefined && FALSE_IMPERATIVE_OPENERS.has(firstWord)) return false;
    if (first.has('#Imperative')) return true;
    // A word immediately followed by a colon ("Note:", "Exception:") is a label, not a verb taking
    // an object — confirmed directly: without this guard, "Note: Exception: The employer need not
    // document..." misclassifies as procedural because "Note" alone is a bare present-tense verb.
    if (/^[\p{L}]+:/u.test(stripped)) return false;
    // `compromise` reliably tags a lone sentence-initial imperative ("Install the driver.") but not
    // one that opens a coordinated list of imperatives ("Build, flash, and run a sample
    // application." — confirmed directly: none of the three verbs get `#Imperative` there). A bare
    // (infinitive, non-passive, non-gerund) verb as the very first word of a sentence is otherwise a
    // vanishingly rare shape in declarative English, so it is accepted as the same signal
    // `compromise` itself uses for `#Imperative`, just without the positional condition that is
    // defeating its tagger on this shape. Uses {@link isImperativeOpenerTagSet}, not the broader
    // {@link isBareVerbTagSet}: this is deciding whether the sentence *opens an imperative clause*,
    // exactly the purpose that predicate's own PROVENANCE note says needs the stricter, `Infinitive`
    // -only check.
    const firstTags = firstTermTags(stripped);
    return firstTags !== undefined && isImperativeOpenerTagSet(firstTags);
  });
}

// ---------------------------------------------------------------------------
// Per-word POS tags, aligned by character offset
// ---------------------------------------------------------------------------

/**
 * Tag every term of `text` and index the tags by character start offset within `text`.
 *
 * `compromise`'s own tokeniser does not always agree with this project's `tokenizeWords` at every
 * boundary (contractions and protected-region placeholders in particular); a lookup miss returns
 * `undefined`, and callers ({@link isFunctionWord}, {@link isImperativeVerbWord}) fall back to the
 * closed-class lists rather than guessing.
 */
export function tagByOffset(
  text: string,
  extraVerbs: readonly string[] = [],
): Map<number, readonly string[]> {
  // Domain + extra lexicon teaching/restoration is scoped to this one call (see
  // {@link withLexicons}): both lexicons are taught before `nlp(text)` runs and restored before
  // this function returns, so `compromise`'s shared singleton is never left mutated once control
  // passes back to this function's own caller.
  return withLexicons(extraVerbs, () => {
    const map = new Map<number, readonly string[]>();
    // Same untyped-`.json()` cast as `firstTermTags` above; see its comment for provenance.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const data = nlp(text).json({ offset: true }) as readonly CompromiseOffsetSentence[];
    for (const sentence of data) {
      for (const term of sentence.terms ?? []) {
        if (term.offset === undefined) continue;
        map.set(term.offset.start, term.tags ?? []);
      }
    }
    return map;
  });
}

const FUNCTION_TAGS: ReadonlySet<string> = new Set([
  'Determiner',
  'Preposition',
  'Conjunction',
  'Pronoun',
  'Auxiliary',
  'Modal',
  'Copula',
  'Negative',
  'QuestionWord',
]);

/** Is a tag set from {@link tagByOffset} the tag set of a closed-class function word? */
export function isFunctionTagSet(tags: readonly string[]): boolean {
  return tags.some((t) => FUNCTION_TAGS.has(t));
}

const NON_BARE_VERB_TAGS: ReadonlySet<string> = new Set([
  'Gerund',
  'PastTense',
  'Passive',
  'Participle',
]);

/**
 * Is a tag set from {@link tagByOffset} the tag set of *some kind of* non-passive, non-gerund,
 * non-past-tense verb — a broad "is this word functioning as a verb at all, right now" signal?
 * Excludes gerunds, past-tense and participle forms, which are content words in this project's
 * noun-cluster and antecedent heuristics, not verbs to break a run on.
 *
 * Accepts `PresentTense` on its own, without `Infinitive`: `compromise` tags an inflected
 * third-person finite verb ("removes", "sends", "logs") exactly that way, and for the noun-cluster
 * and antecedent purposes this backs (via {@link isImperativeVerbWord}, both broad "is this a verb"
 * checks — see the PROVENANCE note there), that inflected verb genuinely is a verb and must not be
 * counted as a content word alongside surrounding nouns. **Do not use this for deciding whether a
 * word opens or continues an imperative *clause*** — an inflected finite verb like "sends" answers
 * that question wrong (see {@link isImperativeOpenerTagSet}, the intentionally stricter check for
 * that purpose, found necessary by `chatgpt-codex-connector`, P1, against this predicate).
 */
export function isBareVerbTagSet(tags: readonly string[]): boolean {
  if (!tags.includes('Verb')) return false;
  if (tags.some((t) => NON_BARE_VERB_TAGS.has(t))) return false;
  return tags.includes('Infinitive') || tags.includes('PresentTense');
}

/**
 * Is a tag set from {@link tagByOffset} the tag set of a genuine bare/base-form command verb — the
 * shape that opens an instruction ("Install...") or joins a second instruction ("...and
 * install...")?
 *
 * Stricter than {@link isBareVerbTagSet}: requires `Infinitive`, not `PresentTense` alone.
 * PROVENANCE: found by `chatgpt-codex-connector` (P1) that `isBareVerbTagSet` — used for this exact
 * purpose before this predicate existed — accepted `PresentTense` without `Infinitive`, which is
 * also the tag set `compromise` gives an ordinary inflected third-person finite verb ("removes",
 * "sends", "logs"), not just a genuine bare/imperative form ("install", "remove"). Confirmed
 * directly: in "Install the agent, which logs events and sends reports.", both "logs" and "sends"
 * tag `Verb PresentTense` with no `Infinitive`, so the old check misread "sends" — part of the
 * descriptive relative clause — as a second instruction opener; a genuine second imperative in the
 * same position ("...and format the disk.") keeps `Infinitive`, confirmed directly, including for
 * words taught only through this module's domain lexicon (`nlp.addWords({torque: 'Verb'})` still
 * yields `Infinitive` on "Torque the bolt..." — `compromise`'s own contextual tagger adds it, not
 * `addWords`).
 */
export function isImperativeOpenerTagSet(tags: readonly string[]): boolean {
  if (!tags.includes('Verb')) return false;
  if (tags.some((t) => NON_BARE_VERB_TAGS.has(t))) return false;
  return tags.includes('Infinitive');
}

// ---------------------------------------------------------------------------
// Sentence-scoped lookup, with closed-class-list fallback on an alignment miss
// ---------------------------------------------------------------------------

/**
 * Closed-class function words. PROVENANCE: implementation assumption, an ordinary English
 * function-word list — carried over unchanged from the pre-`compromise` heuristic.
 *
 * Corpus validation against `fixtures/original/*.md` found that `compromise`'s contextual tagger
 * mistags several unambiguous closed-class words even in ordinary sentence context: `no` and `so`
 * tag as `Expression`, `under` as `Adjective` in "is under the exclusive control of" (all
 * confirmed directly, not assumed). Those are not alignment misses — `compromise` produced a tag,
 * it is simply the wrong one. {@link isFunctionWord} therefore checks this list unconditionally
 * as well as `compromise`'s tag, rather than only as a fallback on a lookup miss: `compromise`
 * adds words this list does not cover (see {@link FUNCTION_TAGS}), the list guards against
 * `compromise`'s own tagging errors on the closed class it already knows. That symmetry is
 * deliberate, and it is also this design's known limit: a word this list wrongly includes when
 * used as a content word (the issue that opened this work names `per` as a unit marker and
 * `further` as a comparative adjective) is not fixed by adding `compromise`, because the list
 * still fires unconditionally. `compromise`'s own contextual tag is not enough to override it
 * safely, since the tag is exactly the thing shown to be unreliable here.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'nor',
  'so',
  'yet',
  'for',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'into',
  'onto',
  'upon',
  'over',
  'under',
  'above',
  'below',
  'between',
  'through',
  'during',
  'before',
  'after',
  'while',
  'until',
  'since',
  'about',
  'against',
  'among',
  'around',
  'as',
  'because',
  'if',
  'then',
  'than',
  'that',
  'this',
  'these',
  'those',
  'there',
  'here',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'whose',
  'what',
  'why',
  'how',
  'not',
  'no',
  'all',
  'any',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'only',
  'own',
  'same',
  'too',
  'very',
  'can',
  'will',
  'just',
  'should',
  'now',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'do',
  'does',
  'did',
  'doing',
  'would',
  'could',
  'may',
  'might',
  'must',
  'shall',
  'it',
  'its',
  'they',
  'them',
  'their',
  'you',
  'your',
  'we',
  'our',
  'us',
  'he',
  'him',
  'his',
  'she',
  'her',
  'i',
  'me',
  'my',
  'also',
  'per',
  'via',
  'etc',
  'ie',
  'eg',
  'out',
  'up',
  'down',
  'off',
  'again',
  'further',
]);

/** A per-sentence cache of `compromise` POS tags, keyed by absolute source offset. */
export interface SentencePosIndex {
  tagsAt(sourceStart: number): readonly string[] | undefined;
}

/**
 * Build a {@link SentencePosIndex} for `sentence`. Tags `sentence.masked`, so protected content
 * never reaches `compromise` — masked runs simply produce no useful terms, and every `Word` with
 * `protectedKind` set should be excluded by callers before ever consulting the index.
 */
export function buildSentencePosIndex(
  sentence: Sentence,
  extraVerbs: readonly string[] = [],
): SentencePosIndex {
  const byRelativeOffset = tagByOffset(sentence.masked, extraVerbs);
  return {
    tagsAt(sourceStart: number): readonly string[] | undefined {
      return byRelativeOffset.get(sourceStart - sentence.range.start);
    },
  };
}

/**
 * Is `word` a closed-class function word in this sentence?
 *
 * True if either `compromise`'s contextual tag for this exact occurrence says so, or `word` is a
 * member of the closed-class {@link FUNCTION_WORDS} list. See that list's comment for why this is
 * a union rather than a tag-first-list-as-fallback design.
 */
export function isFunctionWord(word: Word, index: SentencePosIndex): boolean {
  const tags = index.tagsAt(word.range.start);
  if (tags !== undefined && isFunctionTagSet(tags)) return true;
  return FUNCTION_WORDS.has(word.lower);
}

/**
 * Verbs `compromise` correctly tags as a bare infinitive/present-tense verb, but that are far more
 * often auxiliaries than action verbs in ordinary prose, and were therefore deliberately absent
 * from {@link IMPERATIVE_VERBS} in the first place.
 *
 * Corpus validation caught a real regression from omitting this guard: in
 * `fixtures/annotations/osha-ppe-requirements.json`, "Select, and have each affected employee
 * use, the types of PPE…" is annotated as a `one-instruction-per-sentence` **candidate** that a
 * reviewer confirmed as a real violation — i.e. the deterministic layer is meant to flag the shape
 * and hand it to semantic adjudication, per this project's candidate/adjudication architecture.
 * Treating "have" as an ordinary bare-form action verb (which `compromise` tags it as, correctly,
 * in isolation) instead made the conjunction path in `one-instruction-per-sentence` assert an
 * immediate `deterministic-violation` on this sentence, skipping adjudication entirely — the
 * verdict happened to be right, but for the wrong architectural reason, and would misfire on
 * ordinary descriptive prose that uses "have" as an auxiliary next to an unrelated "and".
 */
const AMBIGUOUS_AUXILIARY_VERBS: ReadonlySet<string> = new Set([
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'be',
  'being',
  'been',
  'get',
  'gets',
  'got',
  'go',
  'goes',
]);

/**
 * Is `word` functioning as *some kind of* verb in this sentence — the broad signal the noun-cluster
 * and antecedent heuristics need (a verb interrupts a run of content-word nouns; a verb is never a
 * pronoun's antecedent), not specifically a command form?
 *
 * True if either `compromise`'s contextual tag says so — which also covers ordinary English verbs
 * outside the technical domain lexicon, e.g. "wipe"/"trim", never enumerated in
 * {@link IMPERATIVE_VERBS} — or `word` is a member of that list, which still guards the small
 * number of technical verbs `compromise` cannot resolve from context alone.
 * {@link AMBIGUOUS_AUXILIARY_VERBS} is excluded from the tag-based signal for the reason given on
 * its own comment.
 *
 * **Do not use this to decide whether `word` opens or continues an imperative clause** (a second
 * instruction after a conjunction or a comma) — its tag-based signal, {@link isBareVerbTagSet},
 * accepts an inflected third-person finite verb ("sends", "logs") that is not a command form; use
 * {@link isImperativeOpenerWord} for that purpose instead. See {@link isBareVerbTagSet}'s own
 * PROVENANCE note.
 */
export function isImperativeVerbWord(word: Word, index: SentencePosIndex): boolean {
  const tags = index.tagsAt(word.range.start);
  if (tags !== undefined && isBareVerbTagSet(tags) && !AMBIGUOUS_AUXILIARY_VERBS.has(word.lower)) {
    return true;
  }
  return IMPERATIVE_VERBS.has(word.lower);
}

/**
 * Is `word` a genuine bare/base-form command verb in this sentence — the shape that opens or
 * continues an *imperative clause* (a second instruction, after a conjunction or a comma)?
 *
 * PROVENANCE: split out from {@link isImperativeVerbWord} (`chatgpt-codex-connector`, P1): that
 * function's tag-based signal, {@link isBareVerbTagSet}, accepts `PresentTense` without
 * `Infinitive` — the tag set `compromise` gives an inflected third-person finite verb ("sends",
 * "logs"), not just a genuine bare/imperative form. Used for the noun-cluster/antecedent heuristics
 * that need "is this any kind of verb" — correctly, since an inflected finite verb like "sends" is
 * still a verb for those purposes — that same broad signal wrongly read the "sends" in "Install the
 * agent, which logs events and sends reports." as a second instruction opener, because it sits right
 * after the conjunction "and". This function uses {@link isImperativeOpenerTagSet} instead, which
 * requires `Infinitive`, so only a genuine command-form verb ("...and format the disk.") counts.
 * {@link AMBIGUOUS_AUXILIARY_VERBS} and the {@link IMPERATIVE_VERBS} list fallback are unchanged
 * from {@link isImperativeVerbWord} — both apply identically to a bare command-form check.
 */
export function isImperativeOpenerWord(word: Word, index: SentencePosIndex): boolean {
  const tags = index.tagsAt(word.range.start);
  if (
    tags !== undefined &&
    isImperativeOpenerTagSet(tags) &&
    !AMBIGUOUS_AUXILIARY_VERBS.has(word.lower)
  ) {
    return true;
  }
  return IMPERATIVE_VERBS.has(word.lower);
}
