---
name: ste-ai-prose-style
description: Write or edit prose in this repository so it passes this project's own textlint preset on the first draft. Use before writing or editing any Markdown documentation file here — README.md, docs/*.md, AGENTS.md, CLAUDE.md, examples/README.md.
---

# Writing prose that already passes this repo's own linter

This repository lints its own documentation with its own preset, `ste-ai`. Every existing doc
holds to zero hard errors. Reaching that after a full draft costs avoidable rewrite passes.
Reaching it while drafting does not.

## Before writing a sentence

Hold four numeric limits in mind, not just at review time.

1. Grade level.
   - The configured Flesch-Kincaid limit is 8 for descriptive prose.
   - It is 7 for procedural steps.
   - One independent clause per sentence stays under this reliably.
   - A sentence joined by "and," "which," or "so" often does not.
2. Commas.
   - The limit is 3 per sentence.
   - A sentence needing a fourth comma needs to split into two sentences instead.
3. Abbreviations.
   - Introduce the full term before its abbreviation, at each document's first use.
   - State the abbreviation once, in a plain sentence, outside any list.
4. Semicolons.
   - Never join two independent clauses with one.
   - Write two sentences instead.

The abbreviation introduction itself belongs in flowing prose, never inside a list item. A pull
request (PR) is the working example this skill itself uses. Every later mention in this document
can then write "PR" alone.

## Lists

Give every item in a list the same trailing punctuation. Either every item ends with a full stop,
or none do.

## After drafting

Run the real linter before considering a doc finished, not only before pushing:

```bash
node_modules/.bin/textlint <path>
```

A hard `error`-level finding at that point means the draft still needs a rewrite to the limits
above. It does not mean the finding is safe to leave for later.

## What this does not cover

`review-required` findings (`info`-level, from candidate rules like `passive-voice-candidate`) are
expected in every doc in this repository. Semantic adjudication runs, or it does not, per
`docs/diagnostic-policy.md`. Zero hard errors is the bar. Zero `info` findings is not.
