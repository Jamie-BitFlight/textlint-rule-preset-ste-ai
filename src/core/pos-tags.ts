import nlp from 'compromise';
import { IMPERATIVE_VERBS } from './imperative-verbs.js';
import { MASK_CHAR } from './text.js';
import type { Sentence, Word } from './types.js';

/**
 * POS-tagging substrate for the old `IMPERATIVE_VERBS`/`FUNCTION_WORDS` list-membership checks.
 *
 * PROVENANCE: backed by the `compromise` npm package (real grammatical tagging: mood, tense,
 * word class), not by enumeration. `compromise`'s general-English lexicon does not know most of
 * this project's technical/procedural vocabulary out of the box (`torque`, `flash`, `mark` as a
 * verb, `source`, `sync`, `query`, `rebase`, `unset`, `serialise` all default to a non-verb
 * reading until taught) — confirmed by direct testing against the installed package, not assumed.
 * `IMPERATIVE_VERBS` therefore survives as a **domain lexicon**, taught to `compromise` once via
 * `addWords` so its own context-sensitive tagger decides, per occurrence, whether a taught word
 * is actually functioning as a verb here (`record` still tags as `Noun` in "the maintenance
 * record", `Verb` in "Record the value" — verified directly; `addWords` teaches a possible tag,
 * it does not force one). The list also backs the small fallback described on
 * {@link isImperativeVerbWord} below.
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
  const data = nlp(text).json() as readonly CompromiseOffsetSentence[];
  return data[0]?.terms?.[0]?.tags;
}

let domainLexiconLoaded = false;

/** Does `compromise`, unmodified, already tag `word` (in isolation) as a verb? */
function alreadyKnownAsVerb(word: string): boolean {
  const tags = firstTermTags(word);
  return tags !== undefined && tags.includes('Verb');
}

function ensureDomainLexicon(): void {
  if (domainLexiconLoaded) return;
  const lexicon: Record<string, string> = {};
  for (const verb of IMPERATIVE_VERBS) {
    if (!alreadyKnownAsVerb(verb)) lexicon[verb] = 'Verb';
  }
  if (Object.keys(lexicon).length > 0) nlp.addWords(lexicon);
  domainLexiconLoaded = true;
}

ensureDomainLexicon();

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
 * Exactly which `lexicon`/`_multiCache` keys {@link ensureExtraLexicon}'s own most recent
 * `addWords` call actually changed, and what was in each one immediately before that call —
 * `ABSENT` if the key did not exist yet.
 *
 * PROVENANCE: an earlier version of this fix instead restored a whole-object snapshot of the
 * shared lexicon/`_multiCache` taken once, right after the permanent domain lexicon loaded.
 * `compromise` is imported as a module-global singleton (`import nlp from 'compromise'`), shared
 * by the entire Node process — a host application embedding this package as a library, or another
 * package doing the same thing, can call `nlp.addWords()` directly on that same singleton. A
 * whole-object restore has no way to distinguish "a key this module itself taught for the
 * previous configuration" from "a key some other consumer of the shared singleton wrote, before
 * or after this module's baseline snapshot was captured" — it silently deletes the latter (or
 * stomps it back to a stale value) the next time a configuration switch runs a restore. Found by
 * `chatgpt-codex-connector` review against that version; reproduced directly in
 * `test/unit/pos-tags.test.ts` ("leaves a word added by another compromise consumer...") before
 * this fix, using `nlp.addWords()` from the test itself to stand in for the other consumer.
 *
 * Fixed by tracking only the specific keys this module itself last wrote, key-by-key, instead of
 * a snapshot of the whole shared object: before teaching a new configuration's words,
 * {@link ensureExtraLexicon} puts back exactly what was at each of *its own* previously-touched
 * keys (deleting a key that did not exist before, restoring one that did) and leaves every other
 * key in the shared lexicon/`_multiCache` — whoever wrote it, whenever — completely untouched.
 * The "before" value for each key is captured immediately before that key's own `addWords` call
 * (not once, globally), so it reflects whatever was really there at that moment, including a
 * value some other consumer had already written by then.
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
let taughtLexiconKeys = new Map<string, KeyValue>();
let taughtMultiCacheKeys = new Map<string, KeyValue>();

/** Canonical identity of an `extraVerbs` list — same words, any order or case, same identity. */
function extraVerbsKey(extraVerbs: readonly string[]): string {
  return [...new Set(extraVerbs.map((v) => v.toLowerCase()).filter((v) => v.length > 0))]
    .sort()
    .join(' ');
}

/** The `extraVerbs` configuration currently taught to `compromise`'s shared lexicon, if any. */
let activeExtraKey = '';

/**
 * Make `compromise`'s shared lexicon reflect exactly this call's `extraVerbs` and nothing another
 * call taught it — without touching any lexicon/`_multiCache` key this module itself did not add.
 *
 * `addWords` mutates a lexicon that is `compromise`'s own module-global singleton (see
 * {@link LexiconStore}), not scoped to a document or a configuration. Left as a one-way ratchet —
 * teach and never untach, the original design — a word from one document's
 * `extraImperativeVerbs` stayed "known" as a verb for every later document analysed in the same
 * process, including one with a different configuration or none at all: which rule fired, and
 * which limit applied, then depended on analysis order rather than on that run's own
 * configuration (found via `test/integration/reader-wiring.test.ts` and
 * `test/unit/pos-tags.test.ts`, both reproducing it directly).
 *
 * Fixed by resynchronising on every call instead: undo exactly what the *previous* call taught
 * (see {@link taughtLexiconKeys}), then teach only the words this call actually asked for. Safe
 * to do unconditionally because every call site in this codebase now passes its own
 * `extraImperativeVerbs` explicitly (`RuleInput.extraImperativeVerbs`, threaded from
 * `SteAiConfig`) rather than relying on an earlier, unrelated call having taught the word. A call
 * requesting the same configuration as the one currently active is a no-op, so repeated calls for
 * one document (the common case — most sentences in most documents configure no extra verbs at
 * all) do not pay a restore/reteach cost.
 */
function ensureExtraLexicon(extraVerbs: readonly string[]): void {
  const key = extraVerbsKey(extraVerbs);
  if (key === activeExtraKey) return;

  const store = lexiconStore();

  // Undo exactly what the previous call taught: put each touched key back to what compromise
  // itself had there before that call, or delete it if it had nothing. Every other key in the
  // shared lexicon/`_multiCache` — including any another consumer of this shared `compromise`
  // instance wrote, before or after this module last ran — is left untouched.
  for (const [k, prev] of taughtLexiconKeys) writeKey(store.model.one.lexicon, k, prev);
  for (const [k, prev] of taughtMultiCacheKeys) writeKey(store.model.one._multiCache, k, prev);
  taughtLexiconKeys = new Map();
  taughtMultiCacheKeys = new Map();

  if (key.length > 0) {
    const lexicon: Record<string, string> = {};
    for (const verb of key.split(' ')) {
      if (!alreadyKnownAsVerb(verb)) lexicon[verb] = 'Verb';
    }
    if (Object.keys(lexicon).length > 0) {
      // Candidate keys this call's `addWords` might touch: the words themselves, plus the first
      // token of any multi-word entry among them (see {@link taughtLexiconKeys} for why). Captured
      // before the call and diffed after, rather than assumed, so exactly what `addWords` actually
      // changed is recorded — no more, no less.
      const candidateLexiconKeys = Object.keys(lexicon);
      const candidateMultiCacheKeys = [
        ...new Set(
          candidateLexiconKeys
            .map((word) => word.split(/\s+/)[0])
            .filter((first): first is string => first !== undefined && first.length > 0),
        ),
      ];

      const beforeLexicon = candidateLexiconKeys.map(
        (k) => [k, readKey(store.model.one.lexicon, k)] as const,
      );
      const beforeMultiCache = candidateMultiCacheKeys.map(
        (k) => [k, readKey(store.model.one._multiCache, k)] as const,
      );

      nlp.addWords(lexicon);

      for (const [k, prev] of beforeLexicon) {
        if (readKey(store.model.one.lexicon, k) !== prev) taughtLexiconKeys.set(k, prev);
      }
      for (const [k, prev] of beforeMultiCache) {
        if (readKey(store.model.one._multiCache, k) !== prev) taughtMultiCacheKeys.set(k, prev);
      }
    }
  }
  activeExtraKey = key;
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
  const leading = new RegExp(`^[\\s${MASK_CHAR}>*_-]+`, 'u');
  const stripped = text.replace(leading, '');
  if (stripped.length === 0) return false;
  if (NEGATIVE_IMPERATIVE_PREFIX.test(stripped)) return true;
  ensureExtraLexicon(extraVerbs);
  const first = nlp(stripped).terms().first();
  if (first.found === false) return false;
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
  // (infinitive/present-tense, non-passive, non-gerund) verb as the very first word of a sentence
  // is otherwise a vanishingly rare shape in declarative English, so it is accepted as the same
  // signal `compromise` itself uses for `#Imperative`, just without the positional condition that
  // is defeating its tagger on this shape.
  const firstTags = firstTermTags(stripped);
  return firstTags !== undefined && isBareVerbTagSet(firstTags);
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
  ensureExtraLexicon(extraVerbs);
  const map = new Map<number, readonly string[]>();
  const data = nlp(text).json({ offset: true }) as readonly CompromiseOffsetSentence[];
  for (const sentence of data) {
    for (const term of sentence.terms ?? []) {
      if (term.offset === undefined) continue;
      map.set(term.offset.start, term.tags ?? []);
    }
  }
  return map;
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
 * Is a tag set from {@link tagByOffset} the tag set of a bare/base-form action verb — the shape
 * that opens an instruction ("Install...") or joins a second instruction ("...and install...")?
 * Excludes gerunds, past-tense and participle forms, which are content words in this project's
 * noun-cluster and antecedent heuristics, not command verbs.
 */
export function isBareVerbTagSet(tags: readonly string[]): boolean {
  if (!tags.includes('Verb')) return false;
  if (tags.some((t) => NON_BARE_VERB_TAGS.has(t))) return false;
  return tags.includes('Infinitive') || tags.includes('PresentTense');
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
 * Is `word` a bare/base-form action verb in this sentence?
 *
 * True if either `compromise`'s contextual tag says so — which also covers ordinary English verbs
 * outside the technical domain lexicon, e.g. "wipe"/"trim", never enumerated in
 * {@link IMPERATIVE_VERBS} — or `word` is a member of that list, which still guards the small
 * number of technical verbs `compromise` cannot resolve from context alone.
 * {@link AMBIGUOUS_AUXILIARY_VERBS} is excluded from the tag-based signal for the reason given on
 * its own comment.
 */
export function isImperativeVerbWord(word: Word, index: SentencePosIndex): boolean {
  const tags = index.tagsAt(word.range.start);
  if (tags !== undefined && isBareVerbTagSet(tags) && !AMBIGUOUS_AUXILIARY_VERBS.has(word.lower)) {
    return true;
  }
  return IMPERATIVE_VERBS.has(word.lower);
}
