#!/usr/bin/env node
'use strict';

/**
 * Claude Code PreToolUse hook for writes to files with the lowercase `.md` suffix.
 *
 * The hook applies only when the nearest `.textlintrc.json` enables `preset-ste-ai`. It compares
 * the preset findings for the current and proposed content, then blocks only findings introduced
 * by the proposed Write or Edit. Every discovery or execution failure fails open.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const TEXTLINT_TIMEOUT_MS = 20_000;
const SIGKILL_GRACE_MS = 2_000;
const MAX_STDOUT_BYTES = 5 * 1024 * 1024;

let pendingChild;

/** Stop the complete child tree where the platform exposes that operation. */
function terminateTree(child, signal) {
  if (child.pid === undefined) return;

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 2_000,
      windowsHide: true,
    });
    if (result.status !== 0 || result.error !== undefined) {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited.
      }
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

function cleanupPending() {
  const child = pendingChild;
  pendingChild = undefined;
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    terminateTree(child, 'SIGKILL');
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    cleanupPending();
    process.exit(0);
  });
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function presetIsEnabled(raw) {
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof config !== 'object' || config === null) return false;
  if (typeof config.rules !== 'object' || config.rules === null) return false;
  return config.rules['preset-ste-ai'] !== undefined && config.rules['preset-ste-ai'] !== false;
}

/** The nearest config is authoritative, including when it does not enable this preset. */
function findSteAiConfig(startDir) {
  let dir = startDir;
  for (;;) {
    const configPath = path.join(dir, '.textlintrc.json');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      return presetIsEnabled(raw) ? { configDir: dir, configPath } : undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve both the JavaScript CLI and glob matcher from the selected textlint installation.
 * Resolving each dependency from its owner supports flat npm and isolated pnpm layouts without
 * depending on the plugin's own installation directory.
 */
function resolveTextlintRuntime(configDir) {
  const projectRequire = createRequire(path.join(configDir, '__ste_ai_hook__.cjs'));
  const packageJsonPath = projectRequire.resolve('textlint/package.json');
  const packageDir = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const binValue =
    typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.textlint;
  if (typeof binValue !== 'string') throw new Error('textlint does not expose a textlint CLI');
  if (typeof packageJson.dependencies?.glob !== 'string') {
    throw new Error('textlint does not declare glob as a direct dependency');
  }

  const cliPath = path.resolve(packageDir, binValue);
  const relativeCliPath = path.relative(packageDir, cliPath);
  if (
    relativeCliPath === '..' ||
    relativeCliPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCliPath)
  ) {
    throw new Error('textlint CLI resolves outside its package');
  }

  const textlintRequire = createRequire(packageJsonPath);
  const glob = textlintRequire(textlintRequire.resolve('glob'));
  if (typeof glob.Glob !== 'function' || typeof glob.Ignore !== 'function') {
    throw new Error('textlint glob dependency does not expose Glob and Ignore');
  }

  return { cliPath, Glob: glob.Glob, Ignore: glob.Ignore };
}

function loadIgnorePatterns(ignoreFilePath) {
  let raw;
  try {
    raw = fs.readFileSync(ignoreFilePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return raw.split(/\r?\n/).filter((line) => !/^\s*$/.test(line) && !/^\s*#/.test(line));
}

/**
 * Classify the real target with glob's public Ignore implementation, which is the matcher used by
 * the pinned textlint CLI. `childrenIgnored` models walker pruning without treating a trailing
 * slash such as `generated/` as if it were the recursive pattern `generated/**`.
 */
function isIgnoredByTextlint(runtime, lintCwd, realFilePath) {
  const patterns = [
    '**/.git/**',
    '**/node_modules/**',
    ...loadIgnorePatterns(path.join(lintCwd, '.textlintignore')),
  ];
  const globber = new runtime.Glob('.', {
    cwd: lintCwd,
    absolute: true,
    nodir: true,
    dot: true,
  });
  const ignore = new runtime.Ignore(patterns, globber);
  const target = globber.scurry.cwd.resolve(realFilePath);
  if (ignore.ignored(target)) return true;

  for (let ancestor = target.parent; ancestor !== undefined; ancestor = ancestor.parent) {
    if (ignore.childrenIgnored(ancestor)) return true;
    if (ancestor === globber.scurry.cwd) break;
    if (ancestor.parent === ancestor) break;
  }
  return false;
}

function parseErrors(jsonOutput) {
  const results = JSON.parse(jsonOutput);
  if (!Array.isArray(results)) throw new Error('textlint JSON output is not an array');
  return results.flatMap((result) => {
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    return messages.filter(
      (message) => message.severity === 2 && message.ruleId?.startsWith('ste-ai/'),
    );
  });
}

/** Lint in-memory content under the real target identity without writing a temporary file. */
function countErrors(runtime, configPath, lintCwd, realFilePath, content) {
  // textlint 15 treats a truly empty stdin as "no input" and prints help instead of JSON. An
  // empty document cannot contain a finding, so its exact result is known without a subprocess.
  if (content.length === 0) return Promise.resolve([]);

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        runtime.cliPath,
        '--config',
        configPath,
        '--format',
        'json',
        '--no-color',
        '--stdin',
        '--stdin-filename',
        realFilePath,
      ],
      {
        cwd: lintCwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    pendingChild = child;

    let stdout = '';
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;
    let termTimer;
    let killTimer;

    const clearState = () => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      if (pendingChild === child) pendingChild = undefined;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearState();
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminateTree(child, 'SIGKILL');
        fail(new Error('textlint produced too much output'));
        return;
      }
      stdout += chunk;
    });
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') {
        terminateTree(child, 'SIGKILL');
        fail(error);
      }
    });
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      if (timedOut) {
        fail(new Error('textlint timed out'));
        return;
      }
      if ((code !== 0 && code !== 1) || signal !== null || stdout.trim() === '') {
        fail(new Error('textlint did not produce a complete lint report'));
        return;
      }
      try {
        const errors = parseErrors(stdout);
        settled = true;
        clearState();
        resolve(errors);
      } catch (error) {
        fail(error);
      }
    });

    termTimer = setTimeout(() => {
      timedOut = true;
      terminateTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        terminateTree(child, 'SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        fail(new Error('textlint timed out'));
      }, SIGKILL_GRACE_MS);
    }, TEXTLINT_TIMEOUT_MS);

    child.stdin.end(content);
  });
}

function diffNewMessages(before, after) {
  const beforeCounts = new Map();
  for (const message of before) {
    const key = JSON.stringify([message.ruleId, message.message]);
    beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
  }

  const seen = new Map();
  return after.filter((message) => {
    const key = JSON.stringify([message.ruleId, message.message]);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return occurrence > (beforeCounts.get(key) ?? 0);
  });
}

function applyEditInMemory(currentContent, oldString, newString, replaceAll) {
  if (replaceAll === true) return currentContent.split(oldString).join(newString);
  const index = currentContent.indexOf(oldString);
  if (index === -1) return undefined;
  return (
    currentContent.slice(0, index) + newString + currentContent.slice(index + oldString.length)
  );
}

async function main() {
  const raw = readStdin();
  if (!raw.trim()) return;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof event !== 'object' || event === null) return;

  const toolName = event.tool_name;
  if (toolName !== 'Write' && toolName !== 'Edit') return;

  const suppliedFilePath = event.tool_input?.file_path;
  if (typeof suppliedFilePath !== 'string' || !suppliedFilePath.endsWith('.md')) {
    return;
  }

  try {
    const eventCwd =
      typeof event.cwd === 'string' && path.isAbsolute(event.cwd) ? event.cwd : process.cwd();
    const filePath = path.resolve(eventCwd, suppliedFilePath);
    const found = findSteAiConfig(path.dirname(filePath));
    if (found === undefined) return;

    const runtime = resolveTextlintRuntime(found.configDir);
    if (isIgnoredByTextlint(runtime, eventCwd, filePath)) return;

    const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    let wouldBeContent;
    if (toolName === 'Write') {
      wouldBeContent = event.tool_input?.content;
    } else {
      const oldString = event.tool_input?.old_string;
      const newString = event.tool_input?.new_string;
      if (typeof oldString !== 'string' || typeof newString !== 'string') return;
      wouldBeContent = applyEditInMemory(
        currentContent,
        oldString,
        newString,
        event.tool_input?.replace_all,
      );
    }
    if (typeof wouldBeContent !== 'string') return;

    const before = await countErrors(runtime, found.configPath, eventCwd, filePath, currentContent);
    const after = await countErrors(runtime, found.configPath, eventCwd, filePath, wouldBeContent);
    const newFindings = diffNewMessages(before, after);
    if (newFindings.length === 0) return;

    const lines = newFindings
      .slice(0, 10)
      .map(
        (finding) => `  ${finding.line}:${finding.column}  ${finding.message}  (${finding.ruleId})`,
      );
    process.stderr.write(
      `${[
        '--- ste-ai: this edit adds new lint findings ---',
        '',
        `File: ${filePath}`,
        `Findings before: ${before.length}, after: ${after.length}`,
        '',
        ...lines,
        '',
        'Fix these before writing. This project requires agent-authored prose to pass its own',
        'linter before the write lands.',
        '--- End ---',
      ].join('\n')}\n`,
    );
    process.exitCode = 2;
  } catch {
    // Never block a write because discovery, ignore matching, or lint execution failed.
  }
}

void main();
