# Retire the Jarvis recall arm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete proactive cards, the Ask surface and the embedding index, leaving a steer-only Brief composer and the OpenRouter key in Settings → Headless AI.

**Architecture:** Deletion runs consumer-first so every merged task builds: the frontend stops calling the retired RPCs (Tasks 1, 5), the Go leaves stop importing the retired packages (Tasks 2, 3), then one task (6) deletes the packages, the RPC surface, the object type and the config keys and runs `task generate` once — so no two tasks fight over generated files.

**Tech Stack:** Go (wavesrv, wsh, wshrpc codegen), React 19 + jotai + vitest, SQLite migrations (golang-migrate), CDP scenario harness.

**Spec:** `docs/superpowers/specs/2026-09-23-retire-jarvis-recall-arm-design.md`

**Effort:** effort:a0d245f5-64bf-42c5-aad7-049cb57b1d89
**Verify:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/... ./cmd/...`
**Setup:** `task worktree:prepare`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go vet ./pkg/... ./cmd/...`

**Task graph:** Tasks 1–4 start together. Task 5 waits on Task 1 (the pet's Ask act must be gone before `askAboutSource` is deleted). Task 6 waits on Tasks 2, 3 and 5 (nothing may still import the deleted packages or reference the deleted wire types when it regenerates).

## Global Constraints

- Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/app/store/services.ts`, `frontend/types/gotypes.d.ts`, `frontend/types/waveevent.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, `pkg/{waveobj,wconfig}/metaconsts.go`, `schema/*.json`). Only Task 6 runs `task generate`.
- The OpenRouter secret keeps its stored name **`jarvis_embedapikey`**. Renaming it orphans every stored key.
- **Kept, do not touch:** `pkg/jarviscontinuity`, `GetLatestResumeCommand`, `eventFromResume`, `pkg/jarvisstate` (ledger), `pkg/jarvisdossier`, attribution layers 1–3, `jarvisvolunteer`'s ledger / connection / loose-end producers, `pkg/consult`, the `headless:*` settings, `ResumeCard` / `resumeviews.tsx`.
- Migration `000015_jarvisconversation.*` stays in the tree; the table is dropped by a new `000020`.
- Colors from `@theme` tokens only; no new tokens.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (not `task check:ts`, which reinstalls `node_modules` inside a worktree and destroys the junction).
- Formatting: check only files you touched (`npx prettier --check <paths>`, `gofmt -l <paths>`); never `--write` the tree, never prettier `scripts/*.mjs`.
- Commit messages: `type(scope): description`, no `Co-Authored-By` or any other trailer.

## Review Focus

1. **A profile upgraded from a build that had Ask** still has `db_jarvisconversation` rows → migration 000020 drops the table and the store opens; migrating down recreates it empty. (Task 6, Step 6.)
2. **A `settings.json` still holding the three `jarvis:embed*` keys** (the user's does) → settings load, and the neighbouring `headless:openrouter*` values are still read. (Task 6, Step 8.)
3. **A Brief restore whose stored subject is a `conversation`** from before the upgrade → the Brief clears the stored subject instead of waiting forever for a conversation list that no longer loads. (Task 5, Step 3.)
4. **An OpenRouter key already stored** → Settings → Headless AI reports "A key is stored" and Clear deletes it, because the field reads the same `jarvis_embedapikey` secret. (Task 1, Step 1.)
5. **A sheet open on an initiative, a finished run, or a lead with no terminal** → no composer renders, and nothing typed is silently dropped. (Task 5, Step 1.)

---

## Task 1: Frontend — settings key move, pet recall bits, proactive views
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/agents/settingsmodel.ts`, `settingsmodel.test.ts`, `settingsstore.ts`, `settingsstore.test.ts`, `settingssurface.tsx`
- Modify: `frontend/app/view/jarvis/petacts.ts`, `petacts.test.ts`, `petactrun.ts`, `petactrun.test.ts`, `petjoin.ts`, `petjoin.test.ts`, `petstore.ts`, `petpeekmodel.ts`, `petpeekmodel.test.ts`, `petsources.tsx`, `petbubble.tsx`, `petvoice.ts`, `petpeek.tsx`, `petcondition.ts` (wherever `PetSignals["index"]` is declared or read)
- Delete: `frontend/app/view/jarvis/petindex.ts`, `petindex.test.ts`, `frontend/app/view/agents/proactive.ts`, `proactive.test.ts`, `proactiveviews.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: no frontend code calls `GetEmbedIndexStatusCommand`, `EmbedReconcileCommand`, `ListProactiveRefusalsCommand`, or references `EmbedIndexStatus`; `askAboutSource` has no caller outside `frontend/app/view/jarvis/jarvissubjectstore.ts` (Task 5 deletes it). `PetAct` is `{ id: string; verb: "open"; label: string; target: PetTarget }` only.

- [ ] **Step 1: Settings — failing tests first**

In `frontend/app/view/agents/settingsmodel.test.ts`: in the import, replace `SECTION_EMBEDDINGS` with `OPENROUTER_SECRET_NAME`; replace the test `"keeps the embeddings deep-link target pointing at a real section"` with the two below, and remove the three `"jarvis:embed*"` lines from the `"marks exactly the wconfig-backed rows as config rows"` expectation.

```ts
    it("offers the OpenRouter key where the OpenRouter models are set", () => {
        const headless = sections().find((s) => s.id === "headless")!;
        const key = headless.rows.find((r) => r.id === "headless.apikey")!;
        expect(key.key).toBe("keychain");
        expect(key.scope).toBe("local");
        expect(key.config).toBeUndefined();
    });

    it("reads the OpenRouter key from the secret it has always been stored under", () => {
        // renaming it would orphan every stored key; pkg/consult/openrouter.go reads the same name
        expect(OPENROUTER_SECRET_NAME).toBe("jarvis_embedapikey");
    });

    it("has no embeddings section", () => {
        expect(sections().some((s) => s.id === "embeddings")).toBe(false);
        const keys = sections().flatMap((s) => s.rows.map((r) => r.key));
        expect(keys.some((k) => k.startsWith("jarvis:embed"))).toBe(false);
    });
```

In `settingsstore.test.ts` replace `SETTINGS_SECTION_EMBEDDINGS` with the literal section id `"headless"` (import only `pendingSettingsSectionAtom, takePendingSettingsSection`).

Run: `npx vitest run frontend/app/view/agents/settingsmodel.test.ts frontend/app/view/agents/settingsstore.test.ts`
Expected: FAIL (`headless.apikey` missing; embeddings section still present).

- [ ] **Step 2: Settings — implement**

`settingsmodel.ts`: delete `SECTION_EMBEDDINGS` and the whole `id: SECTION_EMBEDDINGS` section. In the `headless` section, add this row after `headless.runtime`, and fix the two model descriptions that name retired features:

```ts
                {
                    id: "headless.apikey",
                    title: "OpenRouter API key",
                    desc: "OS secret store — never in settings, never shown again.",
                    key: "keychain",
                    scope: "local",
                },
```

- `headless.cheap` desc → `"For mechanical tasks: gatekeeper, decompose, continuity, volunteer judge."`
- `headless.mid` desc → `"For synthesis: radar, Jarvis."`

`settingsstore.ts`: delete the `SECTION_EMBEDDINGS` import, the `SETTINGS_SECTION_EMBEDDINGS` export and the comment above it.

`settingssurface.tsx`:
- Delete `EmbeddingsSection` and its `case "embeddings":` arm, and the deep-link comment at ~line 213 that names Embeddings.
- Delete the `EMBED_SECRET_NAME` declaration and its comment; import `OPENROUTER_SECRET_NAME` from `./settingsmodel` instead. In `settingsmodel.ts` (pure, so the test can pin it) add:

```ts
// The secret pkg/consult/openrouter.go reads. Named for the embedding lane that first stored it; the name
// stays because renaming it would orphan every key already stored. Never read back into the UI.
// Underscore, not colon: SetSecret validates against the shell env-var charset and rejects colons.
export const OPENROUTER_SECRET_NAME = "jarvis_embedapikey";
```

- In `HeadlessAISection`, move the key handling in from the deleted section: the `error` state, `saveKey`, `clearKey` (same bodies, using `OPENROUTER_SECRET_NAME`), and the probe's `setHasKey((names ?? []).includes(OPENROUTER_SECRET_NAME))`. Render this row directly after the runtime row:

```tsx
            <SettingRow id="headless.apikey">
                <span className={cn("text-[12px] font-semibold", hasKey ? "text-success-soft" : "text-muted")}>
                    {hasKey ? "A key is stored." : "No key stored."}
                </span>
                <SecretInput
                    placeholder={hasKey ? "••••••••  (enter a new key to replace)" : "sk-or-…"}
                    onCommit={saveKey}
                />
                {hasKey ? (
                    <button
                        type="button"
                        onClick={clearKey}
                        className="flex-none cursor-pointer rounded border border-edge-mid px-3 py-[6px] text-[12px] font-semibold text-secondary transition-colors hover:border-error/50 hover:text-error"
                    >
                        Clear
                    </button>
                ) : null}
            </SettingRow>
```

- The "key not set" note becomes `OpenRouter key not set — background AI features stay off until a key is stored.` and `{error ? <Note tone="error">{error}</Note> : null}` is added at the end of the section.

Run: `npx vitest run frontend/app/view/agents/settingsmodel.test.ts frontend/app/view/agents/settingsstore.test.ts`
Expected: PASS.

- [ ] **Step 3: Pet acts — failing tests first**

In `petacts.test.ts` delete every `actsForRecall` test and replace the `actsForEvent` expectations with:

```ts
describe("actsForEvent", () => {
    it("offers one Open per source and nothing else", () => {
        const acts = actsForEvent({
            id: "e1",
            sources: [
                { ref: "task:t1", title: "Spawn test", sourceType: "task" },
                { ref: "run:r1", title: "Run r1", sourceType: "run", anchor: "a1" },
            ],
        } as any);
        expect(acts).toEqual([
            { id: "e1:task:t1:open", verb: "open", label: "Open Spawn test", target: { kind: "oref", ref: "task:t1", anchor: undefined } },
            { id: "e1:run:r1:open", verb: "open", label: "Open Run r1", target: { kind: "oref", ref: "run:r1", anchor: "a1" } },
        ]);
    });

    it("offers nothing for an event with no sources", () => {
        expect(actsForEvent({ id: "e2" })).toEqual([]);
    });
});
```

In `petactrun.test.ts` delete the tests for the `do` verb (reconcile), the `ask` verb, and the `settings-embeddings` escort; keep the `oref` escort tests. In `petjoin.test.ts` delete the `indexSignal` / `recallLine` tests (keep `eventFromResume`). In `petpeekmodel.test.ts` remove the `index` input from every fixture and delete the test built on `OFF = { state: "off", reason: "disabled" }`.

Run: `npx vitest run frontend/app/view/jarvis/petacts.test.ts`
Expected: FAIL (the Ask act is still produced).

- [ ] **Step 4: Pet — implement**

`petacts.ts`: delete `PetOp`, `AskSeed`, `RECALL_CATCHUP_ACT_ID`, `CONFIG_REASONS`, `actsForRecall`, the `"ask"` push in `actsForEvent`, and the comments that describe them. What remains of the types:

```ts
// Where an escort lands; every landing is an address that goes through openAddress.
export type PetTarget = { kind: "oref"; ref: string; anchor?: string };

export type PetAct = { id: string; verb: "open"; label: string; target: PetTarget };
```

`actsForEvent`'s header comment becomes `// One Open per source the event carries.`

`petactrun.ts`: delete `perform`, the `ask` branch of `runAct`, the settings branch of `escort`, and the imports `askAboutSource`, `startIndexCatchUp`, `pendingSettingsSectionAtom`, `SETTINGS_SECTION_EMBEDDINGS`. `escort` keeps only the `oref` path and `runAct` becomes `await escort(model, act)`.

Delete `petindex.ts` + `petindex.test.ts`. In `petstore.ts` delete `petIndexAtom`. In `petjoin.ts` delete `indexSignal`, `recallLine`, their comments, and `"recall"` from `VOLUNTEER_KINDS`. In `petvoice.ts` delete the `"recall-ready"` and `"recall"` members of the event-kind union; in `petbubble.tsx` delete the `"recall-ready": "Recall"` label. In `petpeekmodel.ts` delete the `index` input and every branch that reads it. In `petsources.tsx` delete the index poll (`INDEX_POLL_MS`, the `loadIndexStatus` loader and its timer). Where `PetSignals["index"]` is declared (`petcondition.ts`), delete the field and its readers. `petpeek.tsx` stops rendering the recall row and any `do`/`ask` act button.

Delete `frontend/app/view/agents/proactive.ts`, `proactive.test.ts`, `proactiveviews.tsx` (no importer outside themselves).

- [ ] **Step 5: Verify the task**

Run: `npx vitest run frontend/app/view/jarvis frontend/app/view/agents`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

Run: `git grep -nE "GetEmbedIndexStatus|EmbedReconcile|ListProactiveRefusals|EmbedIndexStatus|petIndexAtom|actsForRecall|SECTION_EMBEDDINGS|settings-embeddings|recall-ready|EMBED_SECRET_NAME|proactiveviews" -- frontend ':!frontend/types' ':!frontend/app/store/wshclientapi.ts'`
Expected: no output. Then `git grep -n "askAboutSource" -- frontend` lists only `frontend/app/view/jarvis/jarvissubjectstore.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/app/view/agents frontend/app/view/jarvis
git commit -m "refactor(jarvis): drop the pet's recall acts and move the OpenRouter key into Headless AI settings"
```

---

## Task 2: Go leaves — drop attribution L4, the volunteer recall producer, memroots leftovers
**Depends on:** none

**Files:**
- Delete: `pkg/jarvisattrib/semantic.go`, `pkg/jarvisattrib/semantic_test.go`, `pkg/jarvisvolunteer/recall.go`, `pkg/jarvisvolunteer/recall_test.go`
- Modify: `pkg/jarvisattrib/lifecycle.go`, `lifecycle_test.go`, `edges.go`, `liveprobe_test.go`; `pkg/jarvisvolunteer/volunteer.go`, `candidate.go`, `judge_test.go` (if it references recall); `pkg/memroots/memroots.go`, `pkg/memroots/*_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `pkg/jarvisattrib` and `pkg/jarvisvolunteer` no longer import `pkg/jarvisembed` or `pkg/jarvisproactive`; `memroots` exports no `AllRoots`, `Mirrors` or `Mirror`.

- [ ] **Step 1: Failing test — an orphan dossier gets no edges**

Replace `TestSemanticProposalSkippedForACorrectedDossier` in `pkg/jarvisattrib/lifecycle_test.go` (and delete any other test that calls `shouldProposeSemantic` or `SetOpenIndexForTest`) with:

```go
// With L4 gone an orphan dossier stays an orphan: the deterministic layers are the whole answer, and a
// read never reaches for an embedding index.
func TestOrphanDossierHasNoEdges(t *testing.T) {
	d := &jarvisdossier.Dossier{ID: "d1"}
	got := edgesForDossier(context.Background(), d, nil, edgeLookups{}, map[string]string{}, 0)
	if len(got) != 0 {
		t.Fatalf("orphan dossier edges = %v, want none", got)
	}
}
```

(If `edgeLookups{}` needs non-nil function fields for `assembleEdges` with zero runs, build it the way the existing `lifecycle_test.go` fixtures do.)

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/ -run TestOrphanDossierHasNoEdges`
Expected: FAIL to compile or FAIL — `edgesForDossier` still calls the semantic path.

- [ ] **Step 2: Implement — attribution**

Delete `semantic.go` and `semantic_test.go`. In `lifecycle.go` replace `edgesForDossier` and delete `shouldProposeSemantic` with its comment:

```go
// edgesForDossier is the shared per-dossier core behind EdgesFor and AllEdges: the deterministic layers
// with the override log applied.
func edgesForDossier(ctx context.Context, d *jarvisdossier.Dossier, runs []*waveobj.Run, lk edgeLookups, ov map[string]string, now int64) []AttributedEdge {
	return applyOverrides(assembleEdges(d, runs, lk, now), ov)
}
```

Keep the `ctx` parameter only if a caller still passes it and something else in the body needs it; if `go vet` reports it unused, drop it from the signature and its two callers. In `edges.go` delete `weightLayer4` and the `case 4:` arm of `confidenceFor`, and any `BucketFor` branch or comment that names layer 4. In `liveprobe_test.go` delete the `jarvisembed` import and the `embeddings available=` log line, and change the header comment's L4 paragraph to say the probe is deterministic.

- [ ] **Step 3: Implement — volunteer recall producer**

Delete `recall.go` and `recall_test.go`. In `volunteer.go`:

```go
	case TriggerRunCreated:
		return []Producer{NewLedgerProducer()}
```

In `candidate.go` delete `ClassRecall`. Remove any remaining reference in `jarvisvolunteer` tests (`git grep -n "ClassRecall\|RecallProducer\|jarvisproactive" pkg/jarvisvolunteer` must print nothing).

- [ ] **Step 4: Implement — memroots leftovers**

In `pkg/memroots/memroots.go` delete `Mirror`, `buildMirrors`, `Mirrors`, `buildAllRoots`, `AllRoots` and their comments, plus the tests that only exercise them. `MemoryRoot` and `SteeringDocPath` stay. Confirm: `git grep -nE "memroots\.(AllRoots|Mirrors|Mirror)\b"` prints nothing.

- [ ] **Step 5: Verify**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvisattrib/ ./pkg/jarvisvolunteer/ ./pkg/memroots/ ./pkg/wshrpc/...`
Expected: PASS.

Run: `git grep -nE "jarvisembed|jarvisproactive" -- pkg/jarvisattrib pkg/jarvisvolunteer`
Expected: no output.

Run: `gofmt -l pkg/jarvisattrib pkg/jarvisvolunteer pkg/memroots`
Expected: no file you touched is listed.

- [ ] **Step 6: Commit**

```bash
git add -A pkg/jarvisattrib pkg/jarvisvolunteer pkg/memroots
git commit -m "refactor(jarvis): drop semantic attribution and the recall volunteer, which found nothing"
```

---

## Task 3: CLI and pi — delete `wsh jarvis ask` and `wave_vault_ask`
**Depends on:** none

**Files:**
- Rename: `cmd/wsh/cmd/wshcmd-jarvisask.go` → `cmd/wsh/cmd/wshcmd-jarvisstatus.go`, `wshcmd-jarvisask_test.go` → `wshcmd-jarvisstatus_test.go`
- Modify: `pi/extensions/waveterm-tools-core.ts`, `pi/extensions/waveterm-tools-core.test.ts`
- Regenerated copy: `cmd/wsh/cmd/pi-tools-core-extension.ts` (via `task sync:piartifacts`, never by hand)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing in `cmd/` calls `wshclient.JarvisAskCommand`; `wsh jarvis status` still exists with `renderCaptureStatus(st wshrpc.CaptureStatus) string` (Task 6 drops its index line).

- [ ] **Step 1: Failing test**

`git mv` both files. In the test file replace `TestJarvisAskSubcommandRegistered` with:

```go
func TestJarvisAskSubcommandRetired(t *testing.T) {
	for _, c := range jarvisCmd.Commands() {
		if c.Name() == "ask" {
			t.Fatal("wsh jarvis ask is retired but still registered")
		}
	}
}
```

Run: `go test ./cmd/wsh/cmd/ -run TestJarvisAskSubcommandRetired`
Expected: FAIL.

- [ ] **Step 2: Implement**

In `wshcmd-jarvisstatus.go` delete `jarvisAskCmd`, `jarvisAskRun`, `jarvisCmd.AddCommand(jarvisAskCmd)` and any flag registration and import only they used.

In `pi/extensions/waveterm-tools-core.ts` delete the `wave_vault_ask` tool (its registration, the comment at ~line 36, and any helper only it calls); delete its cases in `waveterm-tools-core.test.ts`. Then run `task sync:piartifacts` so `cmd/wsh/cmd/pi-tools-core-extension.ts` matches.

- [ ] **Step 3: Verify**

Run: `go test ./cmd/wsh/cmd/ && npx vitest run pi/extensions`
Expected: PASS.

Run: `git grep -nE "wave_vault_ask|jarvis ask|JarvisAskCommand" -- cmd pi`
Expected: no output (`wshclient.go` is under `pkg/`, regenerated in Task 6).

- [ ] **Step 4: Commit**

```bash
git add -A cmd/wsh/cmd pi/extensions
git commit -m "refactor(wsh): retire jarvis ask, which mostly returned not-found"
```

---

## Task 4: Docs — record the retirement
**Depends on:** none

**Files:**
- Modify: `docs/deferred.md`, `docs/open-issues.md`, and any file under `docs/agents/` that documents `wsh jarvis ask` or `wave_vault_ask`

**Interfaces:** none.

- [ ] **Step 1: `docs/deferred.md`**

Replace the last bullet of the memory-corpus entry (`- \`jarvisproactive\` and the Ask surface still exist …`) with `- \`jarvisproactive\` and the Ask surface — retired 2026-09-23, see "The Jarvis recall arm" below.` Replace the whole "Five agentsync RPCs left with no caller" entry with one line: `Five agentsync RPCs left with no caller — deleted with the recall arm (2026-09-23); \`pkg/agentsync\` functions stay.` Append:

```markdown
### The Jarvis recall arm — retired 2026-09-23

Proactive "related prior work" cards, the Ask surface (the Brief's ask thread, the palette's Ask group,
the Ask Jarvis buttons, the pet's Ask act, `wsh jarvis ask`, pi's `wave_vault_ask`, persisted
conversations) and the embedding index (`pkg/jarvisembed`, attribution layer 4, the Settings Embeddings
section) are deleted. Spec: `docs/superpowers/specs/2026-09-23-retire-jarvis-recall-arm-design.md`.

Evidence, measured 2026-09-23: of 89 runs with a proactive evaluation, 14 hit and one hit was useful;
~14 of 22 agent `wave_vault_ask` calls returned not-found; attribution L4 produced 0 of 352 edges.

Kept: the resume narrative (`jarviscontinuity`), the ledger, attribution L1–3, OpenRouter as the headless
runtime. Its key still lives in the secret `jarvis_embedapikey`, now set from Settings → Headless AI.

Recovery: `git log --diff-filter=D --oneline -- pkg/jarvisrecall pkg/jarvisproactive pkg/jarvisembed`
names the deleting commit; then `git show <commit>^:pkg/jarvisrecall/ask.go` (any path). The table is
recreated by `db/migrations-wstore/000020_drop_jarvisconversation.down.sql`.

Manual cleanup on an existing profile (no code touches user data): delete `data\jarvis\index.db`, the
`jarvis:embedenabled` / `jarvis:embedbaseurl` / `jarvis:embedmodel` lines in `settings.json`, and the
inert `memgarden-state.json`, `memory-distill-queue.json`, `memory-decay-restore-done.txt`,
`memory-recall-epoch.txt` in `data\`.
```

- [ ] **Step 2: `docs/open-issues.md`**

Set the Status cell of "Ask-mode consult results (§4a item 11)" and "Resume / proactive cards (§4a item 12)" to `closed — Ask and proactive retired 2026-09-23 (docs/deferred.md, "The Jarvis recall arm"); ResumeCard stays orphaned`.

- [ ] **Step 3: `docs/agents/`**

Run `git grep -nE "jarvis ask|wave_vault_ask|semantic recall|embedding index" -- docs/agents docs/README.md` and delete or rewrite each hit so it no longer describes a live feature.

- [ ] **Step 4: Commit**

```bash
git add docs/deferred.md docs/open-issues.md docs/agents docs/README.md
git commit -m "docs(jarvis): record the recall arm retirement and its evidence"
```

---

## Task 5: Frontend — steer-only Brief composer and the Ask cascade
**Depends on:** Task 1
**Chunk:** Rework the CDP scenarios that drive Ask: jarvis-ask, jarvis-vault-recall, jarvis-multiturn, resource-linking, brief-contextual-map

**Files:**
- Modify: `frontend/app/view/jarvis/briefcomposertarget.ts` (+ test), `briefcompose.ts` (+ test), `briefrestore.ts` (+ test), `subjectrestore.ts` (+ test), `subjects.ts`, `briefsurface.tsx`, `briefingstore.ts` (+ test), `jarvisstore.ts`, `jarvissubjectstore.ts`, `graphpeek.tsx`, `openref.ts`, `linkingdevhooks.ts`, `briefingfixtures.ts`, `jarvisfixturebar.tsx`
- Modify: `frontend/app/cockpit/command-palette.tsx`, `palette-entities.ts`, `uiclient.ts`, the palette model that defines `buildAskItems` (+ its test); `frontend/app/store/keybindings/bindings.ts`, `whenstate.ts`
- Modify: `frontend/app/view/agents/runbody.tsx`, `runcompletionsurface.tsx`, `radarfindingdetail.tsx`
- Delete: `frontend/app/view/jarvis/contextualentry.tsx`, `briefdrew.ts`, `briefturn.ts`, and each of `jarviscontract.ts`, `jarvisturnderive.ts`, `recallderive.ts`, `mentions.ts` that has no importer left (with tests)
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Consumes: Task 1 left `askAboutSource` with no caller outside `jarvissubjectstore.ts`.
- Produces: no frontend code calls `JarvisAskCommand`, `JarvisConverseCommand`, `ListJarvisConversationsCommand` or references `JarvisConversationSummary` / `CommandJarvisAskRtnData` / `JarvisConverseChunk`. `resolveBriefComposerTarget(input: BriefTargetInput): BriefComposerTarget | null`.

- [ ] **Step 1: Composer target — failing tests**

Rewrite `briefcomposertarget.test.ts` expectations (keep its fixtures `run()`, `agent()`, `channelRun`):

```ts
describe("resolveBriefComposerTarget", () => {
    it("has no composer with the sheet closed", () => {
        expect(resolveBriefComposerTarget({ sheetOpen: false, face: channelRun, run: run(), agents: [agent()] })).toBeNull();
    });

    it("has no composer on an empty sheet", () => {
        expect(resolveBriefComposerTarget({ sheetOpen: true, face: { kind: "none" }, run: null, agents: [] })).toBeNull();
    });

    it("has no composer on an initiative sheet — an initiative has no worker to message", () => {
        expect(
            resolveBriefComposerTarget({ sheetOpen: true, face: { kind: "effort", effortId: "e1" } as any, run: null, agents: [], effortTitle: "Retire recall" })
        ).toBeNull();
    });

    it("has no composer for a finished run", () => {
        const done = { ...run(), status: "done" } as any;
        expect(resolveBriefComposerTarget({ sheetOpen: true, face: channelRun, run: done, agents: [agent()] })).toBeNull();
    });

    it("has no composer for a lead with no terminal", () => {
        expect(resolveBriefComposerTarget({ sheetOpen: true, face: channelRun, run: run(), agents: [agent({ blockId: "" })] })).toBeNull();
    });

    it("messages the live lead of the open session", () => {
        const t = resolveBriefComposerTarget({ sheetOpen: true, face: channelRun, run: run(), agents: [agent()], projectName: "waveterm" });
        expect(t).toMatchObject({ audience: "worker", sessionName: "waveterm" });
    });
});
```

Match `agent(...)`'s override shape and the finished-run status value to the fixtures already in the file; the six cases are what must hold.

Run: `npx vitest run frontend/app/view/jarvis/briefcomposertarget.test.ts`
Expected: FAIL (returns `{ audience: "brief" }` / `"initiative"`).

- [ ] **Step 2: Composer target and labels — implement**

`briefcomposertarget.ts` — the type and resolver become:

```ts
// The one shape a Brief composer has: a session drawer with a live lead. Anything else has no one to
// talk to, so there is no composer (the Ask audiences were retired 2026-09-23, docs/deferred.md).
export type BriefComposerTarget = {
    audience: "worker";
    channelId: string;
    workerORef: string;
    workerName: string;
    sessionName: string;
};

/** Pure: what the sheet is drawing -> who the composer is talking to, or null for no composer. */
export function resolveBriefComposerTarget(input: BriefTargetInput): BriefComposerTarget | null {
    const face = input.face;
    if (!input.sheetOpen || face.kind !== "channel" || face.body !== "run" || input.run == null) {
        return null;
    }
    const lead = steerTarget(input.run, input.agents);
    // a worker with no blockId has no terminal to write to, so steerWorker would no-op: no composer
    // rather than one whose send silently does nothing.
    if (lead?.blockId == null || lead.blockId === "") {
        return null;
    }
    return {
        audience: "worker",
        channelId: face.channelId,
        workerORef: `tab:${lead.id}`,
        workerName: lead.name,
        sessionName: input.projectName?.trim() || lead.name,
    };
}
```

Use the real discriminant for a run sheet from `briefsheetmodel.ts` `SheetFace` (the old code read `face.body !== "run"` after excluding `"none"` and `"effort"`; keep exactly that condition if the kind is not literally `"channel"`). Drop `effortTitle` from `BriefTargetInput`. Rewrite the file header comment to match.

`briefcompose.ts` — one shape left:

```ts
// The words on the Brief's composer, which exists only on a session sheet with a live lead
// (briefcomposertarget.ts). The user must never be unsure a keystroke reaches a running worker.
export interface ComposerLabels {
    scope: string;
    hint: string;
    action: string;
    // the second thing Enter could do here, absent when there is no second thing
    alt?: string;
}

export function resolveComposerLabels(project?: string): ComposerLabels {
    const p = project?.trim();
    return {
        scope: "scoped to this session",
        hint: "Message the lead of this session",
        action: "Send ⏎",
        // a standing rule outlives the session, so it needs a project to stand for: no project, no offer.
        ...(p ? { alt: `⇧⏎ standing rule for ${p}` } : {}),
    };
}
```

Replace `briefcompose.test.ts` with:

```ts
describe("resolveComposerLabels", () => {
    it("offers a standing rule when the session has a project", () => {
        expect(resolveComposerLabels("waveterm")).toEqual({
            scope: "scoped to this session",
            hint: "Message the lead of this session",
            action: "Send ⏎",
            alt: "⇧⏎ standing rule for waveterm",
        });
    });

    it("offers no standing rule without a project", () => {
        expect(resolveComposerLabels("  ").alt).toBeUndefined();
    });
});
```

Run: `npx vitest run frontend/app/view/jarvis/briefcomposertarget.test.ts frontend/app/view/jarvis/briefcompose.test.ts`
Expected: PASS.

- [ ] **Step 3: Restore — a stored conversation clears**

Add to `subjectrestore.test.ts`:

```ts
it("clears a stored conversation left over from before Ask was retired", () => {
    const lists = { channels: ["c1"], dossiers: ["d1"] };
    expect(restoreDecision({ kind: "conversation", id: "x" } as any, lists)).toEqual({ action: "clear" });
});
```

Run it: FAIL (it waits on `lists.conversations`). Then in `subjectrestore.ts` drop `conversations` from `SubjectListState` and make `restoreDecision` clear every kind that is not `channel` or `dossier`:

```ts
export function restoreDecision(stored: StoredSubject | null, lists: SubjectListState): RestoreAction {
    // only channels and dossiers are restorable; anything else stored (a briefing, or a conversation from
    // before Ask was retired) is treated as absent rather than waiting on a list that never loads.
    if (stored == null || (stored.kind !== "channel" && stored.kind !== "dossier")) {
        return { action: "clear" };
    }
    const list = stored.kind === "channel" ? lists.channels : lists.dossiers;
    if (list == null) {
        return { action: "wait" };
    }
    return list.includes(stored.id) ? { action: "select", subject: stored } : { action: "clear" };
}
```

Remove `"conversation"` from `SubjectKind` in `subjects.ts` and fix every switch that handled it. In `briefrestore.ts` delete the `conversation` plan and return `{ action: "channel", id: subject.id }` for the remaining kind; update `briefrestore.test.ts` accordingly. Re-run: PASS.

- [ ] **Step 4: Brief surface — render the composer only for a live lead, delete the thread**

In `briefsurface.tsx`:
- `const target = resolveBriefComposerTarget({...})` without `effortTitle`; when `target == null` the composer element is not rendered at all.
- `const labels = resolveComposerLabels(channelProjectLabel(channel, projects))`.
- `submit` keeps only the steer branch (`steerWorker` + the give-the-words-back error); `inFlight` goes; `canSend = draft.trim() !== ""`. `addStandingRule` stays.
- Delete the thread: `briefThreadAtom` reads, `askJarvis`, the answer→turn effect, `DrewBand`, per-turn citation chips, `SourceChip`, `conversation` construction, `loadJarvisConversations` / `selectConversation` / hydration, the `onAskAbout` prop passed to the graph peek, and the imports that only they used.

In `graphpeek.tsx` delete the `onAskAbout` prop, its button, and the `sourceRefForGraphNode` import.

- [ ] **Step 5: Delete the Ask cascade**

- `briefingstore.ts`: delete `briefThreadAtom`, `askBriefThread`, `askAcrossWork`, `askAcrossWorkAsync`, `askGeneration`, `hydrateBriefThread`, `briefingAnswerFromTurn`, `primeBriefThread`, `clearBriefThread`, `briefingAnswerAtom`, `briefingAskStateAtom`, `mapWireCard` use, and the scope atoms only these read. Trim `briefingstore.test.ts` to what remains.
- `jarvisstore.ts`: delete from `conversationsByIdAtom` through `submitJarvisQuery` (the conversation half). The atoms above it stay.
- `jarvissubjectstore.ts`: delete `askAboutSource`, `askAboutRecord`, `conversationForSource`, `asSourceType`, `SOURCE_TYPES` if now unused, and every conversation subject path (`selectConversation` / `startConversation` calls).
- Delete `contextualentry.tsx`; remove `<AskJarvisButton …/>` and its import from `runbody.tsx`, `runcompletionsurface.tsx`, `radarfindingdetail.tsx`.
- `command-palette.tsx`: delete `askDeps`, `askItems`, the Ask group rendering, and the `askBriefThread` import; delete `buildAskItems` from its module and its tests. `palette-entities.ts`: delete the conversation rows and `loadJarvisConversations`. `openref.ts`, `uiclient.ts`, `bindings.ts`, `whenstate.ts`: delete conversation targets/predicates.
- `linkingdevhooks.ts`, `briefingfixtures.ts`, `jarvisfixturebar.tsx`: delete thread/grounding fixtures and hooks.
- Delete `briefdrew.ts`, `briefturn.ts` (+ tests). For `jarviscontract.ts`, `jarvisturnderive.ts`, `recallderive.ts`, `mentions.ts`: run `git grep -n "<module name>" -- frontend` after the edits above; delete the module and its test when only itself and its test remain, otherwise delete just the now-unused exports.

- [ ] **Step 6: CDP scenarios**

In `scripts/cdp/scenarios.mjs` (keep its 4-space hand formatting; do not run prettier on it):
- Delete scenarios `jarvis-ask`, `jarvis-multiturn`, `jarvis-vault-recall` and the `askBrief` helper.
- `surface-smoke`, `runs-lifecycle`: delete the steps that ask the Brief or look for a proactive card.
- `brief-restore`: delete step 2 (stored conversation hydrates) and add a step that stores `{ kind: "conversation", id: "gone" }` and asserts the Brief clears it (no subject selected, no error overlay).
- `brief-peek`, `brief-contextual-map`, `resource-linking`: remove any conversation fixture or ask step; the scenario must reach its subject through a dossier or channel.
- Add:

```js
{
    name: "brief-composer-steer-only",
    surface: "jarvis",
    async arrange(h) {
        // start with no sheet open: Escape closes whatever a previous scenario left behind
        await h.goto("jarvis");
        await h.ev(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
        );
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("jarvis");
        await h.ev("new Promise((r) => setTimeout(r, 700))");
        steps.push({
            step: "1. the Brief shows no composer while no session sheet is open",
            ok:
                (await h.ev(`!!document.querySelector('[data-jarvis-region="brief"]')`)) === true &&
                (await h.ev(`document.querySelector('[data-jarvis-brief-composer]') == null`)) === true,
            detail: "",
        });
        await h.shot("cdp-shots/brief-composer-steer-only.png");
        return steps;
    },
    async teardown(h) {},
},
```

Opening a live session's sheet needs a live worker, so the "composer present" half is checked by hand at the final verification.

Run: `node --check scripts/cdp/scenarios.mjs`
Expected: exit 0.

- [ ] **Step 7: Verify**

Run: `npx vitest run && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: PASS, exit 0.

Run: `git grep -nE "JarvisAskCommand|JarvisConverseCommand|ListJarvisConversations|JarvisConversationSummary|askBriefThread|askAcrossWork|askAboutSource|AskJarvisButton|briefThreadAtom|submitJarvisQuery|SourceChip|onAskAbout" -- frontend scripts ':!frontend/types' ':!frontend/app/store/wshclientapi.ts'`
Expected: no output.

Run: `npx prettier --check` on the frontend files you touched (not `scripts/*.mjs`).

- [ ] **Step 8: Commit**

```bash
git add -A frontend scripts/cdp/scenarios.mjs
git commit -m "refactor(jarvis): make the Brief composer steer-only and delete the Ask thread"
```

---

## Task 6: Backend — delete the packages, the RPC surface, the object type and the config keys
**Depends on:** Task 2, Task 3, Task 5
**Chunk:** Remove pkg/jarvisproactive: the package, the jarvis:proactive run.Meta key, ProactiveCard, listproactiverefusals
**Chunk:** Remove the Ask path: jarvisrecall Ask/Converse, the Brief ask composer and its thread, db_jarvisconversation + its migration
**Chunk:** Remove jarvisembed, L4 attribution and the embedding settings; move the OpenRouter key into Background AI
**Chunk:** Prune what the memvault removal already orphaned: memroots.AllRoots/Mirrors, the 5 agentsync RPCs, 4 dead state files

**Files:**
- Delete: `pkg/jarvisproactive/`, `pkg/jarvisrecall/`, `pkg/jarvisembed/` (incl. `csrc/`), `pkg/waveobj/jarvisconvo.go`, `pkg/wstore/wstore_jarvisconversation.go`, `pkg/wstore/wstore_jarvisconversation_test.go`
- Create: `db/migrations-wstore/000020_drop_jarvisconversation.up.sql`, `000020_drop_jarvisconversation.down.sql`, `pkg/wstore/wstore_dropjarvisconversation_test.go`, `pkg/wconfig/retiredkeys_test.go`
- Modify: `pkg/waveobj/wtype.go`, `pkg/wshrpc/wshrpctypes_jarvis.go`, `pkg/wshrpc/wshrpctypes_agentsync.go`, `pkg/wshrpc/wshserver/wshserver_jarvis.go`, `wshserver_jarvispet.go` (+ test), `wshserver_runs.go`, `wshserver_agentsync.go`, other `wshserver_*_test.go` that reference removed code, `pkg/jarvisstate/fetch.go` (+ test), `pkg/wconfig/settingsconfig.go`, `pkg/consult/openrouter.go`, `cmd/wsh/cmd/wshcmd-jarvisstatus.go` (+ test), `Taskfile.yml`, `AGENTS.md`
- Regenerated: `task generate` outputs

**Interfaces:**
- Consumes: Tasks 2, 3, 5 — nothing outside the three packages imports them, no frontend code references the removed wire types.
- Produces: the final tree; `go test ./pkg/...` builds with no include flag.

- [ ] **Step 1: Delete the proactive dispatch hook**

In `wshserver_runs.go` delete `proactiveAsync`, `proactiveDispatchTimeout`, `writeProactive`, and replace the `proactiveAsync(func() { … })` block in `CreateRun` with:

```go
	// detached: the volunteer judge is a headless CLI process
	jarvisvolunteer.EvaluateAsync(jarvisvolunteer.Trigger{
		Kind: jarvisvolunteer.TriggerRunCreated, ChannelID: data.ChannelId, RunID: run.ID,
	})
```

Drop the `jarvisproactive` import and any test that swaps `proactiveAsync`.

- [ ] **Step 2: Delete the handlers**

- `wshserver_jarvis.go`: delete `JarvisConverseCommand`, `ListJarvisConversationsCommand`, `JarvisAskCommand`, `jarvisAskScope`, and helpers only they call (`firstLine` if unused); drop the `jarvisrecall` import.
- `wshserver_jarvispet.go`: delete `GetEmbedIndexStatusCommand`, `reconcileRunning`, `tryStartReconcile`, `finishReconcile`, `EmbedReconcileCommand`, `ListProactiveRefusalsCommand`, `buildProactiveRefusals`; keep `GetLatestResumeCommand`, `buildLatestResume`, `resumeRank`. Delete their tests in `wshserver_jarvispet_test.go`.
- `wshserver_agentsync.go`: delete `AgentSyncSteeringReadCommand`, `AgentSyncSteeringWriteCommand`, `AgentSyncHarnessReadCommand`, `AgentSyncHarnessWriteCommand`, `AgentSyncSkillsCommand`.

- [ ] **Step 3: Delete the RPC declarations and wire types**

- `wshrpctypes_jarvis.go`: delete the interface lines for `JarvisConverseCommand`, `ListJarvisConversationsCommand`, `GetEmbedIndexStatusCommand`, `EmbedReconcileCommand`, `JarvisAskCommand`, `ListProactiveRefusalsCommand`, and their types (`CommandJarvisConverseData`, `JarvisConverseChunk`, `JarvisConversationSummary`, `CommandListJarvisConversationsRtnData`, `EmbedIndexStatus`, `CommandJarvisAskData`, `CommandJarvisAskRtnData`, `CommandListProactiveRefusalsData`, `CommandListProactiveRefusalsRtnData` and any type only they embed, such as the wire grounding card). In `CaptureStatus` delete `IndexAvailable` and `IndexError`.
- `wshrpctypes_agentsync.go`: delete the five interface lines and their `Command*` types.

- [ ] **Step 4: Status line**

`pkg/jarvisstate/fetch.go`: delete the `jarvisembed.OpenIndex` block in `FetchCaptureStatus` and the import. In `pkg/jarvis/effortops.go` the header's second paragraph explains itself by `jarvisstate` importing `jarvisembed`; rewrite it to `It lives here rather than in jarvisstate because both the engine and the wsh CLI reach it; wsh builds with CGO_ENABLED=0, so keep this file's imports to waveobj, wshrpc and the standard library.` `cmd/wsh/cmd/wshcmd-jarvisstatus.go` `renderCaptureStatus`: delete the `embedding index:` block. In `wshcmd-jarvisstatus_test.go` drop `IndexAvailable: true` from the fixture and add:

```go
	if strings.Contains(out, "embedding index") {
		t.Fatalf("status still reports the retired embedding index:\n%s", out)
	}
```

(use the rendered-output variable name the existing test already has).

- [ ] **Step 5: Delete the packages and the object type**

`git rm -r pkg/jarvisproactive pkg/jarvisrecall pkg/jarvisembed pkg/waveobj/jarvisconvo.go pkg/wstore/wstore_jarvisconversation.go pkg/wstore/wstore_jarvisconversation_test.go`. In `pkg/waveobj/wtype.go` delete `OType_JarvisConversation` and its entry in the valid-otypes map, and remove the `JarvisConvo` registration wherever `waveobj` registers types.

- [ ] **Step 6: Migration — failing test, then the files**

Create `pkg/wstore/wstore_dropjarvisconversation_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"os"
	"strings"
	"testing"
)

// A profile upgraded from a build with Ask carries db_jarvisconversation; TestMain ran every migration, so
// 000020 must have removed it, and its down file must restore exactly 000015's table.
func TestJarvisConversationTableDropped(t *testing.T) {
	got, err := WithReadTxRtn(context.Background(), func(tx *TxWrap) (string, error) {
		return tx.GetString("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'db_jarvisconversation'"), nil
	})
	if err != nil {
		t.Fatalf("query sqlite_master: %v", err)
	}
	if got != "" {
		t.Fatalf("db_jarvisconversation still present after migrations")
	}
	down, err := os.ReadFile("../../db/migrations-wstore/000020_drop_jarvisconversation.down.sql")
	if err != nil {
		t.Fatalf("read down migration: %v", err)
	}
	if !strings.Contains(string(down), "CREATE TABLE IF NOT EXISTS db_jarvisconversation") {
		t.Fatalf("down migration does not recreate db_jarvisconversation:\n%s", down)
	}
}
```

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/wstore/ -run TestJarvisConversationTableDropped` — Expected: FAIL.

Create `db/migrations-wstore/000020_drop_jarvisconversation.up.sql`:

```sql
DROP TABLE IF EXISTS db_jarvisconversation;
```

Create `db/migrations-wstore/000020_drop_jarvisconversation.down.sql`:

```sql
CREATE TABLE IF NOT EXISTS db_jarvisconversation (
    oid varchar(36) PRIMARY KEY,
    version int NOT NULL,
    data json NOT NULL
);
```

Re-run: PASS.

- [ ] **Step 7: Config keys and the OpenRouter comment**

Delete `JarvisEmbedEnabled`, `JarvisEmbedBaseURL`, `JarvisEmbedModel` from `SettingsType` in `settingsconfig.go`. In `pkg/consult/openrouter.go` put above `openRouterSecretName`:

```go
	// named for the embedding lane that first stored it (retired 2026-09-23); kept because renaming it
	// would orphan every key already stored. Settings → Headless AI writes it.
```

- [ ] **Step 8: Old settings still load — test**

Create `pkg/wconfig/retiredkeys_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wconfig

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// A settings.json written before the embedding lane was retired still carries its three keys; loading it
// must neither fail nor lose the OpenRouter values beside them.
func TestRetiredEmbedKeysStillLoad(t *testing.T) {
	part := waveobj.MetaMapType{
		"jarvis:embedenabled":          true,
		"jarvis:embedbaseurl":          "https://openrouter.ai/api/v1",
		"jarvis:embedmodel":            "openai/text-embedding-3-small",
		"headless:openroutercheapmodel": "deepseek/deepseek-v4-flash",
	}
	var s SettingsType
	if err := utilfn.ReUnmarshal(&s, part); err != nil {
		t.Fatalf("settings with retired keys failed to load: %v", err)
	}
	if s.HeadlessOpenRouterCheapModel != "deepseek/deepseek-v4-flash" {
		t.Fatalf("cheap model = %q, want deepseek/deepseek-v4-flash", s.HeadlessOpenRouterCheapModel)
	}
}
```

- [ ] **Step 9: Regenerate**

Run: `task generate`
Then: `git grep -nE "jarvis:embed|JarvisEmbed|EmbedIndexStatus|JarvisAsk|JarvisConverse|ListJarvisConversations|ListProactiveRefusals|EmbedReconcile|AgentSyncSteering|AgentSyncHarness|AgentSyncSkills|jarvisconversation" -- frontend/types frontend/app/store pkg/wshrpc/wshclient pkg/wconfig schema`
Expected: no output.

- [ ] **Step 10: Build flags and AGENTS.md**

In `Taskfile.yml` `build:server:internal`, change `CGO_CFLAGS="-O2 -g -I{{.ROOT_DIR}}/pkg/jarvisembed/csrc"` to `CGO_CFLAGS="-O2 -g"`. In `AGENTS.md` delete the Gotchas bullet that starts "**Bare `go test ./pkg/...` fails to *build*" (with its PowerShell block), and in the Design docs plan-format paragraph change "which run in a POSIX shell (Git Bash on Windows, so this repo's CGO header is `CGO_CFLAGS=…` go test ./pkg/...`)" to "which run in a POSIX shell (Git Bash on Windows)".

- [ ] **Step 11: Verify — with no include flag**

Run: `go test ./pkg/... ./cmd/...` (no `CGO_CFLAGS`)
Expected: PASS — this is the proof the sqlite-vec header is gone.

Run: `go vet ./pkg/... ./cmd/... && npx vitest run && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: PASS.

Run: `git grep -nE "jarvisembed|jarvisproactive|jarvisrecall|JarvisAsk|JarvisConverse|ListJarvisConversations|GetEmbedIndexStatus|EmbedReconcile|ListProactiveRefusals|jarvis:embed|wave_vault_ask|AskJarvisButton" -- ':!docs' ':!db/migrations-wstore/000015_*'`
Expected: no output.

Run: `gofmt -l` on the Go files you touched. Expected: none listed.

- [ ] **Step 12: Commit**

```bash
git add -A pkg cmd db frontend/types frontend/app/store schema Taskfile.yml AGENTS.md
git commit -m "refactor(jarvis): delete the recall arm's packages, RPCs and conversation table"
```
