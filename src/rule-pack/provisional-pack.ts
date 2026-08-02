import type { RulePack } from '../core/types.js';

/**
 * Bundled **provisional** rule pack.
 *
 * PROVENANCE (classification 4 — implementation assumption).
 *
 * No authorised ASD-STE100 material is available to this repository: the specification and its
 * dictionary are "a Copyright and a Trademark of ASD, Brussels, Belgium. All rights reserved."
 * (asd-ste100.org, retrieved 2026-07-26). Nothing here is copied, paraphrased or reconstructed
 * from that specification.
 *
 * What this pack *is*: ordinary plain-English editing guidance of the kind published in many
 * public style guides — prefer the short common word, avoid contractions, keep sentences short,
 * introduce abbreviations before use. Every entry is authored for this package and every rule
 * that consumes it is marked `provisional` in its metadata, in its diagnostics, and in the docs.
 *
 * `conformanceClaim: 'none'` is load-bearing: it forbids any conformance statement in output.
 *
 * To replace this with normative data, see `docs/rule-pack-import.md`.
 */
export const provisionalRulePack: RulePack = {
  metadata: {
    id: 'ste-ai-provisional',
    name: 'STE-AI provisional controlled-English pack',
    version: '0.1.0',
    authority: 'provisional',
    licence: 'MIT (this repository)',
    source: 'Authored for textlint-rule-preset-ste-ai. Not derived from any standard.',
    retrievedAt: '2026-07-26',
    conformanceClaim: 'none',
    notice:
      'Provisional guidance only. This pack is not ASD-STE100 and confers no conformance with it.',
  },

  limits: {
    // See docs/provisional-rules.md#sentence-length-procedural for how these were chosen: a
    // Flesch-Kincaid US grade level, gated by a word-count floor below which the formula is not
    // computed at all because it is unstable on short input. The floor happens to equal the old
    // bundled `proceduralSentenceMaxWords` word limit; that is a deliberate anchor, not a
    // coincidence carried over by accident. The grade thresholds (7/8) read low next to the
    // "grade 8-10" starting hypothesis for technical writing because they are calibrated against
    // `sentence.masked` text, which already removes the syllable inflation that identifiers and
    // part numbers would otherwise add — see the fixture-corpus measurement referenced in the
    // same doc section.
    proceduralMaxGradeLevel: 7,
    descriptiveMaxGradeLevel: 8,
    sentenceReadabilityFloorWords: 20,
    // NOTE: procedural (7) is intentionally the lower/stricter of the two, mirroring the old
    // 20-vs-25-word split -- instructions are expected to read a little more simply than
    // description at the same length.
    maxNounClusterLength: 3,
    maxSentencesPerProceduralStep: 1,
  },

  dictionary: {
    // Terms whose permitted sense/part of speech the semantic evaluators may check. Left small on
    // purpose: an unsupported "approved" list would imply dictionary coverage this pack lacks.
    approved: [
      { term: 'check', partsOfSpeech: ['verb'], senses: ['to examine for a condition'] },
      { term: 'close', partsOfSpeech: ['verb', 'adjective'], senses: ['to shut', 'near'] },
      { term: 'follow', partsOfSpeech: ['verb'], senses: ['to come after in sequence'] },
      { term: 'set', partsOfSpeech: ['verb'], senses: ['to put a control into a position'] },
      {
        term: 'clear',
        partsOfSpeech: ['verb', 'adjective'],
        senses: ['to remove', 'unobstructed'],
      },
      { term: 'fit', partsOfSpeech: ['verb'], senses: ['to install'] },
    ],

    /**
     * General words with a plainer alternative. `safeSubstitution` is true only for closed
     * orthographic or fixed-phrase swaps that cannot change technical meaning.
     */
    unapproved: [
      { term: 'utilise', alternatives: ['use'], safeSubstitution: true },
      { term: 'utilize', alternatives: ['use'], safeSubstitution: true },
      { term: 'whilst', alternatives: ['while'], safeSubstitution: true },
      { term: 'amongst', alternatives: ['among'], safeSubstitution: true },
      { term: 'commence', alternatives: ['start'], safeSubstitution: false },
      { term: 'endeavour', alternatives: ['try'], safeSubstitution: false },
      { term: 'endeavor', alternatives: ['try'], safeSubstitution: false },
      { term: 'ascertain', alternatives: ['find out'], safeSubstitution: false },
      { term: 'facilitate', alternatives: ['help'], safeSubstitution: false },
      { term: 'necessitate', alternatives: ['need'], safeSubstitution: false },
      { term: 'initiate', alternatives: ['start'], safeSubstitution: false },
      { term: 'terminate', alternatives: ['stop', 'end'], safeSubstitution: false },
      { term: 'obtain', alternatives: ['get'], safeSubstitution: false },
      { term: 'purchase', alternatives: ['buy'], safeSubstitution: false },
      { term: 'assist', alternatives: ['help'], safeSubstitution: false },
      { term: 'attempt', alternatives: ['try'], safeSubstitution: false },
      { term: 'demonstrate', alternatives: ['show'], safeSubstitution: false },
      { term: 'expedite', alternatives: ['hurry'], safeSubstitution: false },
      { term: 'furnish', alternatives: ['give'], safeSubstitution: false },
      { term: 'comprise', alternatives: ['include', 'have'], safeSubstitution: false },
      { term: 'deem', alternatives: ['think'], safeSubstitution: false },
      { term: 'approximately', alternatives: ['about'], safeSubstitution: false },
      { term: 'sufficient', alternatives: ['enough'], safeSubstitution: false },
      { term: 'additional', alternatives: ['more'], safeSubstitution: false },
      { term: 'numerous', alternatives: ['many'], safeSubstitution: false },
      { term: 'aforementioned', alternatives: ['this', 'that'], safeSubstitution: false },
      { term: 'hereinafter', alternatives: ['after this'], safeSubstitution: false },
      { term: 'thereof', alternatives: ['of it'], safeSubstitution: false },
      { term: 'therein', alternatives: ['in it'], safeSubstitution: false },
      { term: 'thereby', alternatives: ['so'], safeSubstitution: false },
      { term: 'wherein', alternatives: ['where'], safeSubstitution: false },
      { term: 'henceforth', alternatives: ['from now on'], safeSubstitution: false },
      { term: 'notwithstanding', alternatives: ['despite'], safeSubstitution: false },
      { term: 'moreover', alternatives: ['also'], safeSubstitution: false },
      { term: 'furthermore', alternatives: ['also'], safeSubstitution: false },
      { term: 'nevertheless', alternatives: ['but'], safeSubstitution: false },
      { term: 'nonetheless', alternatives: ['but'], safeSubstitution: false },
      { term: 'thus', alternatives: ['so'], safeSubstitution: false },
      { term: 'hence', alternatives: ['so'], safeSubstitution: false },
      { term: 'utilisation', alternatives: ['use'], safeSubstitution: false },
      { term: 'utilization', alternatives: ['use'], safeSubstitution: false },
      { term: 'prior to', alternatives: ['before'], safeSubstitution: true },
      { term: 'subsequent to', alternatives: ['after'], safeSubstitution: true },
      { term: 'in order to', alternatives: ['to'], safeSubstitution: true },
      { term: 'in the event that', alternatives: ['if'], safeSubstitution: false },
      { term: 'in the event of', alternatives: ['if'], safeSubstitution: false },
      { term: 'at this point in time', alternatives: ['now'], safeSubstitution: false },
      { term: 'a number of', alternatives: ['some', 'many'], safeSubstitution: false },
      { term: 'the majority of', alternatives: ['most'], safeSubstitution: false },
      { term: 'is able to', alternatives: ['can'], safeSubstitution: false },
      { term: 'are able to', alternatives: ['can'], safeSubstitution: false },
      { term: 'has the ability to', alternatives: ['can'], safeSubstitution: false },
      { term: 'in the vicinity of', alternatives: ['near'], safeSubstitution: false },
      { term: 'in conjunction with', alternatives: ['with'], safeSubstitution: false },
      { term: 'with regard to', alternatives: ['about'], safeSubstitution: false },
      { term: 'with respect to', alternatives: ['about'], safeSubstitution: false },
      { term: 'in accordance with', alternatives: ['as given in'], safeSubstitution: false },
      { term: 'due to the fact that', alternatives: ['because'], safeSubstitution: false },
      { term: 'for the purpose of', alternatives: ['to'], safeSubstitution: false },
      { term: 'in the process of', alternatives: [], safeSubstitution: false },
      { term: 'it should be noted that', alternatives: [], safeSubstitution: false },
    ],

    /** Orthographic consistency. All of these are pure spelling choices. */
    preferred: [
      { from: 'on-line', to: 'online', safeSubstitution: true },
      { from: 'web site', to: 'website', safeSubstitution: true },
      { from: 'web-site', to: 'website', safeSubstitution: true },
      { from: 'e-mail', to: 'email', safeSubstitution: true },
      { from: 'data base', to: 'database', safeSubstitution: true },
      { from: 'file-system', to: 'file system', safeSubstitution: true },
      {
        from: 'start-up',
        to: 'startup',
        safeSubstitution: false,
        note: 'Noun only; the verb is "start up".',
      },
    ],
  },

  /**
   * Contraction expansions. `safeSubstitution` is false wherever the contraction is ambiguous:
   * `it's` may be `it is` or `it has`, and `'d` may be `would` or `had`.
   */
  contractions: [
    { from: "don't", to: 'do not', safeSubstitution: true },
    { from: "doesn't", to: 'does not', safeSubstitution: true },
    { from: "didn't", to: 'did not', safeSubstitution: true },
    { from: "won't", to: 'will not', safeSubstitution: true },
    { from: "can't", to: 'cannot', safeSubstitution: true },
    { from: "couldn't", to: 'could not', safeSubstitution: true },
    { from: "shouldn't", to: 'should not', safeSubstitution: true },
    { from: "wouldn't", to: 'would not', safeSubstitution: true },
    { from: "mustn't", to: 'must not', safeSubstitution: true },
    { from: "isn't", to: 'is not', safeSubstitution: true },
    { from: "aren't", to: 'are not', safeSubstitution: true },
    { from: "wasn't", to: 'was not', safeSubstitution: true },
    { from: "weren't", to: 'were not', safeSubstitution: true },
    { from: "hasn't", to: 'has not', safeSubstitution: true },
    { from: "haven't", to: 'have not', safeSubstitution: true },
    { from: "hadn't", to: 'had not', safeSubstitution: true },
    { from: "needn't", to: 'need not', safeSubstitution: true },
    { from: "we're", to: 'we are', safeSubstitution: true },
    { from: "you're", to: 'you are', safeSubstitution: true },
    { from: "they're", to: 'they are', safeSubstitution: true },
    { from: "we've", to: 'we have', safeSubstitution: true },
    { from: "you've", to: 'you have', safeSubstitution: true },
    { from: "they've", to: 'they have', safeSubstitution: true },
    { from: "we'll", to: 'we will', safeSubstitution: true },
    { from: "you'll", to: 'you will', safeSubstitution: true },
    { from: "they'll", to: 'they will', safeSubstitution: true },
    { from: "it'll", to: 'it will', safeSubstitution: true },
    { from: "it's", to: 'it is', safeSubstitution: false, note: 'Ambiguous: "it is" or "it has".' },
    {
      from: "there's",
      to: 'there is',
      safeSubstitution: false,
      note: 'Ambiguous: "there is" or "there has".',
    },
    {
      from: "that's",
      to: 'that is',
      safeSubstitution: false,
      note: 'Ambiguous: "that is" or "that has".',
    },
    {
      from: "what's",
      to: 'what is',
      safeSubstitution: false,
      note: 'Ambiguous: "what is" or "what has".',
    },
    { from: "we'd", to: 'we would', safeSubstitution: false, note: 'Ambiguous: "would" or "had".' },
    {
      from: "you'd",
      to: 'you would',
      safeSubstitution: false,
      note: 'Ambiguous: "would" or "had".',
    },
    {
      from: "they'd",
      to: 'they would',
      safeSubstitution: false,
      note: 'Ambiguous: "would" or "had".',
    },
    { from: "let's", to: 'let us', safeSubstitution: false },
  ],

  approvedTechnicalTerms: [],

  rules: [
    {
      ruleId: 'sentence-length-procedural',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#sentence-length-procedural',
      enabled: true,
    },
    {
      ruleId: 'sentence-length-descriptive',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#sentence-length-descriptive',
      enabled: true,
    },
    {
      ruleId: 'unapproved-vocabulary',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#unapproved-vocabulary',
      enabled: true,
    },
    {
      ruleId: 'preferred-terminology',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#preferred-terminology',
      enabled: true,
    },
    {
      ruleId: 'no-contractions',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#no-contractions',
      enabled: true,
    },
    {
      ruleId: 'punctuation-constraints',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#punctuation-constraints',
      enabled: true,
    },
    {
      ruleId: 'no-repeated-words',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#no-repeated-words',
      enabled: true,
    },
    {
      ruleId: 'abbreviation-introduction',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#abbreviation-introduction',
      enabled: true,
    },
    {
      ruleId: 'number-unit-format',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#number-unit-format',
      enabled: true,
    },
    {
      ruleId: 'list-instruction-structure',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#list-instruction-structure',
      enabled: true,
    },
    {
      ruleId: 'one-instruction-per-sentence',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#one-instruction-per-sentence',
      enabled: true,
    },
    {
      ruleId: 'passive-voice-candidate',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#passive-voice-candidate',
      enabled: true,
    },
    {
      ruleId: 'noun-cluster-candidate',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#noun-cluster-candidate',
      enabled: true,
    },
    {
      ruleId: 'ambiguous-pronoun-candidate',
      status: 'provisional',
      sourceRef: 'provisional:docs/provisional-rules.md#ambiguous-pronoun-candidate',
      enabled: true,
    },
  ],
};
