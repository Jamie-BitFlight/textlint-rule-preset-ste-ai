/**
 * Ambient module declaration for `text-readability`.
 *
 * The package ships no type definitions (no `.d.ts`, no `@types/text-readability` on npm — see
 * `docs/provisional-rules.md#sentence-length-procedural` for how this was verified before use).
 * Only the functions this rule set actually calls are declared; every signature was checked
 * against `node_modules/text-readability/main.js` and `README.md` at the version pinned in
 * `package.json`.
 */
declare module 'text-readability' {
  interface Readability {
    /** Number of words in `text` (punctuation excluded unless `removePunctuation` is false). */
    lexiconCount(text: string, removePunctuation?: boolean): number;
    /** Sentence count using the package's own regex splitter; never returns less than 1. */
    sentenceCount(text: string): number;
    /** Flesch-Kincaid US school grade level: the grade a reader needs to comprehend `text`. */
    fleschKincaidGrade(text: string): number;
    /** Flesch Reading Ease score (higher is easier; see the package README for the scale). */
    fleschReadingEase(text: string): number;
    /** Gunning Fog index: another grade-level estimate, weighted by percentage of "hard" words. */
    gunningFog(text: string): number;
    automatedReadabilityIndex(text: string): number;
    colemanLiauIndex(text: string): number;
    daleChallReadabilityScore(text: string): number;
    difficultWords(text: string, syllableThreshold?: number): number;
    linsearWriteFormula(text: string): number;
    smogIndex(text: string): number;
    syllableCount(text: string, lang?: string): number;
    textStandard(text: string, floatOutput?: boolean): string | number;
  }

  const readability: Readability;
  export default readability;
}
