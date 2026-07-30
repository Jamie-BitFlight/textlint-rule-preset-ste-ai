import { TextlintKernel, type TextlintPluginCreator } from '@textlint/kernel';
import markdownPluginModule from '@textlint/textlint-plugin-markdown';
import textPluginModule from '@textlint/textlint-plugin-text';
import { describe, expect, it, beforeEach } from 'vitest';

// The published typings for these plugins declare a default export whose shape TypeScript resolves
// as the module namespace under NodeNext, so the `Processor` property is not visible to the
// compiler even though it is present at run time. The casts are narrowed to exactly that gap.
const markdownPlugin = markdownPluginModule as unknown as TextlintPluginCreator;
const textPlugin = textPluginModule as unknown as TextlintPluginCreator;
import { clearAnalysisCache } from '../../src/textlint/adapter.js';
import preset from '../../src/textlint/preset.js';

/**
 * End-to-end runs through the real textlint kernel, with the real markdown plugin, the real
 * fixer and the real preset.
 *
 * Rule modules are passed to the kernel directly rather than resolved by name, so the test does not
 * depend on the package being installed — but everything downstream of that (AST, node handlers,
 * `locator` padding, `fixer` ranges, `--fix` application) is textlint's own code.
 */

const kernel = new TextlintKernel();

function presetRules(only?: readonly string[]) {
  return Object.entries(preset.rules)
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
  it('reports diagnostics with correct line and column for a markdown document', async () => {
    const text = ['# Setup', '', 'Prior to installation, remove the bracket.', ''].join('\n');
    const result = await kernel.lintText(text, options(['unapproved-vocabulary']));
    expect(result.messages).toHaveLength(1);
    const message = result.messages[0];
    expect(message?.ruleId).toBe('unapproved-vocabulary');
    expect(message?.line).toBe(3);
    expect(message?.column).toBe(1);
    expect(message?.message).toContain('[deterministic-violation][provisional]');
    expect(message?.message).toContain('"Prior to" is not approved');
  });

  it('points at the right column mid-line', async () => {
    const text = 'Please utilise the bracket.\n';
    const result = await kernel.lintText(text, options(['unapproved-vocabulary']));
    expect(result.messages[0]?.line).toBe(1);
    expect(result.messages[0]?.column).toBe(text.indexOf('utilise') + 1);
  });

  it('reports nothing inside a fenced code block', async () => {
    const text = ['Prose is fine here.', '', '```sh', "utilise --whilst don't", '```', ''].join(
      '\n',
    );
    const result = await kernel.lintText(text, options());
    const inFence = result.messages.filter((m) => m.line === 4);
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
      expect(message.line).toBeGreaterThan(0);
      expect(message.column).toBeGreaterThan(0);
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
          rule: preset.rules['sentence-length-procedural']!,
          options: { maxWords: 3 },
        },
      ],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.message).toContain('the configured limit is 3');
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
          rule: preset.rules['number-unit-format']!,
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
          rule: preset.rules['number-unit-format']!,
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
          rule: preset.rules['unapproved-vocabulary']!,
          options: { shared: { rules: { 'unapproved-vocabulary': { enabled: false } } } },
        },
      ],
    });
    expect(result.messages).toEqual([]);
  });
});

describe('preset shape', () => {
  it('exposes one rule module per core rule and enables them all by default', () => {
    expect(Object.keys(preset.rules)).toHaveLength(14);
    expect(Object.values(preset.rulesConfig).every((v) => v === true)).toBe(true);
    for (const rule of Object.values(preset.rules)) {
      expect(typeof rule).toBe('object');
      expect('linter' in rule && 'fixer' in rule).toBe(true);
    }
  });
});
