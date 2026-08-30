import { TextlintKernel, type TextlintPluginCreator } from '@textlint/kernel';
import markdownPluginModule from '@textlint/textlint-plugin-markdown';
import textPluginModule from '@textlint/textlint-plugin-text';
import type { TextlintRuleModule } from '@textlint/types';
import { describe, expect, it, beforeEach } from 'vite-plus/test';

/**
 * Whether `value` is really `TextlintPluginCreator`-shaped: an object with a constructable
 * `Processor`.
 *
 * Both plugin packages are published as CommonJS with a `.d.ts` written as
 * `export default { Processor }` but no package.json `exports` map. Two *different* module
 * systems disagree about what a bare default import of a package shaped like that actually is:
 *
 * - **TypeScript's static resolution**, under this project's `moduleResolution: nodenext`,
 *   resolves it to the *module namespace* type, not the default export (confirmed directly:
 *   assigning the bare import to an incompatible type surfaces `typeof import(".../index")` in
 *   the error, not `TextlintPluginCreator`).
 * - **This project's actual test runtime** (Vite, via vitest) does not share that mismatch — the
 *   import binding already holds `{ Processor }` directly, with no nested `default` at all
 *   (confirmed directly: `Object.keys(markdownPluginModule)` at runtime is `['Processor']`).
 *
 * Neither side is wrong about its own domain, they are just answering different questions — a
 * static cast to `TextlintPluginCreator` would silently paper over *either* one going stale (a
 * real interop fix upstream changing the runtime shape, or a `moduleResolution` change altering
 * the static one), so this checks the shape that actually matters — the runtime one — for real,
 * instead of asserting either.
 */
function isTextlintPluginCreator(value: unknown): value is TextlintPluginCreator {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Processor' in value &&
    typeof value.Processor === 'function'
  );
}

function asTextlintPluginCreator(value: unknown, packageName: string): TextlintPluginCreator {
  if (!isTextlintPluginCreator(value)) {
    throw new Error(`${packageName}'s default export is not TextlintPluginCreator-shaped.`);
  }
  return value;
}

const markdownPlugin = asTextlintPluginCreator(
  markdownPluginModule,
  '@textlint/textlint-plugin-markdown',
);
const textPlugin = asTextlintPluginCreator(textPluginModule, '@textlint/textlint-plugin-text');
import { clearAnalysisCache } from '../../src/textlint/adapter.js';
import { createSteTextlintRule } from '../../src/textlint/adapter.js';
import { rules, rulesConfig } from '../../src/textlint/preset.js';

/**
 * End-to-end runs through the real textlint kernel, with the real markdown plugin, the real
 * fixer and the real preset.
 *
 * Rule modules are passed to the kernel directly rather than resolved by name, so the test does not
 * depend on the package being installed — but everything downstream of that (AST, node handlers,
 * `locator` padding, `fixer` ranges, `--fix` application) is textlint's own code.
 */

const kernel = new TextlintKernel();

// `rules` is indexed by rule id (`noUncheckedIndexedAccess` types the lookup as possibly
// `undefined`); these tests deliberately pin a single rule under test by its known id, so a missing
// entry is a real bug in the test itself (a typo'd id, or a rule renamed without updating callers),
// not a case to paper over with a non-null assertion.
function mustGetRule(id: string): TextlintRuleModule {
  const rule = rules[id];
  if (rule === undefined) {
    throw new Error(`preset does not define a rule named "${id}"`);
  }
  return rule;
}

function presetRules(only?: readonly string[]) {
  return Object.entries(rules)
    .filter(([id]) => only === undefined || only.includes(id))
    .map(([ruleId, rule]) => ({ ruleId, rule, options: true as const }));
}

const options = (only?: readonly string[], ext = '.md') => ({
  ext,
  plugins: [
    { pluginId: 'markdown', plugin: markdownPlugin },
    { pluginId: 'text', plugin: textPlugin },
  ],
  rules: presetRules(only),
});

beforeEach(() => {
  clearAnalysisCache();
});

describe('textlint lint run', () => {
  it('performs one complete analysis with every invoked rule option represented', async () => {
    const starts: ReadonlyMap<string, Readonly<Record<string, unknown>>>[] = [];
    const observer = {
      analysisStarted: (configuredRules: (typeof starts)[number]) => starts.push(configuredRules),
    };
    const selected = ['no-contractions', 'abbreviation-introduction'] as const;
    const result = await kernel.lintText('The ASD value is ready.\n', {
      ...options([]),
      rules: selected.map((ruleId) => ({
        ruleId,
        rule: createSteTextlintRule(ruleId, observer),
        options: ruleId === 'abbreviation-introduction' ? { additionalWellKnown: ['ASD'] } : true,
      })),
    });

    expect(result.messages.some((message) => message.ruleId === 'abbreviation-introduction')).toBe(
      false,
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]?.get('abbreviation-introduction')).toEqual({ additionalWellKnown: ['ASD'] });
    expect(starts[0]?.get('no-contractions')).toEqual({});
  });

  it('does not let a malformed shared override join a valid configuration group', async () => {
    const starts: ReadonlyMap<string, Readonly<Record<string, unknown>>>[] = [];
    const observer = {
      analysisStarted: (configuredRules: (typeof starts)[number]) => starts.push(configuredRules),
    };
    const result = kernel.lintText('Use the tool.\n', {
      ...options([]),
      rules: [
        {
          ruleId: 'no-contractions',
          rule: createSteTextlintRule('no-contractions', observer),
          options: { shared: { approvedTerms: [] } },
        },
        {
          ruleId: 'punctuation-constraints',
          rule: createSteTextlintRule('punctuation-constraints', observer),
          options: { shared: { approvedTerms: [() => 'Utilise'] } },
        },
      ],
    });

    await expect(result).rejects.toThrow(/approvedTerms/);
    expect(starts).toHaveLength(2);
  });

  it('keeps insertion-order variants in separate configuration groups', async () => {
    const starts: ReadonlyMap<string, Readonly<Record<string, unknown>>>[] = [];
    const observer = {
      analysisStarted: (configuredRules: (typeof starts)[number]) => starts.push(configuredRules),
    };
    const result = await kernel.lintText('Use the tool.\n', {
      ...options([]),
      rules: [
        {
          ruleId: 'no-contractions',
          rule: createSteTextlintRule('no-contractions', observer),
          options: { shared: { approvedTerms: [], extraImperativeVerbs: [] } },
        },
        {
          ruleId: 'punctuation-constraints',
          rule: createSteTextlintRule('punctuation-constraints', observer),
          options: { shared: { extraImperativeVerbs: [], approvedTerms: [] } },
        },
      ],
    });

    expect(result.messages).toHaveLength(0);
    expect(starts).toHaveLength(2);
  });

  it('isolates simultaneous document lifecycles and their rule options', async () => {
    const starts: ReadonlyMap<string, Readonly<Record<string, unknown>>>[] = [];
    const observer = {
      analysisStarted: (configuredRules: (typeof starts)[number]) => starts.push(configuredRules),
    };
    const lintWith = (known: string) =>
      kernel.lintText(`The ${known} value is ready.\n`, {
        ...options([]),
        rules: [
          {
            ruleId: 'abbreviation-introduction',
            rule: createSteTextlintRule('abbreviation-introduction', observer),
            options: { additionalWellKnown: [known] },
          },
        ],
      });

    const [first, second] = await Promise.all([lintWith('ASD'), lintWith('MIT')]);

    expect(first.messages).toHaveLength(0);
    expect(second.messages).toHaveLength(0);
    expect(starts).toHaveLength(2);
    expect(
      starts.map((configuredRules) => configuredRules.get('abbreviation-introduction')),
    ).toEqual(
      expect.arrayContaining([{ additionalWellKnown: ['ASD'] }, { additionalWellKnown: ['MIT'] }]),
    );
  });

  it('reports diagnostics with correct line and column for a markdown document', async () => {
    const text = ['# Setup', '', 'Prior to installation, remove the bracket.', ''].join('\n');
    const result = await kernel.lintText(text, options(['unapproved-vocabulary']));
    expect(result.messages).toHaveLength(1);
    const message = result.messages[0];
    expect(message?.ruleId).toBe('unapproved-vocabulary');
    expect(message?.loc.start.line).toBe(3);
    expect(message?.loc.start.column).toBe(1);
    expect(message?.message).toContain('[deterministic-violation][provisional]');
    expect(message?.message).toContain('"Prior to" is not approved');
  });

  it('points at the right column mid-line', async () => {
    const text = 'Please utilise the bracket.\n';
    const result = await kernel.lintText(text, options(['unapproved-vocabulary']));
    expect(result.messages[0]?.loc.start.line).toBe(1);
    expect(result.messages[0]?.loc.start.column).toBe(text.indexOf('utilise') + 1);
  });

  it('reports nothing inside a fenced code block', async () => {
    const text = ['Prose is fine here.', '', '```sh', "utilise --whilst don't", '```', ''].join(
      '\n',
    );
    const result = await kernel.lintText(text, options());
    const inFence = result.messages.filter((m) => m.loc.start.line === 4);
    expect(inFence).toEqual([]);
  });

  it('runs the whole preset without throwing and finds several rule ids', async () => {
    const text = [
      '---',
      'title: Maintenance',
      '---',
      '',
      '# Filter replacement',
      '',
      "Prior to the task, don't utilise the the old bracket; stop now!",
      '',
      '> [!WARNING]',
      "> Don't touch the busbar. It is live at 400 V.",
      '',
      '1. Set the switch to `OFF` and remove the cover.',
      '2. Torque the bolt to 25Nm.',
      '',
      '| Step | Action |',
      '| --- | --- |',
      '| 1 | Utilise the tool |',
      '',
    ].join('\n');
    const result = await kernel.lintText(text, options());
    const ruleIds = new Set(result.messages.map((m) => m.ruleId));
    expect(ruleIds).toContain('unapproved-vocabulary');
    expect(ruleIds).toContain('no-contractions');
    expect(ruleIds).toContain('no-repeated-words');
    expect(ruleIds).toContain('punctuation-constraints');
    expect(ruleIds).toContain('one-instruction-per-sentence');
    expect(ruleIds).toContain('number-unit-format');
    for (const message of result.messages) {
      expect(message.loc.start.line).toBeGreaterThan(0);
      expect(message.loc.start.column).toBeGreaterThan(0);
    }
  });

  it('lints a plain-text document through the text plugin', async () => {
    const result = await kernel.lintText(
      'Utilise the bracket.\n',
      options(['unapproved-vocabulary'], '.txt'),
    );
    expect(result.messages).toHaveLength(1);
  });

  it('an inline suppression directive silences the finding it names', async () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling fixed by contract. -->',
      'Prior to installation, remove the bracket.',
      '',
    ].join('\n');
    const result = await kernel.lintText(text, options(['unapproved-vocabulary']));
    expect(result.messages).toEqual([]);
  });

  it('reports the same document once the directive is removed', async () => {
    const text = ['Prior to installation, remove the bracket.', ''].join('\n');
    const result = await kernel.lintText(text, options(['unapproved-vocabulary']));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message).toContain('"Prior to" is not approved');
  });

  it('a rule-scoped directive leaves another rule on the same line reporting', async () => {
    const text = [
      '<!-- ste-ai-ignore-next-line unapproved-vocabulary -- Vendor spelling fixed by contract. -->',
      "Prior to installation, don't remove the bracket.",
      '',
    ].join('\n');
    const result = await kernel.lintText(
      text,
      options(['unapproved-vocabulary', 'no-contractions']),
    );
    expect(result.messages.map((m) => m.ruleId)).toEqual(['no-contractions']);
  });

  it('offers suggestions alongside the diagnostic', async () => {
    const result = await kernel.lintText(
      'Commence the test.\n',
      options(['unapproved-vocabulary']),
    );
    const message = result.messages[0] as { suggestions?: { message: string }[] } | undefined;
    expect(message?.suggestions?.[0]?.message).toContain('start');
  });
});

describe('textlint fix run', () => {
  it('applies only gated fixes and leaves the rest of the text untouched', async () => {
    const text = "Don't utilise the the bracket.\n";
    const result = await kernel.fixText(text, options());
    expect(result.output).toBe('Do not use the bracket.\n');
  });

  it('refuses to fix inside a warning admonition', async () => {
    const text = ['> [!WARNING]', "> Don't utilise the busbar.", ''].join('\n');
    const result = await kernel.fixText(text, options());
    expect(result.output).toBe(text);
    const messages = await kernel.lintText(text, options(['no-contractions']));
    expect(messages.messages[0]?.message).toContain('warning admonition');
  });

  it('never rewrites protected content', async () => {
    const text = ['Utilise the tool.', '', '```sh', 'utilise --now', '```', ''].join('\n');
    const result = await kernel.fixText(text, options());
    expect(result.output).toContain('utilise --now');
    expect(result.output).toContain('Use the tool.');
  });

  it('does not fix an ambiguous contraction', async () => {
    const text = "It's ready.\n";
    const result = await kernel.fixText(text, options(['no-contractions']));
    expect(result.output).toBe(text);
  });

  it('leaves quantities alone', async () => {
    const text = 'Torque the bolt to 25Nm.\n';
    const result = await kernel.fixText(text, options());
    expect(result.output).toBe(text);
  });

  it('fixing is idempotent', async () => {
    const text = "Don't utilise the the bracket.\n";
    const once = await kernel.fixText(text, options());
    const twice = await kernel.fixText(once.output, options());
    expect(twice.output).toBe(once.output);
  });

  it('a fixed document has no remaining fixable diagnostics of the same kind', async () => {
    const text = "Don't utilise the web site.\n";
    const fixed = await kernel.fixText(text, options());
    const after = await kernel.lintText(fixed.output, options());
    expect(after.messages.filter((m) => m.ruleId === 'no-contractions')).toEqual([]);
    expect(after.messages.filter((m) => m.ruleId === 'preferred-terminology')).toEqual([]);
  });
});

describe('per-rule textlint options', () => {
  it('honours an option passed through textlint', async () => {
    const text = 'Remove the panel and continue.\n';
    const result = await kernel.lintText(text, {
      ext: '.md',
      plugins: [{ pluginId: 'markdown', plugin: markdownPlugin }],
      rules: [
        {
          ruleId: 'sentence-length-procedural',
          rule: mustGetRule('sentence-length-procedural'),
          options: { floorWords: 1, maxGradeLevel: 3 },
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message).toContain('the configured limit is grade 3');
  });

  it('carries the configured severity through to the textlint message', async () => {
    const text = 'Torque the bolt to 25Nm.\n';
    const withDefault = await kernel.lintText(text, options(['number-unit-format']));
    // A deterministic violation defaults to `error`, textlint level 2.
    expect(withDefault.messages[0]?.severity).toBe(2);

    // Demoting the category must reach the reported message. Before the adapter mapped severities
    // every finding arrived at level 2 and the whole policy was unobservable through textlint.
    const demoted = await kernel.lintText(text, {
      ext: '.md',
      plugins: [{ pluginId: 'markdown', plugin: markdownPlugin }],
      rules: [
        {
          ruleId: 'number-unit-format',
          rule: mustGetRule('number-unit-format'),
          options: {
            shared: { diagnostics: { severity: { 'deterministic-violation': 'info' } } },
          },
        },
      ],
    });
    expect(demoted.messages[0]?.severity).toBe(3);

    // A per-rule severity override is a different lever and must reach the message too.
    const asWarning = await kernel.lintText(text, {
      ext: '.md',
      plugins: [{ pluginId: 'markdown', plugin: markdownPlugin }],
      rules: [
        {
          ruleId: 'number-unit-format',
          rule: mustGetRule('number-unit-format'),
          options: { shared: { rules: { 'number-unit-format': { severity: 'warning' } } } },
        },
      ],
    });
    expect(asWarning.messages[0]?.severity).toBe(1);
  });

  it('a rule disabled through shared options produces nothing', async () => {
    const result = await kernel.lintText('Utilise it.\n', {
      ext: '.md',
      plugins: [{ pluginId: 'markdown', plugin: markdownPlugin }],
      rules: [
        {
          ruleId: 'unapproved-vocabulary',
          rule: mustGetRule('unapproved-vocabulary'),
          options: { shared: { rules: { 'unapproved-vocabulary': { enabled: false } } } },
        },
      ],
    });
    expect(result.messages).toEqual([]);
  });
});

describe('run-level notices, reported once regardless of which rules are enabled', () => {
  // Found in external review of PR #73: this used to fire only from the rule whose id equalled a
  // hardcoded constant (`sentence-length-procedural`). A `.textlintrc.json` that does not enable
  // that specific rule never invokes its handler at all, so the notice — despite being genuinely
  // computed — was never reported. An invalid `extraProtectedPatterns` entry, whose whole point is
  // to never go unnoticed (issue #7), went unnoticed anyway, through this one integration surface.
  const badShared = { extraProtectedPatterns: ['([unclosed'] };
  const text = 'Part PN1234 is ready.\n';

  it('is reported when the rule that used to be hardcoded is not enabled at all', async () => {
    const result = await kernel.lintText(text, {
      ext: '.md',
      plugins: [{ pluginId: 'markdown', plugin: markdownPlugin }],
      rules: [
        {
          ruleId: 'unapproved-vocabulary',
          rule: mustGetRule('unapproved-vocabulary'),
          options: { shared: badShared },
        },
      ],
    });
    const notices = result.messages.filter((m) => m.message.includes('invalid-protected-pattern'));
    expect(notices).toHaveLength(1);
  });

  it('is reported exactly once, not once per enabled rule', async () => {
    const result = await kernel.lintText(text, {
      ext: '.md',
      plugins: [{ pluginId: 'markdown', plugin: markdownPlugin }],
      rules: [
        {
          ruleId: 'unapproved-vocabulary',
          rule: mustGetRule('unapproved-vocabulary'),
          options: { shared: badShared },
        },
        {
          ruleId: 'no-contractions',
          rule: mustGetRule('no-contractions'),
          options: { shared: badShared },
        },
        {
          ruleId: 'sentence-length-procedural',
          rule: mustGetRule('sentence-length-procedural'),
          options: { shared: badShared },
        },
      ],
    });
    const notices = result.messages.filter((m) => m.message.includes('invalid-protected-pattern'));
    expect(notices).toHaveLength(1);
  });

  it('surfaces distinct notices from different rules, not just whichever ran first', async () => {
    // Found in external review of PR #73, on the fix above: `getAnalysis` computes a config
    // scoped to whichever rule is calling it, so two rules can genuinely compute *different*
    // notices for the same document -- here, each rule's own rule-options-invalid, which only
    // shows up in the analysis call carrying THAT rule's own bad inline options. Gating on "the
    // first rule to arrive reports, everyone else this run stays silent" (the fix above's own
    // first version) silently dropped every notice specific to a rule that was not first.
    const result = await kernel.lintText('Some text.\n', {
      ext: '.md',
      plugins: [{ pluginId: 'markdown', plugin: markdownPlugin }],
      rules: [
        {
          ruleId: 'sentence-length-procedural',
          rule: mustGetRule('sentence-length-procedural'),
          options: true,
        },
        {
          ruleId: 'abbreviation-introduction',
          rule: mustGetRule('abbreviation-introduction'),
          options: { minLength: 8, maxLength: 3 },
        },
      ],
    });
    const notices = result.messages.filter((m) => m.message.includes('rule-options-invalid'));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('abbreviation-introduction');
    expect(notices[0]?.ruleId).toBe('abbreviation-introduction');
  });

  it('surfaces two distinct rule-specific notices together, neither dropped nor duplicated', async () => {
    const result = await kernel.lintText('Some text.\n', {
      ext: '.md',
      plugins: [{ pluginId: 'markdown', plugin: markdownPlugin }],
      rules: [
        {
          ruleId: 'abbreviation-introduction',
          rule: mustGetRule('abbreviation-introduction'),
          options: { minLength: 8, maxLength: 3 },
        },
        {
          ruleId: 'punctuation-constraints',
          rule: mustGetRule('punctuation-constraints'),
          options: { maxCommas: -1 },
        },
      ],
    });
    const notices = result.messages.filter((m) => m.message.includes('rule-options-invalid'));
    expect(notices).toHaveLength(2);
    expect(notices.map((n) => n.message).join('\n')).toContain('abbreviation-introduction');
    expect(notices.map((n) => n.message).join('\n')).toContain('punctuation-constraints');
    expect(notices.map((n) => n.ruleId).toSorted()).toEqual([
      'abbreviation-introduction',
      'punctuation-constraints',
    ]);
  });
});

describe('preset shape', () => {
  it('exposes one rule module per core rule and enables them all by default', () => {
    expect(Object.keys(rules)).toHaveLength(14);
    expect(Object.values(rulesConfig).every((v) => v === true)).toBe(true);
    for (const rule of Object.values(rules)) {
      expect(typeof rule).toBe('object');
      expect('linter' in rule && 'fixer' in rule).toBe(true);
    }
  });
});
