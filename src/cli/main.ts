#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyseText, analyseTextDeterministic } from '../analysis/analyse.js';
import type { SteAiConfigInput } from '../core/config.js';
import type { AnalysedDocument, Diagnostic, RunNotice, SuppressionRecord } from '../core/types.js';
import { deterministicRules } from '../deterministic/index.js';
import { evaluatorDefinitions } from '../semantic/evaluators.js';
import { packPermitsConformanceClaim, verifiedAuthority } from '../rule-pack/loader.js';

/**
 * `ste-ai` — a thin CLI over the programmatic API.
 *
 * It exists for machine-readable output and for inspecting the rule set. Linting a project is
 * normally done through textlint; this command is for CI jobs that want the full diagnostic
 * structure (categories, model-reported confidence, thresholds, traces) that textlint formatters
 * cannot express.
 */

const USAGE = `ste-ai — Simplified Technical English linter (provisional; not ASD-STE100 certified)

Usage:
  ste-ai lint <file...> [options]     Lint files and print diagnostics
  ste-ai rules [--json]               List rules with their authority status
  ste-ai evaluators [--json]          List semantic evaluators

Options:
  --json                  Machine-readable output on stdout
  --deterministic-only    Never contact the semantic service (default unless --semantic)
  --semantic              Enable semantic adjudication
  --endpoint <url>        llama.cpp endpoint (default http://127.0.0.1:8080)
  --model <id>            Model id recorded in traces
  --trace                 Print one trace line per semantic request to stderr
  --config <path>         JSON config file (see docs/configuration.md)
  --format <markdown|text>
  --min-severity <info|warning|error>
  --fail-on-review        Exit non-zero when review-required diagnostics are present
  -h, --help
`;

interface Args {
  readonly command: string;
  readonly files: string[];
  readonly flags: Map<string, string | boolean>;
}

/**
 * Recognised boolean options. An unknown `--flag` is a usage error rather than an ignored token:
 * a typo such as `--semantci` used to fall through silently to deterministic-only mode, producing
 * a clean-looking report for a run the operator believed was using a model.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'deterministic-only',
  'semantic',
  'trace',
  'fail-on-review',
  'help',
]);

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | boolean>();
  const files: string[] = [];
  let command = '';
  const valued = new Set(['endpoint', 'model', 'config', 'format', 'min-severity']);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '-h' || arg === '--help') {
      flags.set('help', true);
      continue;
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valued.has(name)) {
        const value = argv[i + 1];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        flags.set(name, value);
        i += 1;
      } else {
        if (!BOOLEAN_FLAGS.has(name)) {
          throw new UsageError(`Unknown option --${name}`);
        }
        flags.set(name, true);
      }
      continue;
    }
    if (command === '') command = arg;
    else files.push(arg);
  }
  return { command, files, flags };
}

const SEVERITY_ORDER = { info: 0, warning: 1, error: 2 } as const;

function buildConfig(args: Args): SteAiConfigInput {
  const configPath = args.flags.get('config');
  const base: SteAiConfigInput =
    typeof configPath === 'string'
      ? (JSON.parse(readFileSync(configPath, 'utf8')) as SteAiConfigInput)
      : {};
  const semanticEnabled = args.flags.get('semantic') === true;
  const endpoint = args.flags.get('endpoint');
  const model = args.flags.get('model');
  return {
    ...base,
    semantic: {
      ...(base.semantic ?? {}),
      enabled: semanticEnabled,
      ...(typeof endpoint === 'string' ? { endpoint } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(args.flags.get('trace') === true ? { trace: true } : {}),
    },
  };
}

async function lint(args: Args): Promise<number> {
  if (args.files.length === 0) {
    process.stderr.write('ste-ai lint needs at least one file\n');
    return 2;
  }
  const config = buildConfig(args);
  const deterministicOnly =
    args.flags.get('deterministic-only') === true || args.flags.get('semantic') !== true;
  const formatFlag = args.flags.get('format');
  const minSeverity = args.flags.get('min-severity');
  const threshold =
    typeof minSeverity === 'string' && minSeverity in SEVERITY_ORDER
      ? SEVERITY_ORDER[minSeverity as keyof typeof SEVERITY_ORDER]
      : 0;

  const results: {
    file: string;
    diagnostics: Diagnostic[];
    notices: readonly RunNotice[];
    suppressions: readonly SuppressionRecord[];
    packAuthority: string;
    declaredAuthority: string;
    conformanceClaim: string;
  }[] = [];

  // Kept beside `results` rather than in it: the entries above are serialised verbatim by `--json`,
  // and a document is neither serialisable nor anything a consumer of that output asked for.
  const documents: AnalysedDocument[] = [];

  for (const file of args.files) {
    const text = readFileSync(file, 'utf8');
    const format =
      typeof formatFlag === 'string' && (formatFlag === 'markdown' || formatFlag === 'text')
        ? formatFlag
        : /\.(txt|text)$/i.test(file)
          ? 'text'
          : 'markdown';
    const analysis = deterministicOnly
      ? analyseTextDeterministic(text, { path: file, format, config })
      : await analyseText(text, {
          path: file,
          format,
          config,
          brokerDeps: {
            trace: (t) => {
              if (args.flags.get('trace') === true) {
                process.stderr.write(`${JSON.stringify({ trace: t })}\n`);
              }
            },
          },
        });
    documents.push(analysis.document);
    results.push({
      file,
      diagnostics: analysis.diagnostics.filter((d) => SEVERITY_ORDER[d.severity] >= threshold),
      notices: analysis.notices,
      suppressions: analysis.suppressions,
      packAuthority: verifiedAuthority(analysis.pack, analysis.config.trustedRulePackIds),
      declaredAuthority: analysis.pack.metadata.authority,
      conformanceClaim: packPermitsConformanceClaim(
        analysis.pack,
        analysis.config.trustedRulePackIds,
      )
        ? analysis.pack.metadata.conformanceClaim
        : 'none',
    });
  }

  const totalErrors = results.reduce(
    (n, r) => n + r.diagnostics.filter((d) => d.severity === 'error').length,
    0,
  );
  const totalReview = results.reduce(
    (n, r) => n + r.diagnostics.filter((d) => d.category === 'review-required').length,
    0,
  );
  const infraFailure = results.some((r) =>
    r.notices.some((n) => n.code === 'semantic-service-failure' && n.level === 'error'),
  );

  if (args.flags.get('json') === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'ste-ai',
          conformance: {
            claim: results[0]?.conformanceClaim ?? 'none',
            packAuthority: results[0]?.packAuthority ?? 'provisional',
            disclaimer:
              'This tool does not certify conformance with any controlled-language standard.',
          },
          results,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const [index, result] of results.entries()) {
      process.stdout.write(`\n${result.file}\n`);
      if (result.diagnostics.length === 0) {
        process.stdout.write('  no diagnostics\n');
      }
      for (const d of result.diagnostics) {
        const confidence =
          d.modelReportedConfidence === undefined
            ? ''
            : ` model-confidence=${d.modelReportedConfidence.toFixed(2)} threshold=${d.decisionThreshold?.toFixed(2) ?? '?'}`;
        process.stdout.write(
          `  ${d.severity.padEnd(7)} ${d.category.padEnd(29)} ${d.ruleId}${confidence}\n` +
            `          ${d.message}\n`,
        );
      }
      for (const notice of result.notices) {
        process.stdout.write(
          `  notice  ${notice.level.padEnd(7)} ${notice.code}: ${notice.message}\n`,
        );
      }
      // What a suppression withheld is printed even though it is not a diagnostic: a run that says
      // nothing about the findings an author ruled out is a run that reports silence as compliance.
      const document = documents[index];
      for (const suppression of result.suppressions) {
        const position = document?.positionAt(suppression.range.start);
        process.stdout.write(
          `  suppressed  ${suppression.ruleId} at ${position?.line ?? 0}:${position?.column ?? 0}` +
            ` — ${suppression.reason}\n`,
        );
      }
    }
    process.stdout.write(
      `\n${totalErrors} error(s), ${totalReview} review-required. Provisional rules only; no conformance claim.\n`,
    );
  }

  if (infraFailure) return 3;
  if (totalErrors > 0) return 1;
  if (args.flags.get('fail-on-review') === true && totalReview > 0) return 1;
  return 0;
}

function listRules(args: Args): number {
  const rows = deterministicRules.map((r) => ({
    id: r.meta.id,
    title: r.meta.title,
    status: r.meta.status,
    sourceRef: r.meta.sourceRef,
    appliesTo: r.meta.appliesTo,
    fixable: r.meta.fixable,
    inspectsProtectedRegions: r.meta.inspectsProtectedRegions,
    defaultSeverity: r.meta.defaultSeverity,
  }));
  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(
      `${row.id.padEnd(32)} ${row.status.padEnd(13)} ${row.fixable ? 'fixable' : '       '} ${row.title}\n`,
    );
  }
  process.stdout.write(`\n${rows.length} rules. All provisional: see docs/DISCLAIMER.md.\n`);
  return 0;
}

function listEvaluators(args: Args): number {
  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(evaluatorDefinitions, null, 2)}\n`);
    return 0;
  }
  for (const e of evaluatorDefinitions) {
    process.stdout.write(`${e.id.padEnd(32)} ${e.title}\n    ${e.description}\n`);
  }
  return 0;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (args.flags.get('help') === true || args.command === '') {
    process.stdout.write(USAGE);
    return args.command === '' ? 2 : 0;
  }
  switch (args.command) {
    case 'lint':
      return await lint(args);
    case 'rules':
      return listRules(args);
    case 'evaluators':
      return listEvaluators(args);
    default:
      process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}`);
      return 2;
  }
}

/**
 * Run when this module is the process entry point.
 *
 * An earlier version tested `basename(process.argv[1]).startsWith('main')`, which is false for the
 * installed binary — npm links it as `node_modules/.bin/ste-ai` — so the published CLI parsed its
 * arguments, did nothing and exited 0. Comparing the resolved entry path to this module's own URL
 * is correct for every invocation form: `node dist/cli/main.js`, `npx ste-ai`, and a linked bin.
 */
function isEntryPoint(): boolean {
  if (process.env['STE_AI_CLI'] === '1') return true;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}

export { main, parseArgs };
