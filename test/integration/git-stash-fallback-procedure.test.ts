import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

/**
 * `.claude/rules/review-cycle-efficiency.md` documents procedures for hiding uncommitted work
 * during intervening work, then restoring it exactly: `git stash push -u` / `git stash pop
 * --index`, and a two-patch fallback for when `git stash` is refused. Each procedure makes a
 * specific, falsifiable claim -- a file with both staged and unstaged changes (`git status`'s `MM`)
 * comes back exactly as `MM`, not degraded to a single state -- which prior review rounds found
 * the file's own text got wrong (plain `git stash pop`, and a single-patch fallback restored with
 * `git apply --index`, both degrade `MM` to a single state). The fallback also makes two further
 * claims: restoring the staged half must not sweep in an unrelated file the intervening work
 * touched (a broad `git add -- <files>` does, a scoped `git apply --index` on just the staged
 * patch does not), and its own scratch directory must exist before the fallback's first shell
 * redirection tries to write into it (a fresh clone or worktree has no `.tmp/` yet, since it is
 * gitignored, and a redirection into a missing directory fails before the command behind it runs).
 *
 * Per this repo's own AGENTS.md ("A doc that describes runtime behaviour needs an executable
 * pin... Verify the replacement claim empirically before writing it. Run the thing."), these cases
 * run the exact command sequences the rules file documents against a real scratch git repository,
 * not a mock, and assert the documented outcome actually holds.
 */

let repoDir: string;
let scratchDir: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
}

function statusShort(): string {
  // `git status --short`'s porcelain format is `XY filename`, where a leading space in `XY` is
  // semantically significant (` M` means unstaged-only, distinct from `M ` staged-only) -- a plain
  // `.trim()` on the whole output strips that leading space off the first line, silently turning
  // ` M f.txt` into `M f.txt` and making this helper unable to tell the two states apart. Only the
  // trailing newline is stripped.
  return git('status', '--short').replace(/\n$/, '');
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'ste-ai-stash-fallback-repo-'));
  // Patch files must live outside the repo -- writing them inside it would make git see them as
  // untracked files of their own, muddying the very status assertions this suite makes.
  scratchDir = mkdtempSync(join(tmpdir(), 'ste-ai-stash-fallback-patches-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  // Mirrors this repository's own root .gitignore (`.tmp/`), so the fallback's own scratch
  // patches never show up as untracked entries in the status assertions below -- the same way
  // they do not in the real repository the fallback procedure actually runs in.
  writeFileSync(join(repoDir, '.gitignore'), '.tmp/\n');
  writeFileSync(join(repoDir, 'f.txt'), 'line1\n');
  git('add', '.gitignore', 'f.txt');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

/** Puts `f.txt` into `MM` state: one line staged, a second line only in the working tree. */
function makeMmFile(): void {
  writeFileSync(join(repoDir, 'f.txt'), 'line1\nstaged-change\n');
  git('add', 'f.txt');
  writeFileSync(join(repoDir, 'f.txt'), 'line1\nstaged-change\nunstaged-change\n');
}

describe('git stash push/pop --index preserves a staged-and-unstaged file exactly', () => {
  it('restores MM as MM, not as a single degraded state', () => {
    makeMmFile();
    expect(statusShort()).toBe('MM f.txt');

    git('stash', 'push', '-u', '-q');
    expect(statusShort()).toBe('');

    // The intervening work would happen here.

    git('stash', 'pop', '--index', '-q');
    expect(statusShort()).toBe('MM f.txt');
  });

  it('plain "git stash pop" (no --index) demonstrably loses the staged half -- this is the bug the rule warns against, not a recommended step', () => {
    makeMmFile();
    git('stash', 'push', '-u', '-q');
    git('stash', 'pop', '-q');
    // Degrades from `MM` to ` M`: the staged half is gone.
    expect(statusShort()).toBe(' M f.txt');
  });
});

describe('the documented two-patch fallback preserves a staged-and-unstaged file exactly', () => {
  it('restores MM as MM via: two patches, revert, apply staged with --index, apply unstaged', () => {
    makeMmFile();
    expect(statusShort()).toBe('MM f.txt');

    const stagedPatch = git('diff', '--cached', '--', 'f.txt');
    const unstagedPatch = git('diff', '--', 'f.txt');

    git('checkout', 'HEAD', '--', 'f.txt');
    expect(statusShort()).toBe('');

    // The intervening work would happen here.

    const stagedPatchPath = join(scratchDir, 'staged.patch');
    const unstagedPatchPath = join(scratchDir, 'unstaged.patch');
    writeFileSync(stagedPatchPath, stagedPatch);
    writeFileSync(unstagedPatchPath, unstagedPatch);

    git('apply', '--index', '--allow-empty', stagedPatchPath);
    git('apply', '--allow-empty', unstagedPatchPath);

    expect(statusShort()).toBe('MM f.txt');
  });

  it('a single combined "git diff HEAD" patch, restored with "git apply --index", demonstrably loses the split -- this is the bug the rule warns against, not a recommended step', () => {
    makeMmFile();
    const combinedPatch = git('diff', 'HEAD', '--', 'f.txt');
    git('checkout', 'HEAD', '--', 'f.txt');

    const patchPath = join(scratchDir, 'combined.patch');
    writeFileSync(patchPath, combinedPatch);
    git('apply', '--index', patchPath);

    // Degrades from `MM` to `M `: the unstaged half is gone (fully staged instead).
    expect(statusShort()).toBe('M  f.txt');
  });

  it('restoring the staged patch with a broad "git add -- <files>" sweeps in unrelated intervening work -- this is the bug the rule warns against, not a recommended step', () => {
    writeFileSync(join(repoDir, 'g.txt'), 'other1\n');
    git('add', 'g.txt');
    git('commit', '-q', '-m', 'add g.txt');
    makeMmFile();

    const stagedPatch = git('diff', '--cached', '--', 'f.txt');
    const unstagedPatch = git('diff', '--', 'f.txt');
    git('checkout', 'HEAD', '--', 'f.txt');

    // The intervening work touches an unrelated file, left deliberately unstaged.
    writeFileSync(join(repoDir, 'g.txt'), 'other1\nintervening\n');
    expect(statusShort()).toBe(' M g.txt');

    const stagedPatchPath = join(scratchDir, 'staged.patch');
    const unstagedPatchPath = join(scratchDir, 'unstaged.patch');
    writeFileSync(stagedPatchPath, stagedPatch);
    writeFileSync(unstagedPatchPath, unstagedPatch);

    git('apply', '--allow-empty', stagedPatchPath);
    git('add', '.');
    git('apply', '--allow-empty', unstagedPatchPath);

    // The intervening g.txt change is now staged too, not just the restored f.txt patch.
    expect(statusShort()).toBe('MM f.txt\nM  g.txt');
  });

  it('restoring the staged patch with "git apply --index" leaves unrelated intervening work exactly as the intervening step left it', () => {
    writeFileSync(join(repoDir, 'g.txt'), 'other1\n');
    git('add', 'g.txt');
    git('commit', '-q', '-m', 'add g.txt');
    makeMmFile();

    const stagedPatch = git('diff', '--cached', '--', 'f.txt');
    const unstagedPatch = git('diff', '--', 'f.txt');
    git('checkout', 'HEAD', '--', 'f.txt');

    // The intervening work touches an unrelated file, left deliberately unstaged.
    writeFileSync(join(repoDir, 'g.txt'), 'other1\nintervening\n');

    const stagedPatchPath = join(scratchDir, 'staged.patch');
    const unstagedPatchPath = join(scratchDir, 'unstaged.patch');
    writeFileSync(stagedPatchPath, stagedPatch);
    writeFileSync(unstagedPatchPath, unstagedPatch);

    git('apply', '--index', '--allow-empty', stagedPatchPath);
    git('apply', '--allow-empty', unstagedPatchPath);

    // f.txt is restored to MM; g.txt's intervening change stays unstaged, untouched.
    expect(statusShort()).toBe('MM f.txt\n M g.txt');
  });

  it('the documented shell redirection into .tmp/scratch/ fails outright without mkdir -p first -- this is the bug the rule warns against, not a recommended step', () => {
    makeMmFile();
    expect(existsSync(join(repoDir, '.tmp'))).toBe(false);

    expect(() =>
      execFileSync('sh', ['-c', 'git diff --cached -- f.txt > .tmp/scratch/staged.patch'], {
        cwd: repoDir,
        encoding: 'utf8',
      }),
    ).toThrow(/No such file or directory|Directory nonexistent/);
  });

  it('running the documented mkdir -p .tmp/scratch step first lets the same redirection succeed', () => {
    makeMmFile();
    expect(statusShort()).toBe('MM f.txt');

    execFileSync(
      'sh',
      [
        '-c',
        'mkdir -p .tmp/scratch && ' +
          'git diff --cached -- f.txt > .tmp/scratch/staged.patch && ' +
          'git diff -- f.txt > .tmp/scratch/unstaged.patch',
      ],
      { cwd: repoDir, encoding: 'utf8' },
    );

    expect(existsSync(join(repoDir, '.tmp/scratch/staged.patch'))).toBe(true);
    expect(existsSync(join(repoDir, '.tmp/scratch/unstaged.patch'))).toBe(true);

    git('checkout', 'HEAD', '--', 'f.txt');
    execFileSync(
      'sh',
      [
        '-c',
        'git apply --index --allow-empty .tmp/scratch/staged.patch && ' +
          'git apply --allow-empty .tmp/scratch/unstaged.patch',
      ],
      { cwd: repoDir, encoding: 'utf8' },
    );

    expect(statusShort()).toBe('MM f.txt');
  });
});
