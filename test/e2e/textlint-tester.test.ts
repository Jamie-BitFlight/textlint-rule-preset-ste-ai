import TextLintTesterModule from 'textlint-tester';
import { clearAnalysisCache } from '../../src/textlint/adapter.js';
import { rules } from '../../src/textlint/preset.js';

/**
 * `textlint-tester`'s real class type, referenced without ever accessing `.default` at runtime:
 * `typeof TextLintTesterModule.default` is a pure type query, resolved entirely from the package's
 * own `.d.ts` (`export default TextLintTester`), so it costs nothing at run time and stays accurate
 * even though `.default` is not where the real value actually lives (see the comment below).
 */
type TextLintTesterCtor = typeof TextLintTesterModule.default;

/**
 * `textlint-tester` is published as CommonJS with a `.d.ts` written as
 * `export default TextLintTester` but no package.json `exports` map. Two *different* module
 * systems disagree about what a bare default import of a package shaped like that actually is:
 *
 * - **TypeScript's static resolution**, under this project's `moduleResolution: nodenext`,
 *   resolves it to the *module namespace* type, not the default export (confirmed directly:
 *   assigning the bare import to an incompatible type surfaces `typeof import(".../index")` in
 *   the error, not the `TextLintTester` class).
 * - **This project's actual test runtime** (Vite, via vitest) does not share that mismatch — the
 *   import binding already *is* the class directly (confirmed directly: `typeof
 *   TextLintTesterModule === 'function'` at runtime, with no `default` property at all — a class
 *   has no such own property).
 *
 * Neither side is wrong about its own domain; a static cast to `TextLintTesterCtor` would silently
 * paper over either one going stale, so this checks the shape that actually matters — the runtime
 * one — for real, instead of asserting either.
 */
function isTextLintTesterCtor(value: unknown): value is TextLintTesterCtor {
  return typeof value === 'function';
}

function asTextLintTesterCtor(value: unknown): TextLintTesterCtor {
  if (!isTextLintTesterCtor(value)) {
    throw new Error("textlint-tester's default export is not a constructor.");
  }
  return value;
}

const TextLintTester = asTextLintTesterCtor(TextLintTesterModule);

/**
 * Rule-contract tests through `textlint-tester`, the ecosystem's own harness.
 *
 * This is a different kind of check from `textlint-run.test.ts`: the tester drives a rule the way
 * textlint's own rule suite does, and it asserts the *output* of `--fix` for each case. Running the
 * preset's rule modules through it is what makes them textlint rules in more than name.
 *
 * `textlint-tester` registers its own `describe`/`it` with the ambient test globals, so this file
 * does not import from vitest.
 */

const tester = new TextLintTester();

clearAnalysisCache();

tester.run('no-contractions', rules['no-contractions']!, {
  valid: [
    { text: 'Do not remove the cover.\n' },
    { text: 'The unit does not start.\n' },
    // Inside inline code a contraction is a literal, not prose.
    { text: "Run `don't-care --flag` now.\n" },
    // Inside a fence nothing is judged.
    { text: "```sh\ndon't do this\n```\n" },
  ],
  invalid: [
    {
      text: "Don't remove the cover.\n",
      output: 'Do not remove the cover.\n',
      errors: [
        {
          message:
            '[deterministic-violation][provisional] Do not use the contraction "Don\'t". Write "Do not".',
        },
      ],
    },
    {
      // Ambiguous expansion: reported, never fixed.
      text: "It's ready.\n",
      errors: [
        {
          message:
            '[deterministic-violation][provisional] Do not use the contraction "It\'s". Write "It is". Ambiguous: "it is" or "it has".',
        },
      ],
    },
    {
      // Inside a warning: reported, never fixed.
      text: "> [!WARNING]\n> Don't touch the busbar.\n",
      errors: [
        {
          message:
            '[deterministic-violation][provisional] Do not use the contraction "Don\'t". Write "Do not". (No automatic fix: content in a warning admonition is never autofixed.)',
        },
      ],
    },
  ],
});

tester.run('unapproved-vocabulary', rules['unapproved-vocabulary']!, {
  valid: [
    { text: 'Use the bracket.\n' },
    { text: 'Open the file at /opt/utilise/bin now.\n' },
    { text: 'Utilise the bracket.\n', options: { allow: ['utilise'] } },
  ],
  invalid: [
    {
      text: 'Utilise the bracket.\n',
      output: 'Use the bracket.\n',
      errors: [
        {
          message:
            '[deterministic-violation][provisional] "Utilise" is not approved general vocabulary. Use "use".',
        },
      ],
    },
    {
      text: 'Prior to the test, stop the pump.\n',
      output: 'Before the test, stop the pump.\n',
      errors: [
        {
          message:
            '[deterministic-violation][provisional] "Prior to" is not approved general vocabulary. Use "before".',
        },
      ],
    },
    {
      // No approved alternative is marked safe, so no fix.
      text: 'Commence the test.\n',
      errors: [
        {
          message:
            '[deterministic-violation][provisional] "Commence" is not approved general vocabulary. Use "start".',
        },
      ],
    },
  ],
});

tester.run('no-repeated-words', rules['no-repeated-words']!, {
  valid: [
    { text: 'Remove the cover.\n' },
    { text: 'The value that that follows is set.\n' },
    { text: 'Stop. Stop the pump.\n' },
  ],
  invalid: [
    {
      text: 'Remove the the cover.\n',
      output: 'Remove the cover.\n',
      errors: [
        {
          message:
            '[deterministic-violation][provisional] The word "the" is repeated. Remove the duplicate.',
        },
      ],
    },
    {
      // Deleting the duplicate would change a negation count, so the fix is refused.
      text: 'Do not not touch the busbar.\n',
      errors: [
        {
          message:
            '[deterministic-violation][provisional] The word "not" is repeated. Remove the duplicate. (No automatic fix: the replacement changes negation.)',
        },
      ],
    },
  ],
});

tester.run('number-unit-format', rules['number-unit-format']!, {
  valid: [{ text: 'Torque the bolt to 25 Nm now.\n' }, { text: 'Charge to 80% now.\n' }],
  invalid: [
    {
      // A quantity is never autofixed, so no `output` is expected.
      text: 'Torque the bolt to 25Nm now.\n',
      errors: [
        {
          message:
            '[deterministic-violation][provisional] Put a space between the number and the unit: "25 Nm".',
        },
      ],
    },
  ],
});

tester.run('one-instruction-per-sentence', rules['one-instruction-per-sentence']!, {
  valid: [
    { text: 'Remove the cover and the filter.\n' },
    { text: 'The unit reads the sensor and writes the value.\n' },
    { text: 'Set the switch to OFF to isolate the supply.\n' },
  ],
  invalid: [
    {
      text: 'Remove the cover and install the new filter.\n',
      errors: [
        {
          message:
            '[deterministic-violation][provisional] This instruction contains two actions ("Remove" and "install"). Write one instruction in each sentence.',
        },
      ],
    },
  ],
});
