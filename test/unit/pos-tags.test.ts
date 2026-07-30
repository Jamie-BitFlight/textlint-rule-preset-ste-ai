import { describe, expect, it } from 'vitest';
import {
  isBareVerbTagSet,
  isFunctionTagSet,
  sentenceOpensImperative,
} from '../../src/core/pos-tags.js';

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
