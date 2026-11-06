# Setup surface review fixes: round 2 (open issues after the first pass)

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close what the first pass left open: a vault skill's link cell shows the link's target (spec F4), the
Instructions fixture's mtimes look like real ones, and the "not written yet" header copy is seen in a scenario.

**Architecture:** One task. `agentsync.SkillLinks` stops dropping vault-name links, so the wire's `linked` carries
every link and the Skills matrix titles a vault skill's Link cell with its target; the fixture follows the wire.

**Tech Stack:** Go (agentsync), React 19 + jotai, vitest, CDP scenarios.

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `docs/superpowers/specs/2026-11-06-setup-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentsync ./pkg/memhygiene ./pkg/wshrpc/wshserver`
**Check:** `go vet ./pkg/agentsync ./pkg/memhygiene ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs setup-instructions setup-skills setup-memory`

## Global Constraints

- **Never attach to CDP :9222 and never run `task verify:ui` against the default port.** See your scenario only in
  an isolated app: `ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>`.
- **Scenarios never touch real user data.** Instructions and Skills steps use `scripts/cdp/setup-fixtures.mjs`
  (in-page agentsync simulation), never the real agentsync RPCs.
- Steps run at 1600x950. Never lower an existing step's bar; add lettered sub-steps (`4b`) rather than renumbering.
- After changing a wshrpc type or its doc comment, run `task generate` and commit `frontend/types/gotypes.d.ts`.

---

### Task 1: Vault skill link target, real fixture mtimes, "not written yet" in a scenario
**Depends on:** none
**Files:** `pkg/agentsync/skills.go`, `pkg/agentsync/skills_test.go`, `pkg/wshrpc/wshrpctypes_agentsync.go`, `frontend/types/gotypes.d.ts`, `frontend/app/view/agents/skillsmatrix.ts`, `frontend/app/view/agents/skillsmatrix.test.ts`, `scripts/cdp/setup-fixtures.mjs`, `scripts/cdp/setup-fixtures.test.mjs`, `scripts/cdp/scenarios-setup-skills.mjs`, `scripts/cdp/scenarios-setup-instructions.mjs`

Spec D7 F4: "A vault skill's `linked` cell reads "Link" in the warn tone with that title" (the target). Today
`SkillLinks` (`pkg/agentsync/skills.go`) skips a link whose name is a vault skill, so the frontend never has that
target and `managedCell`'s `"linked"` case titles the cell with a fixed sentence instead. Also: the Instructions
fixture's steering mtime is `1000` with `++clock` writes while the real RPC sends UnixMilli, so the editor reads
"Last saved 20763d ago"; and the fixture has no present harness whose file is not written, so no scenario step sees
the header's "· N not written yet".

**Produces:** `SkillLinks(p)` lists every link in a present harness's skills folder, vault names included (the
`canonicalSkills` lookup goes). The wire doc comment on `AgentSyncSkillLink` and `Linked` says that: a link in a
harness skills folder, which Arc never adopts or writes through, a vault skill's name included. The frontend row
grouping is unchanged (a name that is canonical or unmanaged still makes no "Linked from another folder" row).

- [ ] Failing tests first:
  - `skills_test.go`: `TestSkillLinksListsNonVaultLinks` becomes `TestSkillLinksListsEveryLink`. A vault skill's
    link (`graphify`) is listed with its target beside the non-vault one (`notes`). The dangling-link test still
    passes.
  - `skillsmatrix.test.ts`: a vault skill whose state is `linked` and whose name has a `linked` entry → cell
    `{label: "Link", tone: "warn", title: <the entry's target, \\?\ prefix stripped as linkTarget does>}`. It makes
    no "Linked from another folder" row and does not count toward Manage. With no `linked` entry for it (an older
    backend), the title falls back to today's sentence.
- [ ] `go test ./pkg/agentsync -run 'SkillLinks|Dangling'` and `npx vitest run frontend/app/view/agents/skillsmatrix.test.ts`:
  fail; implement; pass. Run `task generate` after the comment change.
- [ ] `setup-fixtures.mjs`:
  - `linked` also lists a link under a vault skill's name, with a target under the temp root, and that skill's
    state is `linked` in that column.
  - The steering doc's mtime and every write's mtime are UnixMilli near `Date.now()`, still strictly increasing,
    so a conflict check by mtime still works.
  - Add a variant (`useVariant {key: "not-written"}`) where a present harness's `steering` is `absent`.
  - Drop the unused `mkdirSync` import from `setup-fixtures.test.mjs`. That test file covers the vault-name link and
    increasing ms mtimes.
- [ ] Scenario steps, as lettered sub-steps after the nearest existing step:
  - `setup-skills`: the vault skill's Link cell has the warn tone and its `title` equals the fixture's target.
  - `setup-instructions`, after a save: the "Last saved" text does not match `/\d+d ago/`.
  - `setup-instructions`, under `not-written`: the header reads `· 1 not written yet`.
- [ ] `npx vitest run frontend/app/view/agents/skillsmatrix.test.ts scripts/cdp/setup-fixtures.test.mjs` passes, and
  `ARC_FINAL_OUT=<new temp dir> node scripts/cdp/final-verify.mjs setup-instructions setup-skills` passes every
  step.
