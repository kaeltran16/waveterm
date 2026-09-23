# Retire the Jarvis recall arm — proactive cards, the Ask surface, and the embedding index

Initiative: `effort:a0d245f5-64bf-42c5-aad7-049cb57b1d89`.

## Why

The recall arm is three things that share one corpus: proactive "related prior work" cards on dispatch,
the Ask surface (the Brief's ask thread, `wsh jarvis ask`, pi's `wave_vault_ask`), and the embedding
index (`jarvisembed`) both of them rank with. The memory corpus they were built to search was deleted
on 2026-09-22 (`docs/deferred.md`, "memory corpus deletion"); what is left for them to read is 130
task notes and 4 decisions.

Measured 2026-09-23, against the packaged profile (`%LOCALAPPDATA%\dev.arc.app`) and the agent
transcripts:

- **Proactive.** 89 runs carry an evaluation: 14 `hit`, 35 `none`, 39 never evaluated, 1 stuck
  `pending`. The hits' `why` was boilerplate in all 14; one was the real thing (`docs/deferred.md`).
- **Ask, agent side.** 22 `wave_vault_ask` calls across the pi sessions (last 2026-09-18). ~14 returned
  "Not found" / "the sources do not contain", one returned empty, one answered a waveterm question with
  a SIEM ticket. The rest were questions a grep of `docs/` answers better. All of this was with the
  870-note corpus still present.
- **Ask, human side.** 6 persisted conversations, the newest 2026-08-19. The Brief's current ask
  (`JarvisAskCommand`) is stateless and leaves no record, so human use beyond that is unmeasured.
- **Embeddings.** The attribution corpus probe (`pkg/jarvisattrib/liveprobe_test.go`, run against a
  `VACUUM INTO` snapshot): 130 dossiers, 352 edges, **layer 1: 131, layer 3: 221, layer 4 (semantic): 0**.
  L4 runs only for a dossier with no deterministic edge, and there is none. Once proactive and recall go,
  the index's only remaining readers are status displays.

The replacement "different system" (`docs/deferred.md`) is designed later and fresh; nothing here is
kept as scaffolding for it.

## Decisions

1. **The Brief composer becomes steer-only.** Its one surviving audience is `worker` — messaging the
   live lead of the session open in the sheet. With no such lead, the composer is not rendered. The
   `brief` (ask across all work) and `initiative` (ask scoped to an effort) audiences are removed.
2. **`jarvisembed` goes with the arm**, including L4 semantic attribution and the vendored
   `pkg/jarvisembed/csrc` header. Attribution keeps layers 1–3.
3. **OpenRouter stays.** It is the default headless runtime (`headless:runtime` unset) behind classify,
   decompose, the resume narrative, the volunteer judge, pi titles, radar synthesis and the fleet
   summary. Its API key lives in the secret `jarvis_embedapikey` (`pkg/consult/openrouter.go`), and the
   Settings **Embeddings** section is the only UI that sets it. The key field moves into the
   **Headless AI** section; the secret name is kept (renaming it would orphan the stored key) with a
   comment saying why it is named for embeddings.
4. **Kept:** `jarviscontinuity` (the resume narrative and the pet's launch event, `GetLatestResume`),
   `jarvisstate` (the ledger), dossiers and attribution L1–L3, and `jarvisvolunteer`'s ledger,
   connection and loose-end producers.
5. **User data is never touched by code.** The dropped table goes through a migration; the index file
   and the dead settings keys are listed for manual cleanup.

## Backend (Go)

**Delete whole packages**

| Package | Why nothing survives |
|---|---|
| `pkg/jarvisproactive` | the proactive gate, judge, suggestion model and refusal log |
| `pkg/jarvisrecall` | its only external caller is Ask/Converse in `wshserver_jarvis.go`; `cards.go`/`retrieve.go`/`judge.go` serve only those |
| `pkg/jarvisembed` | no reader left after the two above and L4 |

**Surgical edits**

- `pkg/wshrpc/wshserver/wshserver_runs.go` — delete `writeProactive` and the dispatch-time
  `EvaluateDispatch` goroutine. The `jarvisvolunteer.EvaluateAsync` calls stay.
- `pkg/jarvisvolunteer/recall.go` (+ `recall_test.go`) — delete the recall producer and its
  registration; the package no longer imports `jarvisproactive`.
- `pkg/jarvisattrib/semantic.go` (+ `semantic_test.go`) — delete. In `lifecycle.go`,
  `edgesForDossier` returns the deterministic edges (overrides applied) and `shouldProposeSemantic`
  goes. `weightLayer4` and any L4 bucket/probation branch go; `liveprobe_test.go` drops its
  `jarvisembed.Available()` line.
- `pkg/jarvisstate/fetch.go` — `FetchCaptureStatus` stops opening the index;
  `wshrpc.CaptureStatus.IndexAvailable` / `IndexError` are removed and `wsh jarvis status` stops
  printing the "embedding index" line.
- `pkg/wshrpc/wshserver/wshserver_jarvispet.go` — delete `GetEmbedIndexStatusCommand`,
  `EmbedReconcileCommand`, `ListProactiveRefusalsCommand`. `GetLatestResumeCommand` stays.
- `pkg/wshrpc/wshserver/wshserver_jarvis.go` — delete `JarvisConverseCommand`,
  `ListJarvisConversationsCommand`, `JarvisAskCommand`, `jarvisAskScope`.

**RPC surface** — removed from `wshrpctypes_jarvis.go` with their data types: `JarvisConverse`,
`ListJarvisConversations`, `JarvisAsk`, `GetEmbedIndexStatus` (+ `EmbedIndexStatus`), `EmbedReconcile`,
`ListProactiveRefusals`. Then `task generate`.

**Object type and migration** — remove the `JarvisConversation` waveobj type and its registration. Add
`db/migrations-wstore/000020_drop_jarvisconversation.up.sql` (`DROP TABLE IF EXISTS
db_jarvisconversation;`) and a `.down.sql` that recreates it with 000015's DDL. 000015 itself stays —
the migration sequence is history.

**Config** — remove `jarvis:embedenabled`, `jarvis:embedbaseurl`, `jarvis:embedmodel` from
`SettingsType` (and the generated `metaconsts.go` / schema via `task generate`).

**CLI and pi** — delete `cmd/wsh/cmd/wshcmd-jarvisask.go` (+ test). Delete the `wave_vault_ask` tool from
`pi/extensions/waveterm-tools-core.ts` (+ its test cases); `task sync:piartifacts` refreshes the copy
under `cmd/wsh/cmd/`.

**Build** — drop `-I{{.ROOT_DIR}}/pkg/jarvisembed/csrc` from `CGO_CFLAGS` in `Taskfile.yml`
(`build:server:internal`). `CGO_ENABLED=1` stays (`go-sqlite3`). Remove the AGENTS.md gotcha about bare
`go test ./pkg/...` failing on `sqlite3.h`, and the Git Bash `CGO_CFLAGS` note in its plan-format
paragraph.

**Memvault leftovers** (tracker chunk 6)

- `pkg/memroots`: delete `AllRoots`, `buildAllRoots`, `Mirrors`, `buildMirrors` and the `Mirror` type
  (no user outside the package); keep `MemoryRoot` (used by `migrate.go`) and `SteeringDocPath`.
- The five callerless agentsync RPCs: `AgentSyncSteeringRead`, `AgentSyncSteeringWrite`,
  `AgentSyncHarnessRead`, `AgentSyncHarnessWrite`, `AgentSyncSkills` — from `wshrpctypes_agentsync.go`
  and `wshserver_agentsync.go`. Every `pkg/agentsync` function stays. The deferral's blocking branches:
  `backlog-cleanup` and `worktree-dag-interaction` are merged into main; `feat/surface-integration` is
  1 commit ahead (2026-09-17) and already conflicts with the Vault removal, so it no longer blocks.

## Frontend

**Composer** — `briefcomposertarget.ts`: `BriefComposerTarget` is the `worker` shape only and
`resolveBriefComposerTarget` returns `BriefComposerTarget | null`. `briefsurface.tsx` renders no
composer on `null`. The Brief's composer-focus keybinding does nothing while no composer is rendered.

**Thread cascade — delete**

- `briefingstore.ts`: `briefThreadAtom`, `askBriefThread`, `askAcrossWork`, `askAcrossWorkAsync`,
  `hydrateBriefThread`, `briefingAnswerFromTurn`, `primeBriefThread`, `clearBriefThread`,
  `briefingAnswerAtom`, `briefingAskStateAtom` and the brief-scope atoms that only the thread reads.
- `jarvisstore.ts`: the conversation half — `conversationsByIdAtom`, `persistedSummariesAtom`,
  `activeConversationIdAtom`, `summaryToRailConversation`, `rehydrateSourceMap`,
  `loadJarvisConversations`, `getConversation`, `setConversation`, `pruneEmptyConversation`,
  `startConversation`, `selectConversation`, `submitJarvisQuery`. The sheet/peek/graph atoms at the top
  stay.
- `briefdrew.ts`, `briefturn.ts`, `SourceChip`, and whatever of `jarviscontract.ts`,
  `jarvisturnderive.ts`, `recallderive.ts`, `mentions.ts` is left with no importer (each + its test).
- `cockpit/command-palette.tsx`: the "Ask Jarvis" group (`buildAskItems`, `askDeps`);
  `cockpit/palette-entities.ts`: conversation rows. `openref.ts` / `uiclient.ts` / `jarvissubjectstore.ts`
  drop any conversation target kind.
- `contextualentry.tsx` — the whole file: `AskJarvisButton`, `openJarvisWithSource`,
  `suggestedPrompt`, `attachedScope`, `sourceRefFor*`. Its four entry points go with it: the button's
  three mounts (`runbody.tsx`, `runcompletionsurface.tsx`, `radarfindingdetail.tsx`) and the graph
  peek's "ask about this node" action (`graphpeek.tsx` `onAskAbout`, wired in `briefsurface.tsx`).
- `briefcompose.ts`: `resolveComposerLabels` keeps only the worker labels.
- `agents/proactive.ts`, `agents/proactiveviews.tsx` (+ test).
- `linkingdevhooks.ts`: thread/grounding hooks.

**Pet** — delete `petindex.ts`, `actsForRecall` (`petacts.ts`), `indexSignal` / `recallLine`
(`petjoin.ts`), `petIndexAtom` (`petstore.ts`), the index field of `petpeekmodel.ts`, and the
embeddings deep-link act. The pet's per-source **Ask** act (`actsForEvent` → `askAboutSource`) is an
Ask entry point too and goes; each source keeps its Open act. `eventFromResume` and
`loadLaunchNarrative` stay.

**Settings** — `settingsmodel.ts` / `settingssurface.tsx`: delete the Embeddings section
(`SECTION_EMBEDDINGS`, `EmbeddingsSection`, the three `jarvis:embed*` rows). Headless AI gains the API
key field (set / replace / clear against the same secret), and its "key not set" note stops pointing at
Embeddings. Rename `EMBED_SECRET_NAME` to `OPENROUTER_SECRET_NAME`, value unchanged.

## Docs

- `docs/deferred.md` — one entry recording the retirement: the evidence above, and the recovery
  commands (`git show <removal-commit>^:pkg/jarvisrecall/ask.go`, etc. — the merge commit hash is filled
  at merge). Close the "five agentsync RPCs" and "still orphaned" entries.
- `docs/open-issues.md` — close the "Ask-mode consult results" and "Resume / proactive cards" rows.
- `docs/agents/` — drop `wsh jarvis ask` if documented there.
- Tracker: advance the chunks the merge satisfies.

**Manual cleanup on the user's machine (not done by code)** — delete
`%LOCALAPPDATA%\dev.arc.app\data\jarvis\index.db` (and the dev profile's), the three `jarvis:embed*`
lines in `settings.json`, and the four inert memvault state files in `data\`
(`memgarden-state.json`, `memory-distill-queue.json`, `memory-decay-restore-done.txt`,
`memory-recall-epoch.txt`).

## Verification

- `go test ./pkg/... ./cmd/...` **without** a `CGO_CFLAGS` include — passing is itself the proof the
  sqlite-vec header is gone.
- `npx vitest run` and `task check:ts`.
- `go vet ./pkg/... ./cmd/...`.
- Reference sweep returns nothing outside `docs/` history and `db/migrations-wstore/000015_*`:
  `jarvisembed|jarvisproactive|jarvisrecall|JarvisAsk|JarvisConverse|ListJarvisConversations|GetEmbedIndexStatus|EmbedReconcile|ListProactiveRefusals|jarvis:embed|wave_vault_ask|AskJarvisButton`.
- CDP (`scripts/cdp/scenarios.mjs`): delete `jarvis-ask`, `jarvis-multiturn`, `jarvis-vault-recall` and
  the `askBrief` helper; rework `resource-linking` and `brief-contextual-map` to reach their subjects
  without asking; add `brief-composer-steer-only` — no `[data-jarvis-brief-composer]` with the sheet
  closed, present with a live session's sheet open. Run on the merged result.

## Out of scope

- `jarviscontinuity` and the orphaned `ResumeCard` / `resumeviews.tsx` (a separate dead-code pass).
- `pkg/consult` and the OpenRouter runtime beyond the settings move.
- The replacement recall system.
