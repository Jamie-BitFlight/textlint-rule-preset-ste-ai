import nlp from 'compromise';
import { describe, expect, it } from 'vitest';
import {
  isBareVerbTagSet,
  isFunctionTagSet,
  sentenceOpensImperative,
  tagByOffset,
} from '../../src/core/pos-tags.js';
import { MASK_CHAR } from '../../src/core/text.js';

function sharedLexicon(): Record<string, unknown> {
  return (nlp.world() as unknown as { model: { one: { lexicon: Record<string, unknown> } } }).model
    .one.lexicon;
}

describe('sentenceOpensImperative', () => {
  it('recognises an ordinary sentence-initial imperative', () => {
    expect(sentenceOpensImperative('Install the driver before you continue.')).toBe(true);
  });

  it('recognises a domain verb the compromise base lexicon does not know on its own', () => {
    // Confirmed directly: without the domain lexicon, `compromise` tags "Torque" as a bare Noun.
    expect(sentenceOpensImperative('Torque the bolt to 25 Nm.')).toBe(true);
  });

  it('recognises a leading "Do not" / "Never" / "Always" as imperative', () => {
    expect(sentenceOpensImperative('Do not remove the cover while power is connected.')).toBe(true);
    expect(sentenceOpensImperative("Don't remove the cover while power is connected.")).toBe(true);
    expect(sentenceOpensImperative('Never touch the terminal.')).toBe(true);
    expect(sentenceOpensImperative('Always check the pressure gauge first.')).toBe(true);
  });

  it('recognises a verb the closed list never enumerated, that compromise knows on its own', () => {
    // Neither "wipe" nor "trim" is in `IMPERATIVE_VERBS` — this is real recall the hardcoded list
    // never had, not just parity with it.
    expect(sentenceOpensImperative('Wipe the sensor lens before recalibrating.')).toBe(true);
    expect(sentenceOpensImperative('Trim the excess cable.')).toBe(true);
  });

  it('recognises a coordinated imperative list, which compromise does not tag #Imperative on its own', () => {
    // Confirmed directly: `compromise` does not put an `#Imperative` tag on any of "Build",
    // "flash" or "run" in this sentence, even though the shape is a textbook coordinated
    // instruction list. `sentenceOpensImperative` recovers this from the bare-verb tag of the
    // very first word instead of relying on `#Imperative` alone.
    expect(sentenceOpensImperative('Build, flash, and run a sample application.')).toBe(true);
  });

  it('recognises a user-configured extra imperative verb', () => {
    expect(
      sentenceOpensImperative('Reticulate the splines before shipping the part.', ['reticulate']),
    ).toBe(true);
  });

  // Regression (chatgpt-codex-connector, P2): `extraVerbsKey()` joins a normalised `extraVerbs`
  // list with spaces to build a single cache-identity string, and `ensureExtraLexicon` then split
  // that identity string back on whitespace to decide what to teach — conflating a multi-word
  // phrase's own internal space with the delimiter used to join separate entries together. A
  // configured `["gadget widget"]` (one two-word phrase) was therefore taught as two independent
  // single-word verbs, "gadget" and "widget", rather than as the phrase "gadget widget".
  //
  // "gadget"/"widget" (not "gizmo", already taught permanently as a verb by a different test in
  // this file simulating another `compromise` consumer): confirmed directly that `compromise` tags
  // both as `Noun Singular` on their own, and does not guess either as a verb, so either one only
  // reads as an imperative opener here because `extraVerbs` taught it to.
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
    expect(
      sentenceOpensImperative('Widget the gadget before shipping.', ['gadget', 'widget']),
    ).toBe(true);
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
  it('leaves a word added by another compromise consumer sharing this process intact across a restore/reteach cycle', () => {
    // Simulate a host application (or another package) that shares this process's one
    // `compromise` singleton and calls `addWords` directly, bypassing this module entirely.
    nlp.addWords({ gizmo: 'Verb' });
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
  it('does not restore over a newer value another compromise consumer wrote to the same key', () => {
    // This module teaches "sprocket" as a configured verb.
    expect(sentenceOpensImperative('Sprocket the gear before shipping.', ['sprocket'])).toBe(true);

    // Simulate a host application (or another package) sharing this process's one `compromise`
    // singleton, updating that exact same key to something else *after* this module wrote it.
    nlp.addWords({ sprocket: 'Adjective' });

    // Force `ensureExtraLexicon`'s restore/reteach cycle to run, by switching this module's own
    // `extraImperativeVerbs` configuration away from "sprocket".
    sentenceOpensImperative('Torque the bolt.', ['reticulate']);

    // The host's newer write must survive: this module's restore must never overwrite a key whose
    // live value no longer matches what this module itself last wrote there.
    expect(
      (nlp.world() as unknown as { model: { one: { lexicon: Record<string, unknown> } } }).model.one
        .lexicon['sprocket'],
    ).toBe('Adjective');
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

  it('does not misfire on a passive-voice sentence opener', () => {
    expect(sentenceOpensImperative('The driver is installed before you continue.')).toBe(false);
  });

  it('does not treat a label ("Note:", "Exception:") as an imperative opener', () => {
    // Regression: without a colon guard, "Note" alone is a bare present-tense verb and the
    // coordinated-list fallback above would misclassify this as procedural.
    expect(
      sentenceOpensImperative(
        'Note: Exception: the employer need not document the required procedure.',
      ),
    ).toBe(false);
  });

  it('does not treat a Title Case heading as an imperative opener', () => {
    // Regression found via fixtures/original/sqlite-pragma-hard-negative.md: "List Of PRAGMAs ..."
    // is a heading rendered as a run-on line, not an instruction to list something.
    expect(
      sentenceOpensImperative('List Of PRAGMAs analysis_limit application_id auto_vacuum.'),
    ).toBe(false);
  });

  it('does not cascade-mistag a capitalised technical term that collides with a common verb', () => {
    // Regression found via fixtures/original/postgres-vacuum-overview.md: `compromise` tags
    // capitalised sentence-initial "VACUUM" as Verb+Imperative on its own, which then makes it
    // mistag the real verb "reclaims" as a noun.
    expect(sentenceOpensImperative('VACUUM reclaims storage occupied by dead tuples.')).toBe(false);
  });

  it('is a known, documented limitation that only the sentence opener is examined', () => {
    // Matches the previous heuristic's own documented limit: this still misclassifies a sentence
    // whose real grammatical subject is a later clause, because only the first word is examined.
    expect(sentenceOpensImperative('Record the value is stored in flash.')).toBe(true);
  });

  // Regression (chatgpt-codex-connector, P2): on the direct `analyseDocument`/`scanBlocks` path,
  // protected content (e.g. an inline-code identifier) is already replaced with `MASK_CHAR` before
  // this function runs. The old leading-strip regex discarded a whole leading run of `MASK_CHAR`
  // the same way it discards structural whitespace/markup (`>`, `*`, `_`, `-`), so a masked
  // identifier sitting in subject position was skipped straight through to the verb that follows
  // it — "`workers` run the service and emit metrics." (masked: a run of `MASK_CHAR` standing in
  // for the backticked "workers", then " run the service...") was analysed as if it opened with
  // "run", a bare imperative verb.
  it('does not skip a leading masked protected token as if it were structural whitespace', () => {
    const masked = `${MASK_CHAR.repeat(9)} run the service and emit metrics.`;
    expect(sentenceOpensImperative(masked)).toBe(false);
  });

  it('still recognises an imperative whose leading structural markup is masked with no gap before the verb', () => {
    // Contrast case for the fix above: a masked structural marker (e.g. a blockquote arrow) that is
    // immediately, contiguously followed by the verb — no separating space, unlike a masked
    // content-bearing token — must not stop the opener from being recognised.
    const masked = `${MASK_CHAR.repeat(2)}Install the driver.`;
    expect(sentenceOpensImperative(masked)).toBe(true);
  });
});

describe('isFunctionTagSet', () => {
  it('recognises the closed-class compromise tags', () => {
    for (const tag of ['Determiner', 'Preposition', 'Conjunction', 'Pronoun', 'Modal', 'Copula']) {
      expect(isFunctionTagSet([tag]), tag).toBe(true);
    }
  });

  it('does not treat an ordinary content-word tag set as a function word', () => {
    expect(isFunctionTagSet(['Noun', 'Singular'])).toBe(false);
    expect(isFunctionTagSet(['Verb', 'PresentTense', 'Infinitive'])).toBe(false);
  });
});

describe('isBareVerbTagSet', () => {
  it('accepts an infinitive/present-tense verb', () => {
    expect(isBareVerbTagSet(['Verb', 'PresentTense', 'Infinitive'])).toBe(true);
  });

  it('rejects a gerund, a past tense and a passive participle', () => {
    expect(isBareVerbTagSet(['Verb', 'PresentTense', 'Gerund'])).toBe(false);
    expect(isBareVerbTagSet(['Verb', 'PastTense'])).toBe(false);
    expect(isBareVerbTagSet(['Verb', 'PastTense', 'Passive'])).toBe(false);
  });

  it('rejects a non-verb tag set', () => {
    expect(isBareVerbTagSet(['Noun', 'Singular'])).toBe(false);
    expect(isBareVerbTagSet(['Adjective'])).toBe(false);
  });
});
