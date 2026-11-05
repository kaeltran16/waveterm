# Brief live pass fixes: round 1 Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-05-brief-live-review-fixes-design.md` (F3/F5 section: the claim rule)
**Verify:** `node scripts/verify.mjs ./pkg/jarvisattrib ./pkg/jarvis && npx vitest run frontend/app/view/jarvis`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brief-act brief-inline-tracker record-band-detach-restore run-sheet-polish jira-check jira-details`

**Goal:** An `accept` left in the override log by a record that no longer exists stops claiming its run, so that run's guesses come back for the records that still exist.

**Architecture:** One Go change in `claimedRuns` (`pkg/jarvisattrib/extract.go`): an accept override claims only when its dossier id is one of the `dossiers` passed in. `EdgesFor` and `AllEdges` already pass every tasks-collection dossier, so no caller changes.

## Global Constraints

- Logic stays in the Go function with its test in `claims_test.go` beside it.
- Confirmed edges are never dropped; detach still releases a claim; a non-lead ref still claims nothing (the existing five claim tests stay green, unchanged).
- No scenario change: nothing in the UI changes for a record that exists.

## Review Focus

1. An accept whose dossier is in `dossiers` claims exactly as before (`TestAcceptedOnTwoRecordsKept` unchanged and green).
2. An accept whose dossier id is absent from `dossiers` claims nothing, so another record's layer-3 guess on that run is kept.

---

### Task 1: An accept from a deleted record claims nothing

**Files:** `pkg/jarvisattrib/extract.go`, `pkg/jarvisattrib/claims_test.go`

The change is in `claimedRuns` (extract.go, around line 152), in the override loop after "if action != \"accept\"".

**Interfaces:**
- Consumes: `claimedRuns(dossiers []*jarvisdossier.Dossier, runs []*waveobj.Run, overrides map[string]string) map[string]map[string]bool` (signature unchanged).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test** `TestAcceptFromMissingDossierClaimsNothing` in `claims_test.go`, built on the same fixture helpers as `TestClaimedGuessDropped`: a lead run R that dossier B's layer-3 rule guesses, no dossier refs R, and the override log holds `"gone|<R oref>": "accept"` where `gone` is not in `dossiers`. Assert `claimedRuns(...)[<R oref>]` is empty, and that `edgesForDossier` for B with those claims still returns R's guessed edge.
- [ ] **Step 2: Run it and see it fail:** `go test ./pkg/jarvisattrib -run '^TestAcceptFromMissingDossierClaimsNothing$'` fails (R is claimed by `gone`).
- [ ] **Step 3: Implement:** in `claimedRuns`, build a set of the ids in `dossiers` and skip an accept override whose dossier id is not in it. Layer-1 refs and detach handling are unchanged.
- [ ] **Step 4: Run the package's claim tests:** `go test ./pkg/jarvisattrib -run 'TestAccept|TestClaimed|TestUnclaimed|TestDetach|TestNonLead|TestEdgesFor'` passes.
- [ ] **Step 5: Commit** `extract.go` and `claims_test.go` with subject `fix(jarvisattrib): an accept from a deleted record claims no run` and a body saying why.
