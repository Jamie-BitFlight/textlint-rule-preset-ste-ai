import TextLintTesterModule from 'textlint-tester';
import { clearAnalysisCache } from '../../src/textlint/adapter.js';
import preset from '../../src/textlint/preset.js';

interface TesterCase {
  readonly text: string;
  readonly options?: unknown;
  readonly output?: string;
  readonly errors?: readonly { readonly message: string }[];
}

interface Tester {
  run(
    name: string,
    rule: unknown,
    cases: { valid: readonly TesterCase[]; invalid: readonly TesterCase[] },
  ): void;
}

// `textlint-tester` publishes a CommonJS default export that TypeScript resolves as the module
// namespace under NodeNext, so the class is not constructable to the compiler even though it is at
// run time. The cast is narrowed to exactly that gap, and gives the harness a typed surface.
const TextLintTester = TextLintTesterModule as unknown as new () => Tester;

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

tester.run('no-contractions', preset.rules['no-contractions']!, {
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

tester.run('unapproved-vocabulary', preset.rules['unapproved-vocabulary']!, {
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

tester.run('no-repeated-words', preset.rules['no-repeated-words']!, {
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

tester.run('number-unit-format', preset.rules['number-unit-format']!, {
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

tester.run('one-instruction-per-sentence', preset.rules['one-instruction-per-sentence']!, {
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
