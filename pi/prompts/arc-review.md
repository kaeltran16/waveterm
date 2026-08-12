---
description: Review the staged changes in this repo against arc's conventions
---

Review the staged changes (git diff --cached) in this repository. Work from files and commands, not
conversation history.

Check for:

- Scope creep: changes unrelated to the stated task (reformats, renames, refactors of untouched code).
- Comment quality: comments that restate code ("what" comments) instead of explaining "why".
- Conventions drift: raw hex colors in components (must be @theme tokens), hand-edited generated
  files, non-gofmt Go, missing .test.ts beside new pure .ts logic.
- Tests: business logic covered; edge cases (empty input, missing files, malformed records) handled.
- Errors: swallowed errors or generic messages without context.
- Generated-file discipline: `task generate` output present for any wire-type change; no hand edits.

Return a concise findings list ordered by severity, with file:line references. Do not edit files.

$@
