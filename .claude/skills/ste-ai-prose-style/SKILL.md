---
name: ste-ai-prose-style
description: Write or edit prose in this repository so it passes this project's own textlint preset on the first draft. Use before writing or editing any Markdown documentation file here — README.md, docs/*.md, AGENTS.md, CLAUDE.md, examples/README.md.
---

# Writing prose that already passes this repo's own linter

Draft toward these shapes. The exact numbers belong to the active rule pack, not to this skill.
The linter reports them live.

- One independent clause per sentence. A join on "and," "which," or "so" risks the grade limit.
- Few commas per sentence. A sentence needing one more needs to split instead.
- Introduce an abbreviation's full term first, in a plain sentence, outside any list.
- Never join two independent clauses with a semicolon. Write two sentences.
- Give every list item the same trailing punctuation: all full stops, or none.

## After drafting

```bash
node_modules/.bin/textlint <path>
```

Run this before considering a doc finished, not only before pushing. A hard `error`-level finding
names the exact configured limit it exceeded. Rewrite to that limit.

## What this does not cover

`review-required` findings (`info`-level, from candidate rules like `passive-voice-candidate`) are
expected in every doc in this repository — see `docs/diagnostic-policy.md`. Zero hard errors is
the bar. Zero `info` findings is not.
