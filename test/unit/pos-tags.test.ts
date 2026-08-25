import nlp from 'compromise';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { sentenceOpensImperative, tagByOffset } from '../../src/core/pos-tags.js';
import { MASK_CHAR } from '../../src/core/text.js';

// ---------------------------------------------------------------------------
// The shared `compromise` singleton: reading it, and putting back exactly what
// this file itself writes to it directly (see `simulateHostAddWords` below)
// ---------------------------------------------------------------------------

interface SharedStores {
  lexicon: Record<string, unknown>;
  _multiCache: Record<string, unknown>;
}

function sharedStores(): SharedStores {
  // Same untyped `nlp.world()` reach-into as `lexiconStore()` in `src/core/pos-tags.ts`, needed
  // here to verify what that module actually wrote to (and restored in) the shared singleton.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (nlp.world() as unknown as { model: { one: SharedStores } }).model.one;
}

function sharedLexicon(): Record<string, unknown> {
  return sharedStores().lexicon;
}

/** Keys where `live` no longer says what `snapshot` said — added, removed, or changed. */
function driftedKeys(live: Record<string, unknown>, snapshot: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(live), ...Object.keys(snapshot)]);
  return [...keys].filter((key) => {
    const inLive = Object.prototype.hasOwnProperty.call(live, key);
    const inSnapshot = Object.prototype.hasOwnProperty.call(snapshot, key);
    if (inLive !== inSnapshot) return true;
    return live[key] !== snapshot[key];
  });
}

/** A shallow copy of both stores `addWords` writes into, as of the moment it was taken. */
interface StoreSnapshot {
  readonly lexicon: Record<string, unknown>;
  readonly multiCache: Record<string, unknown>;
}

function snapshotStores(): StoreSnapshot {
  const stores = sharedStores();
  return { lexicon: { ...stores.lexicon }, multiCache: { ...stores._multiCache } };
}

/**
 * Every key in either shared store that no longer matches `snapshot`, labelled by the store it
 * came from — an empty array means the process-global singleton says exactly what it said then.
 * Returned as data rather than asserted in here, so that a failure names the leaked words.
 *
 * Deliberately full-object: this is called exactly twice in the whole file (once to capture
 * {@link PRISTINE} at load time, once by `shared compromise singleton isolation` at the very end),
 * not per test — `compromise`'s base lexicon alone is ~25k entries (confirmed directly), so a
 * shallow copy of it is real but one-off cost, not something to pay on every one of this file's 30
 * tests. The two tests that deliberately mutate the singleton are cleaned up individually by
 * {@link simulateHostAddWords}'s own `afterEach` instead, at O(1) per test.
 */
function driftFrom(snapshot: StoreSnapshot): string[] {
  const stores = sharedStores();
  return [
    ...driftedKeys(stores.lexicon, snapshot.lexicon).map((key) => `lexicon.${key}`),
    ...driftedKeys(stores._multiCache, snapshot.multiCache).map((key) => `_multiCache.${key}`),
  ];
}

/**
 * The shared singleton exactly as this file found it, captured before any test in it has run.
 * `compromise` is imported as one process-global object (`src/core/pos-tags.ts` documents this at
 * length), so anything this file leaves taught, it leaves taught for every test that runs after
 * it in the same process. Two tests below deliberately teach it, standing in for another consumer
 * of the same singleton; `simulateHostAddWords` below undoes each such write individually, and
 * `shared compromise singleton isolation` at the end of the file checks the net result against
 * this snapshot.
 */
const PRISTINE: StoreSnapshot = snapshotStores();

// ---------------------------------------------------------------------------
// Simulating another `compromise` consumer sharing this process's singleton
// ---------------------------------------------------------------------------

interface DirectWrite {
  readonly key: string;
  readonly hadKey: boolean;
  readonly prevValue: unknown;
}

let pendingDirectWrites: DirectWrite[] = [];

/**
 * Call `nlp.addWords` directly on the shared singleton, exactly as a host application or another
 * package sharing this process's `compromise` import would — bypassing this project's own
 * `withLexicons` entirely — and record enough to put the key back the way it was. Restoration
 * happens in the module-level `afterEach` below, not here: the write must survive for the rest of
 * the test that called this (that is the point of the two tests that use it), and the restore must
 * still run even if that test's own assertions throw partway through.
 */
function simulateHostAddWords(word: string, tag: string): void {
  const lexicon = sharedLexicon();
  const hadKey = Object.prototype.hasOwnProperty.call(lexicon, word);
  pendingDirectWrites.push({ key: word, hadKey, prevValue: lexicon[word] });
  nlp.addWords({ [word]: tag });
}

// An `afterEach`, not a trailing statement inside the tests that call `simulateHostAddWords`: the
// restore has to run even when the test that mutated the singleton failed part-way through, or one
// red test turns into a cascade of unrelated red tests in everything that runs after it. A no-op,
// O(1) check for the other ~28 tests in this file that never call `simulateHostAddWords`.
afterEach(() => {
  const lexicon = sharedLexicon();
  for (const { key, hadKey, prevValue } of pendingDirectWrites) {
    // Restore the PRIOR value, never a blind delete: a key that existed before keeps whatever it
    // said then, and only a key that did not exist before is removed.
    if (hadKey) lexicon[key] = prevValue;
    else delete lexicon[key];
  }
  pendingDirectWrites = [];
});

// ---------------------------------------------------------------------------
// sentenceOpensImperative: the plain (sentence, extraVerbs?) -> boolean cases
// ---------------------------------------------------------------------------

interface OpenerCase {
  readonly name: string;
  readonly text: string;
  readonly extraVerbs?: readonly string[];
  readonly expected: boolean;
}

const OPENER_CASES: readonly OpenerCase[] = [
  {
    name: 'an ordinary sentence-initial imperative',
    text: 'Install the driver before you continue.',
    expected: true,
  },

  // Confirmed directly: without the domain lexicon, `compromise` tags "Torque" as a bare Noun.
  {
    name: 'a domain verb the compromise base lexicon does not know on its own',
    text: 'Torque the bolt to 25 Nm.',
    expected: true,
  },

  // A leading "Do not"/"Never"/"Always" is imperative. `compromise` does not tag the "Always" case
  // as `#Imperative` on its own — the leading adverb defeats its verb-initial heuristic.
  {
    name: 'a leading "Do not"',
    text: 'Do not remove the cover while power is connected.',
    expected: true,
  },
  {
    name: 'a leading contracted "Don’t"',
    text: "Don't remove the cover while power is connected.",
    expected: true,
  },
  { name: 'a leading "Never"', text: 'Never touch the terminal.', expected: true },
  { name: 'a leading "Always"', text: 'Always check the pressure gauge first.', expected: true },

  // Neither "wipe" nor "trim" is in `IMPERATIVE_VERBS` — this is real recall the hardcoded list
  // never had, not just parity with it.
  {
    name: 'a verb the closed list never enumerated, that compromise knows on its own ("wipe")',
    text: 'Wipe the sensor lens before recalibrating.',
    expected: true,
  },
  {
    name: 'a verb the closed list never enumerated, that compromise knows on its own ("trim")',
    text: 'Trim the excess cable.',
    expected: true,
  },

  // Confirmed directly: `compromise` does not put an `#Imperative` tag on any of "Build", "flash"
  // or "run" in this sentence, even though the shape is a textbook coordinated instruction list.
  // `sentenceOpensImperative` recovers this from the bare-verb tag of the very first word instead
  // of relying on `#Imperative` alone.
  {
    name: 'a coordinated imperative list, which compromise does not tag #Imperative on its own',
    text: 'Build, flash, and run a sample application.',
    expected: true,
  },

  {
    name: 'a user-configured extra imperative verb',
    text: 'Reticulate the splines before shipping the part.',
    extraVerbs: ['reticulate'],
    expected: true,
  },

  {
    name: 'not a passive-voice sentence opener',
    text: 'The driver is installed before you continue.',
    expected: false,
  },

  // Regression: without a colon guard, "Note" alone is a bare present-tense verb and the
  // coordinated-list fallback above would misclassify this as procedural.
  {
    name: 'not a label ("Note:", "Exception:")',
    text: 'Note: Exception: the employer need not document the required procedure.',
    expected: false,
  },

  // Regression found via fixtures/original/sqlite-pragma-hard-negative.md: "List Of PRAGMAs ..."
  // is a heading rendered as a run-on line, not an instruction to list something.
  {
    name: 'not a Title Case heading',
    text: 'List Of PRAGMAs analysis_limit application_id auto_vacuum.',
    expected: false,
  },

  // Regression found via fixtures/original/postgres-vacuum-overview.md: `compromise` tags
  // capitalised sentence-initial "VACUUM" as Verb+Imperative on its own, which then makes it
  // mistag the real verb "reclaims" as a noun.
  {
    name: 'not a capitalised technical term that collides with a common verb',
    text: 'VACUUM reclaims storage occupied by dead tuples.',
    expected: false,
  },

  // Regression (chatgpt-codex-connector, P2, r3700698040): the "vacuum"/"list" false-positive
  // suppression used to apply unconditionally, so a project that explicitly configured
  // `extraImperativeVerbs: ['vacuum']` (e.g. to treat "VACUUM the table." as a command in its own
  // SQL-heavy docs) had that configuration silently overridden back to descriptive. The third row
  // is the control: unconfigured, the suppression still applies as before.
  {
    name: 'a configured extra verb overriding the corpus-specific suppression list ("vacuum")',
    text: 'Vacuum the table.',
    extraVerbs: ['vacuum'],
    expected: true,
  },
  {
    name: 'a configured extra verb overriding the corpus-specific suppression list ("list")',
    text: 'List the files.',
    extraVerbs: ['list'],
    expected: true,
  },
  {
    name: 'the corpus-specific suppression still applying when nothing configured the verb',
    text: 'Vacuum the table.',
    expected: false,
  },

  // NOT a guarantee — a limitation this function is documented to have, recorded here so that
  // fixing it produces a named, self-explaining failure ("the known limitation no longer holds")
  // rather than a mysterious red test somebody restores the old behaviour to satisfy. The input is
  // a real one: only the first word is examined, so a sentence whose real grammatical subject is a
  // later clause reads as an imperative. If this row ever goes red, the correct response is to
  // delete the row and celebrate, not to put the limitation back.
  {
    name: 'KNOWN LIMITATION, not a guarantee: only the sentence opener is examined, so a later-clause subject still reads as imperative',
    text: 'Record the value is stored in flash.',
    expected: true,
  },

  // Regression (chatgpt-codex-connector, P2): on the direct `analyseDocument`/`scanBlocks` path,
  // protected content (e.g. an inline-code identifier) is already replaced with `MASK_CHAR` before
  // this function runs. The old leading-strip regex discarded a whole leading run of `MASK_CHAR`
  // the same way it discards structural whitespace/markup (`>`, `*`, `_`, `-`), so a masked
  // identifier sitting in subject position was skipped straight through to the verb that follows
  // it — "`workers` run the service and emit metrics." (masked: a run of `MASK_CHAR` standing in
  // for the backticked "workers", then " run the service...") was analysed as if it opened with
  // "run", a bare imperative verb.
  {
    name: 'not a leading masked protected token treated as if it were structural whitespace',
    text: `${MASK_CHAR.repeat(9)} run the service and emit metrics.`,
    expected: false,
  },

  // Contrast case for the row above: a masked structural marker (e.g. a blockquote arrow) that is
  // immediately, contiguously followed by the verb — no separating space, unlike a masked
  // content-bearing token — must not stop the opener from being recognised.
  {
    name: 'an imperative whose leading structural markup is masked with no gap before the verb',
    text: `${MASK_CHAR.repeat(2)}Install the driver.`,
    expected: true,
  },
];

describe('sentenceOpensImperative', () => {
  it.each(OPENER_CASES)('$name', ({ text, extraVerbs, expected }) => {
    expect(sentenceOpensImperative(text, extraVerbs ?? [])).toBe(expected);
  });

  // Regression (chatgpt-codex-connector, P2): `extraVerbsKey()` joins a normalised `extraVerbs`
  // list with spaces to build a single cache-identity string, and `ensureExtraLexicon` then split
  // that identity string back on whitespace to decide what to teach — conflating a multi-word
  // phrase's own internal space with the delimiter used to join separate entries together. A
  // configured `["gadget widget"]` (one two-word phrase) was therefore taught as two independent
  // single-word verbs, "gadget" and "widget", rather than as the phrase "gadget widget".
  //
  // "gadget"/"widget": confirmed directly that `compromise` tags both as `Noun Singular` on their
  // own, and does not guess either as a verb, so either one only reads as an imperative opener
  // here because `extraVerbs` taught it to. That is the entire requirement on the word choice, and
  // this pair now satisfies it by choice rather than by constraint: the pair also used to have to
  // avoid "gizmo", which the "another compromise consumer" test below taught to the process-global
  // singleton permanently. The file-level `afterEach` restore above ended that leak, so "gizmo" is
  // free again — it is simply not used here, because this case needs a two-word phrase and
  // gadget/widget already meet the requirement.
  it('teaches a multi-word extraImperativeVerbs entry as one phrase, not as separate words', () => {
    const extraVerbs = ['gadget widget'];
    // The phrase itself, used together, must open an imperative.
    expect(sentenceOpensImperative('Gadget widget the device before shipping.', extraVerbs)).toBe(
      true,
    );
    // Neither word alone — taught only as part of the phrase — should read as a verb by itself.
    expect(sentenceOpensImperative('Widget the gadget before shipping.', extraVerbs)).toBe(false);
    expect(sentenceOpensImperative('Gadget the widget before shipping.', extraVerbs)).toBe(false);
  });

  it('gives a one-phrase multi-word entry a different active configuration than its words split apart', () => {
    // `["gadget widget"]` (one phrase) and `["gadget", "widget"]` (two separate verbs) must not
    // collapse to the same taught state: switching between them must actually re-teach.
    expect(sentenceOpensImperative('Widget the gadget before shipping.', ['gadget', 'widget'])).toBe(
      true,
    );
    expect(sentenceOpensImperative('Widget the gadget before shipping.', ['gadget widget'])).toBe(
      false,
    );
  });

  // Regression: `addWords` teaches `compromise`'s shared, module-global lexicon. A word taught for
  // one call's `extraVerbs` must not still be "known" as a verb on a later call that configures no
  // extra verbs at all (or a different set) — that would make classification depend on what some
  // earlier, unrelated call happened to teach, not on this call's own arguments.
  //
  // "cache" and not "reticulate" (used above): `compromise`'s own unknown-word guesser already
  // tags a capitalised sentence-initial nonsense or rare word as `Verb Imperative` regardless of
  // any teaching — confirmed directly ("Zorbulate the device." tags `zorbulate` `Verb Imperative`
  // with no lexicon entry at all) — so a word like that would pass this assertion even with the
  // leak still present, proving nothing. "cache" is a real English noun `compromise` already
  // recognises on its own (tags `Noun`, confirmed directly) and does not guess as a verb, so it
  // only reads as an imperative opener here because `extraVerbs` taught it to.
  it('does not let one call’s extraVerbs leak into a later call with a different configuration', () => {
    expect(sentenceOpensImperative('Cache the response before returning.', ['cache'])).toBe(true);
    expect(sentenceOpensImperative('Cache the response before returning.')).toBe(false);
  });

  // Regression: `compromise` is imported as a module-global singleton (`import nlp from
  // 'compromise'`), shared by the whole Node process. If this package is used as a library inside
  // a larger application that also calls `nlp.addWords()` directly, the fix above (restore a
  // whole-object snapshot taken once, back when `ensureExtraLexicon` first ran) deletes every
  // lexicon/`_multiCache` key that consumer added *after* that snapshot was captured, the next
  // time `ensureExtraLexicon` runs with a different configuration -- silently destroying another
  // consumer's vocabulary this module never taught and has no business touching.
  //
  // "gizmo" (not "cache", not "reticulate", not in `IMPERATIVE_VERBS`): confirmed directly that
  // `compromise` tags it `Noun Singular` on its own and does not guess it as a verb, so — like
  // "cache" above — it only reads as an imperative opener here because something taught it to.
  //
  // The `simulateHostAddWords` call below writes straight to the process-global singleton, on
  // purpose: that is the scenario. The module-level `afterEach` takes it back out again, so the
  // word is taught for the duration of this one test rather than for the rest of the process.
  it('leaves a word added by another compromise consumer sharing this process intact across a restore/reteach cycle', () => {
    // Simulate a host application (or another package) that shares this process's one
    // `compromise` singleton and calls `addWords` directly, bypassing this module entirely.
    simulateHostAddWords('gizmo', 'Verb');
    expect(sentenceOpensImperative('Gizmo the widget before shipping.')).toBe(true);

    // Force `ensureExtraLexicon`'s restore/reteach cycle to run twice, by switching this module's
    // own `extraImperativeVerbs` configuration.
    sentenceOpensImperative('Torque the bolt.', ['reticulate']);
    sentenceOpensImperative('Torque the bolt.', ['cache']);

    // The other consumer's word must still be known: this module's own restore must never delete
    // a key it did not itself add.
    expect(sentenceOpensImperative('Gizmo the widget before shipping.')).toBe(true);
  });

  // Regression (chatgpt-codex-connector, P2): the key-local restore fix above tracks which keys
  // this module itself touched and what was there *before* its own write, but — until this fix —
  // not what this module itself *wrote*. If another consumer of the shared `compromise` singleton
  // writes a *newer* value to that exact same key after this module wrote it — e.g. this package
  // teaches "sprocket" as a configured verb, then a host application calls
  // `nlp.addWords({ sprocket: 'Adjective' })` — the next configuration switch could not tell that
  // apart from "nothing has touched this key since", and unconditionally restored over the host's
  // newer value, discarding it.
  //
  // "sprocket" (not "cache"/"reticulate"/"gizmo", used above): confirmed directly that `compromise`
  // tags it `Noun Singular` on its own and does not guess it as a verb.
  //
  // As above, the `simulateHostAddWords` call is a deliberate write to the process-global
  // singleton, undone for the rest of the process by the module-level `afterEach`.
  it('does not restore over a newer value another compromise consumer wrote to the same key', () => {
    // This module teaches "sprocket" as a configured verb.
    expect(sentenceOpensImperative('Sprocket the gear before shipping.', ['sprocket'])).toBe(true);

    // Simulate a host application (or another package) sharing this process's one `compromise`
    // singleton, updating that exact same key to something else *after* this module wrote it.
    simulateHostAddWords('sprocket', 'Adjective');

    // Force `ensureExtraLexicon`'s restore/reteach cycle to run, by switching this module's own
    // `extraImperativeVerbs` configuration away from "sprocket".
    sentenceOpensImperative('Torque the bolt.', ['reticulate']);

    // The host's newer write must survive: this module's restore must never overwrite a key whose
    // live value no longer matches what this module itself last wrote there.
    expect(sharedLexicon()['sprocket']).toBe('Adjective');
  });

  // Regression (chatgpt-codex-connector round 4, finding A / discussion_r3698561010): the previous
  // fix only undid a call's `extraImperativeVerbs` teaching *lazily*, when a later call arrived with
  // a *different* configuration. Between the end of one call and the start of the next
  // differently-configured one, the shared `compromise` singleton sat mutated — observable by any
  // other consumer of the same process's `compromise` import during that window, not just at the
  // boundary the lazy fix already handled. This call must leave no trace immediately, with no
  // second, differently-configured call required to trigger the restore.
  it('does not leave extraImperativeVerbs taught in the shared lexicon once a single call has returned', () => {
    expect(sharedLexicon()['cache']).toBeUndefined();
    expect(sentenceOpensImperative('Cache the response before returning.', ['cache'])).toBe(true);
    expect(sharedLexicon()['cache']).toBeUndefined();
  });

  // Regression (chatgpt-codex-connector round 4, finding B / discussion_r3698561014):
  // `ensureDomainLexicon` taught `IMPERATIVE_VERBS` to the shared singleton once, at module load,
  // and never restored it — a permanent mutation to any process that imports this module, whether or
  // not `extraImperativeVerbs` is ever used. "torque" is not tagged as a *verb* by `compromise`'s own
  // base lexicon (confirmed directly: it defaults to a non-verb, `Noun·Singular` reading until
  // taught) — but `compromise`'s base lexicon does already carry a `'Singular'` entry for it
  // (confirmed directly against a pristine `compromise` import), so the correct post-call value to
  // restore to is whatever was there immediately before this call — captured here, not assumed to
  // be `undefined` — not the domain lexicon's own `'Verb'` override.
  it('does not leave the domain lexicon taught in the shared lexicon once a single call has returned', () => {
    const before = sharedLexicon()['torque'];
    expect(before).not.toBe('Verb');
    expect(sentenceOpensImperative('Torque the bolt to 25 Nm.')).toBe(true);
    expect(sharedLexicon()['torque']).toBe(before);
  });

  // Same two regressions, via the other public entry point that also teaches these lexicons.
  it('does not leave either lexicon taught in the shared lexicon after a single tagByOffset call', () => {
    const beforeTorque = sharedLexicon()['torque'];
    expect(beforeTorque).not.toBe('Verb');
    expect(sharedLexicon()['cache']).toBeUndefined();
    tagByOffset('Cache the torqued response before returning.', ['cache']);
    expect(sharedLexicon()['torque']).toBe(beforeTorque);
    expect(sharedLexicon()['cache']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// This file's own footprint on the process-global singleton
// ---------------------------------------------------------------------------

// Two tests above call `simulateHostAddWords` — `nlp.addWords` on `compromise`'s process-global
// singleton — deliberately, to stand in for another consumer of it. Until that helper's
// module-level `afterEach` existed, neither mutation was ever undone: "gizmo" and "sprocket" stayed
// taught for every test that ran later in the same worker process — in this file and in any file
// after it. That is why the multi-word-phrase test above had to be written around "gizmo" rather
// than with it, and why `maxWorkers: 1` was load-bearing for correctness here rather than only for
// speed.
//
// These two tests are declared last, so they run last in the file and observe whatever the tests
// above actually left behind. Remove the `afterEach` in `simulateHostAddWords`'s block and the
// first goes red, naming the leaked keys; the second says the same thing in the file's own
// vocabulary.
describe('shared compromise singleton isolation', () => {
  it('leaves the process-global compromise lexicon exactly as this file found it', () => {
    expect(driftFrom(PRISTINE)).toEqual([]);
  });

  it('leaves no trace of the words this file taught the singleton directly', () => {
    expect(sharedLexicon()['gizmo']).toBeUndefined();
    expect(sharedLexicon()['sprocket']).toBeUndefined();
  });
});
