# Orchestrator Fast Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a structured, editable one-to-eight-task DAG before any Run exists, make valid drafts launchable after a fast exception-first review, and preserve the existing deferred CreateRun → DagSubmit → optional cancel transaction.

**Architecture:** A dedicated `JarvisPlanDagCommand` validates the proposed Run route, resolves the channel's effective Jarvis principles, derives installed task-route pins from the same backend capability projection as `ListHarnessesCommand`, and calls a strict mid-tier planner under `pkg/jarvis`. The frontend converts that response once into the sole immutable `DagDraft`, derives Summary and Graph views without persistence, and lets the modal reducer own planning identity, dirty state, drawer selection, retry, and launch transitions. Only the explicit Launch action creates a deferred orchestrator Run and submits the exact validated draft.

**Tech Stack:** Go (`consult`, `harness`, `jarvis`, `runroute`, `waveobj`, `wshrpc`, `wstore`), React 19, TypeScript, jotai, Tailwind 4, `motion/react`, `@xyflow/react`, Vitest, Go tests, generated Go/TypeScript RPC bindings, and the existing CDP UI harness.

## Global Constraints

- Read `docs/superpowers/specs/2026-08-21-orchestrator-fast-approval-design.md`, `docs/superpowers/specs/2026-08-20-route-chain-and-dag-modal-design.md`, and `DESIGN.md` before changing code.
- Start from current `main` (`8f38f55c` when this plan was written). Preserve the shipped route authority, deferred Run lifecycle, immutable draft primitives, Stage-local modal, and persisted live DAG.
- Do not execute unfinished Tasks 10–12 from `docs/superpowers/plans/2026-08-20-route-chain-and-dag-modal.md` verbatim. This plan supersedes that unfinished draft-review work.
- A generated or edited draft contains **one to eight tasks**. Draft parallelism is an integer from **one through eight**.
- Structured DAG planning always uses `consult.HeadlessSpecForTier(consult.TierMid)` and is independent of the proposed Run route.
- `JarvisDecomposeCommand`, `jarvis.Decompose`, and `ParseDecompose` retain their independent parallel-subtask contract and cheap-tier behavior.
- Invalid command input is an RPC error. Model lookup failure, execution failure, timeout, or structurally invalid planner output is a bounded server-produced fallback. Frontend transport failure remains an error and never becomes fallback success.
- Planner warnings, fallback status, valid gates, and valid task route pins never disable Launch. Only deterministic draft validation errors disable it.
- No planning, Summary, drawer, Graph, or Retry action may create or persist a Run, TaskGroup, worker, or WOS object. Launch is the only creation boundary.
- CreateRun uses the request's explicit runtime and tier with `mode: "orchestrator"` and `deferstart: true`; DagSubmit receives exactly `toDagSubmitPayload(draft)`.
- No new dependency, runtime/model matrix, SCSS, raw component color, persisted draft, draggable graph node, or edge-drawing interaction.
- Use Tailwind token utilities, existing motion tokens, semantic buttons, visible `focus-visible` treatment, `aria-live` validation output, and status text/icon in addition to color.
- UI implementation begins with `docs/prototype/orchestrator-fast-approval.html`, copied from `docs/prototype/mockup-template.html`, audited against its checklist, served locally, and approved before React markup is written.
- Keep pure logic in `.ts` files with colocated Vitest tests. Do not add jsdom render or snapshot tests.
- After changing `wshrpc` types, run `task generate`; never hand-edit `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, or `frontend/types/gotypes.d.ts`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`; plain `npx tsc` stack-overflows in this repository.
- For `pkg/wshrpc/wshserver` tests, use `CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc"` when sqlite-vec headers are required.
- One writer executes tasks serially. Do not parallelize edits to this checkout.
- Project Git policy overrides the generic frequent-commit template: checkpoint each task without committing. At the end, show M/A/D files, a brief summary, and the proposed commit message, then ask explicit approval before one final commit. Never push.
- The untracked design spec and this plan ship with the feature code, not in a docs-only commit.

---

### Task 1: Add the strict mid-tier DAG planner core

**Files:**
- Create: `pkg/jarvis/plandag.go`
- Create: `pkg/jarvis/plandag_test.go`
- Regression test: `pkg/jarvis/decompose_test.go`
- Regression test: `pkg/jarvis/tier_test.go`

**Interfaces:**
- Consumes: shared `runFn`, `consult.HeadlessSpecForTier`, `consult.TierMid`, `RenderPrinciples`, `waveobj.RoutePin`, channel name, project path, and resolved principles.
- Produces:

  ```go
  var ErrDagPlanModelUnavailable = errors.New("dag planner model unavailable")
  var ErrInvalidDagPlan = errors.New("invalid dag plan")

  type DagPlanInput struct {
      Goal          string
      ChannelName   string
      Principles    waveobj.PrincipleList
      RunRoute      waveobj.RoutePin
      AllowedRoutes []waveobj.RoutePin
  }

  type DagPlanDraft struct {
      Title string
      Tasks []DagPlanTask
  }

  type DagPlanTask struct {
      ID          string
      Label       string
      Description string
      Deps        []string
      Gate        bool
      Route       *waveobj.RoutePin
  }

  func BuildPlanDagPrompt(input DagPlanInput) string
  func ParsePlanDag(reply string, input DagPlanInput) (DagPlanDraft, []string, error)
  func PlanDag(ctx context.Context, projectPath string, input DagPlanInput) (DagPlanDraft, []string, error)
  func FallbackDagPlan(goal string, cause error) (DagPlanDraft, []string)
  ```

- `ParsePlanDag` returns warnings only for invalid task route suggestions. Every structural failure wraps `ErrInvalidDagPlan` and returns no partial draft.
- `FallbackDagPlan` returns `Title: goal`, one task `{ID:"t-1", Label:goal}`, and exactly one bounded warning selected from model-unavailable, timeout, invalid-plan, or generic execution failure.

- [x] **Step 1: Write prompt and tier-selection tests.** Add tests that capture the runner input without shelling out:

  ```go
  func TestBuildPlanDagPromptIncludesAuthorityAndSchema(t *testing.T) {
      input := DagPlanInput{
          Goal:        "ship fast approval",
          ChannelName: "waveterm",
          Principles:  waveobj.PrincipleList{{ID: "simple", Text: "prefer the smallest safe change"}},
          RunRoute:    waveobj.RoutePin{Runtime: "claude", Tier: "mid"},
          AllowedRoutes: []waveobj.RoutePin{
              {Runtime: "pi", Tier: "cheap"},
              {Runtime: "claude", Tier: "mid"},
          },
      }
      prompt := BuildPlanDagPrompt(input)
      for _, want := range []string{
          "ship fast approval", "waveterm", "prefer the smallest safe change",
          `"runtime":"claude"`, `"tier":"mid"`, `"runtime":"pi"`,
          "one to eight", "inherit the Run route", `"description"`, `"deps"`, `"gate"`, `"route"`,
      } {
          if !strings.Contains(prompt, want) {
              t.Fatalf("prompt missing %q:\n%s", want, prompt)
          }
      }
  }

  func TestPlanDagUsesMidTier(t *testing.T) {
      oldSpec := planDagSpec
      oldRun := runFn
      t.Cleanup(func() { planDagSpec, runFn = oldSpec, oldRun })
      var gotTier consult.Tier
      planDagSpec = func(tier consult.Tier) (consult.RuntimeSpec, bool) {
          gotTier = tier
          return consult.RuntimeSpec{}, true
      }
      runFn = func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error) {
          return `{"title":"ship","tasks":[{"id":"a","label":"build"}]}`, nil
      }
      _, _, err := PlanDag(context.Background(), ".", DagPlanInput{Goal: "ship"})
      if err != nil || gotTier != consult.TierMid {
          t.Fatalf("tier=%q err=%v", gotTier, err)
      }
  }
  ```

- [x] **Step 2: Write valid parse and route-repair tests.** Use a proposed Claude/mid route and allowed Pi/cheap + Claude/mid pins. Assert descriptions, gates, canonical IDs, rewritten dependencies, and dependency deduplication:

  ```go
  func TestParsePlanDagCanonicalizesAValidPlan(t *testing.T) {
      input := DagPlanInput{
          Goal: "ship",
          RunRoute: waveobj.RoutePin{Runtime: "claude", Tier: "mid"},
          AllowedRoutes: []waveobj.RoutePin{
              {Runtime: "claude", Tier: "mid"},
              {Runtime: "pi", Tier: "cheap"},
          },
      }
      raw := `{"title":" Release ","tasks":[` +
          `{"id":"plan","label":" Plan ","description":" Decide seams ","gate":true},` +
          `{"id":"build","label":"Build","deps":["plan","plan"],"route":{"runtime":"pi","tier":"cheap"}}]}`
      draft, warnings, err := ParsePlanDag(raw, input)
      if err != nil { t.Fatal(err) }
      if len(warnings) != 0 || draft.Title != "Release" { t.Fatalf("draft=%+v warnings=%v", draft, warnings) }
      if draft.Tasks[0].ID != "t-1" || draft.Tasks[0].Description != "Decide seams" || !draft.Tasks[0].Gate {
          t.Fatalf("first task=%+v", draft.Tasks[0])
      }
      if !reflect.DeepEqual(draft.Tasks[1].Deps, []string{"t-1"}) || draft.Tasks[1].Route == nil || draft.Tasks[1].Route.Runtime != "pi" {
          t.Fatalf("second task=%+v", draft.Tasks[1])
      }
  }
  ```

  Add the two focused route cases with exact assertions:

  ```go
  func TestParsePlanDagClearsRedundantRouteSilently(t *testing.T) {
      route := waveobj.RoutePin{Runtime: "claude", Tier: "mid"}
      input := DagPlanInput{Goal: "ship", RunRoute: route, AllowedRoutes: []waveobj.RoutePin{route}}
      draft, warnings, err := ParsePlanDag(
          `{"tasks":[{"id":"a","label":"Build","route":{"runtime":"claude","tier":"mid"}}]}`,
          input,
      )
      if err != nil || draft.Tasks[0].Route != nil || len(warnings) != 0 {
          t.Fatalf("draft=%+v warnings=%v err=%v", draft, warnings, err)
      }
  }

  func TestParsePlanDagClearsInvalidRouteWithTaskWarning(t *testing.T) {
      input := DagPlanInput{
          Goal: "ship",
          RunRoute: waveobj.RoutePin{Runtime: "claude", Tier: "mid"},
          AllowedRoutes: []waveobj.RoutePin{{Runtime: "claude", Tier: "mid"}},
      }
      draft, warnings, err := ParsePlanDag(
          `{"tasks":[{"id":"a","label":"Build","route":{"runtime":"pi","tier":"cheap"}}]}`,
          input,
      )
      if err != nil || draft.Tasks[0].Route != nil || len(warnings) != 1 || !strings.Contains(warnings[0], "t-1") {
          t.Fatalf("draft=%+v warnings=%v err=%v", draft, warnings, err)
      }
  }
  ```

- [x] **Step 3: Write the complete structural-invalid table.** The table must cover malformed JSON, surrounding prose, zero tasks, nine tasks, duplicate IDs, blank IDs, blank labels, unknown dependency, self-dependency, and a cycle:

  ```go
  func TestParsePlanDagRejectsStructuralErrors(t *testing.T) {
      nine := make([]string, 9)
      for i := range nine {
          nine[i] = fmt.Sprintf(`{"id":"%d","label":"task %d"}`, i, i)
      }
      cases := map[string]string{
          "malformed":      `{`,
          "surrounding prose": `plan: {"tasks":[{"id":"a","label":"A"}]}`,
          "zero tasks":     `{"tasks":[]}`,
          "nine tasks":     `{"tasks":[` + strings.Join(nine, ",") + `]}`,
          "duplicate ids":  `{"tasks":[{"id":"a","label":"A"},{"id":"a","label":"B"}]}`,
          "blank id":       `{"tasks":[{"id":" ","label":"A"}]}`,
          "blank label":    `{"tasks":[{"id":"a","label":" "}]}`,
          "unknown dep":    `{"tasks":[{"id":"a","label":"A","deps":["missing"]}]}`,
          "self dep":       `{"tasks":[{"id":"a","label":"A","deps":["a"]}]}`,
          "cycle":          `{"tasks":[{"id":"a","label":"A","deps":["b"]},{"id":"b","label":"B","deps":["a"]}]}`,
      }
      for name, raw := range cases {
          t.Run(name, func(t *testing.T) {
              _, _, err := ParsePlanDag(raw, DagPlanInput{Goal: "ship"})
              if !errors.Is(err, ErrInvalidDagPlan) { t.Fatalf("err=%v", err) }
          })
      }
  }
  ```

  Add the blank-title fallback assertion:

  ```go
  func TestParsePlanDagUsesGoalForBlankTitle(t *testing.T) {
      draft, _, err := ParsePlanDag(`{"title":" ","tasks":[{"id":"a","label":"Build"}]}`, DagPlanInput{Goal: "ship"})
      if err != nil || draft.Title != "ship" { t.Fatalf("draft=%+v err=%v", draft, err) }
  }
  ```

- [x] **Step 4: Write fallback and leakage tests.** Stub `planDagSpec` and `runFn` serially; do not use `t.Parallel` while swapping package globals. Cover lookup failure, arbitrary execution error, `context.DeadlineExceeded`, and invalid parser output. First pin the internal error classes:

  ```go
  func TestPlanDagReturnsClassifiedInternalFailures(t *testing.T) {
      oldSpec, oldRun := planDagSpec, runFn
      t.Cleanup(func() { planDagSpec, runFn = oldSpec, oldRun })
      input := DagPlanInput{Goal: "ship"}

      planDagSpec = func(consult.Tier) (consult.RuntimeSpec, bool) { return consult.RuntimeSpec{}, false }
      if _, _, err := PlanDag(context.Background(), ".", input); !errors.Is(err, ErrDagPlanModelUnavailable) { t.Fatalf("lookup err=%v", err) }

      planDagSpec = func(consult.Tier) (consult.RuntimeSpec, bool) { return consult.RuntimeSpec{}, true }
      runFn = func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error) {
          return "", errors.New("provider secret")
      }
      if _, _, err := PlanDag(context.Background(), ".", input); err == nil || errors.Is(err, ErrInvalidDagPlan) { t.Fatalf("execution err=%v", err) }

      runFn = func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error) {
          return "", context.DeadlineExceeded
      }
      if _, _, err := PlanDag(context.Background(), ".", input); !errors.Is(err, context.DeadlineExceeded) { t.Fatalf("timeout err=%v", err) }

      runFn = func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error) {
          return "SECRET_RAW_REPLY", nil
      }
      if _, _, err := PlanDag(context.Background(), ".", input); !errors.Is(err, ErrInvalidDagPlan) { t.Fatalf("parse err=%v", err) }
  }
  ```

  Then assert each user-facing fallback has one `t-1` task and that warnings contain none of `SECRET_RAW_REPLY`, `--api-key`, or the injected provider error:

  ```go
  func TestFallbackDagPlanIsBounded(t *testing.T) {
      causes := []error{
          ErrDagPlanModelUnavailable,
          context.DeadlineExceeded,
          fmt.Errorf("%w: SECRET_RAW_REPLY", ErrInvalidDagPlan),
          errors.New("provider failed with --api-key secret"),
      }
      for _, cause := range causes {
          draft, warnings := FallbackDagPlan("ship", cause)
          if len(draft.Tasks) != 1 || draft.Tasks[0].ID != "t-1" || draft.Tasks[0].Label != "ship" || len(warnings) != 1 {
              t.Fatalf("draft=%+v warnings=%v", draft, warnings)
          }
          joined := strings.Join(warnings, " ")
          for _, leaked := range []string{"SECRET_RAW_REPLY", "--api-key", "provider failed"} {
              if strings.Contains(joined, leaked) { t.Fatalf("warning leaked %q: %s", leaked, joined) }
          }
      }
  }
  ```

- [x] **Step 5: Run the tests and observe the intended failure.** Run:

  ```bash
  go test ./pkg/jarvis -run 'Test(BuildPlanDagPrompt|ParsePlanDag|PlanDag|FallbackDagPlan)'
  ```

  Expected: compile failure because `DagPlanInput`, planner functions, and planner seams do not exist.

- [x] **Step 6: Implement the focused planner.** In `plandag.go`:
  1. declare `const planDagTimeout = 120 * time.Second` and `var planDagSpec = consult.HeadlessSpecForTier`;
  2. marshal the proposed route, allowed pins, and a literal example schema into the prompt;
  3. trim the complete response and call `json.Unmarshal` on the whole string;
  4. validate one-to-eight tasks, unique nonblank raw IDs, nonblank trimmed labels, known dependencies, no self-dependency, and no cycles before repair;
  5. trim title/label/description, deduplicate dependencies while preserving first occurrence, canonicalize by array order, and rewrite dependencies through the raw-ID map;
  6. clear a route equal to `RunRoute`; preserve only exact allowed pins; clear every other route and append `Task t-N route runtime/tier is unavailable and now inherits the Run route.`;
  7. call `runFn` with a timeout context and the mid-tier spec;
  8. return internal wrapped errors to the RPC boundary and keep user warning selection inside `FallbackDagPlan`.

  Use these bounded warning strings exactly:

  ```go
  const (
      dagPlanWarningModelUnavailable = "Planner model is unavailable. Review the fallback task before launching."
      dagPlanWarningTimeout          = "Planner timed out. Review the fallback task before launching."
      dagPlanWarningInvalid          = "Planner returned an invalid plan. Review the fallback task before launching."
      dagPlanWarningExecution        = "Planner failed. Review the fallback task before launching."
  )
  ```

- [x] **Step 7: Verify planner and legacy decomposition.** Run:

  ```bash
  go test ./pkg/jarvis -run 'Test(BuildPlanDagPrompt|ParsePlanDag|PlanDag|FallbackDagPlan|ParseDecompose|DecomposeRunsOnTheCheapTier)'
  go test ./pkg/jarvis
  ```

  Expected: both commands pass; existing decompose behavior remains unchanged.

- [x] **Step 8: Checkpoint without committing.** Run `git diff --check` and `git status --short`. Confirm only the new planner files changed in this task.

---

### Task 2: Expose the planner through RPC and shared installed capabilities

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go:10-36,110-118`
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go:22-86,350-374`
- Create: `pkg/wshrpc/wshserver/wshserver_plandag_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_harness_test.go`
- Regenerate: `pkg/wshrpc/wshclient/wshclient.go`
- Regenerate: `frontend/app/store/wshclientapi.ts`
- Regenerate: `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: Task 1's `jarvis.PlanDag`, `jarvis.FallbackDagPlan`, `probeHarnesses`, `validateHarness`, `runroute.Resolve`, `jarvis.LoadGlobalProfile`, `jarvis.OverrideFromMeta`, and `jarvis.ResolveProfileWithDiagnostics`.
- Produces the spec's RPC types verbatim:

  ```go
  type CommandJarvisPlanDagData struct {
      ChannelId string           `json:"channelid"`
      Goal      string           `json:"goal"`
      Route     waveobj.RoutePin `json:"route"`
  }

  type DagPlanDraft struct {
      Title string        `json:"title"`
      Tasks []DagPlanTask `json:"tasks"`
  }

  type DagPlanTask struct {
      ID          string            `json:"id"`
      Label       string            `json:"label"`
      Description string            `json:"description,omitempty"`
      Deps        []string          `json:"deps,omitempty"`
      Gate        bool              `json:"gate,omitempty"`
      Route       *waveobj.RoutePin `json:"route,omitempty"`
  }

  type CommandJarvisPlanDagRtnData struct {
      Draft    DagPlanDraft `json:"draft"`
      Fallback bool         `json:"fallback,omitempty"`
      Warnings []string     `json:"warnings,omitempty"`
  }
  ```

- Also produces:

  ```go
  func installedRunWorkerPins(results []harness.ProbeResult) []waveobj.RoutePin
  func routeCapabilitiesForProbe(result harness.ProbeResult) []runroute.Capability
  func toRPCDagPlanDraft(draft jarvis.DagPlanDraft) wshrpc.DagPlanDraft
  ```

  Both the planner command and `ListHarnessesCommand` use these helpers; no second capability table is introduced.

- [x] **Step 1: Write command-boundary tests.** In `wshserver_plandag_test.go`, table-test blank channel ID, blank goal, unsupported route, unavailable proposed harness, and missing channel. Each case expects an RPC error and zero planner calls:

  ```go
  func TestJarvisPlanDagRejectsInvalidInput(t *testing.T) {
      oldPlan, oldValidate := planDag, validateHarness
      t.Cleanup(func() { planDag, validateHarness = oldPlan, oldValidate })
      calls := 0
      planDag = func(context.Context, string, jarvis.DagPlanInput) (jarvis.DagPlanDraft, []string, error) {
          calls++
          return jarvis.DagPlanDraft{}, nil, nil
      }
      validateHarness = func(string, harness.Operation) (harness.Spec, error) {
          return harness.Spec{}, errors.New("not installed")
      }
      ws := &WshServer{}
      cases := []wshrpc.CommandJarvisPlanDagData{
          {Goal: "ship", Route: waveobj.RoutePin{Runtime: "claude", Tier: "mid"}},
          {ChannelId: "channel", Goal: " ", Route: waveobj.RoutePin{Runtime: "claude", Tier: "mid"}},
          {ChannelId: "channel", Goal: "ship", Route: waveobj.RoutePin{Runtime: "codex", Tier: "mid"}},
      }
      for _, data := range cases {
          if _, err := ws.JarvisPlanDagCommand(context.Background(), data); err == nil { t.Fatalf("data=%+v", data) }
      }
      if calls != 0 { t.Fatalf("planner calls=%d", calls) }
  }
  ```

  Use a real temporary channel for the unavailable-harness case so route validation reaches `validateHarness`.

- [x] **Step 2: Write resolved-input and no-side-effect tests.** Create a channel with a name/project path and profile override principles. Stub `probeHarnesses`, `validateHarness`, and `planDag`; capture `DagPlanInput`. Assert:
  - goal, channel name, project path, resolved principles, and proposed Run route are exact;
  - allowed pins include only capabilities from installed run-worker probes;
  - the command returns the converted normal response;
  - the channel's Run count is unchanged before/after.

  ```go
  planDag = func(_ context.Context, projectPath string, input jarvis.DagPlanInput) (jarvis.DagPlanDraft, []string, error) {
      gotPath, gotInput = projectPath, input
      return jarvis.DagPlanDraft{Title: "ship", Tasks: []jarvis.DagPlanTask{{ID: "t-1", Label: "build"}}}, nil, nil
  }
  ```

- [x] **Step 3: Write fallback-boundary tests.** Make `planDag` return an internal error containing `SECRET_PROVIDER_OUTPUT`. Assert the command returns fallback success without leaking it:

  ```go
  validData := wshrpc.CommandJarvisPlanDagData{
      ChannelId: channel.OID,
      Goal: "ship",
      Route: waveobj.RoutePin{Runtime: "pi", Tier: "cheap"},
  }
  planDag = func(context.Context, string, jarvis.DagPlanInput) (jarvis.DagPlanDraft, []string, error) {
      return jarvis.DagPlanDraft{}, nil, errors.New("SECRET_PROVIDER_OUTPUT")
  }
  rtn, err := (&WshServer{}).JarvisPlanDagCommand(context.Background(), validData)
  if err != nil || !rtn.Fallback || len(rtn.Draft.Tasks) != 1 || rtn.Draft.Tasks[0].Label != validData.Goal {
      t.Fatalf("rtn=%+v err=%v", rtn, err)
  }
  if strings.Contains(strings.Join(rtn.Warnings, " "), "SECRET_PROVIDER_OUTPUT") {
      t.Fatalf("warnings leaked internal error: %v", rtn.Warnings)
  }
  ```

  Add the success return and exact warning assertion:

  ```go
  planDag = func(context.Context, string, jarvis.DagPlanInput) (jarvis.DagPlanDraft, []string, error) {
      return jarvis.DagPlanDraft{Title: "ship", Tasks: []jarvis.DagPlanTask{{ID: "t-1", Label: "Build"}}}, []string{"Task t-1 route pi/cheap is unavailable and now inherits the Run route."}, nil
  }
  rtn, err = (&WshServer{}).JarvisPlanDagCommand(context.Background(), validData)
  if err != nil || rtn.Fallback || !reflect.DeepEqual(rtn.Warnings, []string{"Task t-1 route pi/cheap is unavailable and now inherits the Run route."}) {
      t.Fatalf("rtn=%+v err=%v", rtn, err)
  }
  ```

- [x] **Step 4: Extend harness projection tests.** In `wshserver_harness_test.go`, call the shared helper with installed worker, unavailable worker, and installed non-worker probes:

  ```go
  pins := installedRunWorkerPins([]harness.ProbeResult{
      {Spec: harness.Spec{Runtime: "pi", RunWorkerCapable: true}, Installed: true},
      {Spec: harness.Spec{Runtime: "claude", RunWorkerCapable: true}, Installed: false},
      {Spec: harness.Spec{Runtime: "codex", RunWorkerCapable: false}, Installed: true},
  })
  want := []waveobj.RoutePin{
      {Runtime: "pi", Tier: "cheap"},
      {Runtime: "pi", Tier: "mid"},
      {Runtime: "pi", Tier: "capable"},
  }
  if !reflect.DeepEqual(pins, want) { t.Fatalf("pins=%+v want=%+v", pins, want) }
  ```

  Keep `ListHarnessesCommand` assertions proving it exposes the same three Pi capabilities.

- [x] **Step 5: Run tests and observe failure.** Run:

  ```bash
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver -run 'Test(JarvisPlanDag|ListHarnesses)'
  ```

  Expected: compile failure because the RPC types, command, planner seam, and shared capability helpers do not exist.

- [x] **Step 6: Add the RPC contract and handler.** Add the command to `JarvisCommands`. In `wshserver_jarvis.go`, add:

  ```go
  var planDag = jarvis.PlanDag
  ```

  Implement this boundary order exactly:

  ```go
  channelID := strings.TrimSpace(data.ChannelId)
  goal := strings.TrimSpace(data.Goal)
  if channelID == "" { return nil, fmt.Errorf("channelid is required") }
  if goal == "" { return nil, fmt.Errorf("goal is required") }
  capability, err := runroute.Resolve(data.Route)
  if err != nil { return nil, err }
  if _, err := validateHarness(capability.Runtime, harness.OperationRunWorker); err != nil { return nil, err }
  channel, err := wstore.DBMustGet[*waveobj.Channel](ctx, channelID)
  if err != nil { return nil, fmt.Errorf("loading channel: %w", err) }
  probes := probeHarnesses(ctx)
  global := jarvis.LoadGlobalProfile()
  override := jarvis.OverrideFromMeta(channel)
  resolved, _ := jarvis.ResolveProfileWithDiagnostics(global, override)
  ```

  Build `jarvis.DagPlanInput` with `resolved.Principles` and `installedRunWorkerPins(probes)`. On planner error, log full internal context with channel ID and the wrapped error, then convert `jarvis.FallbackDagPlan(goal, err)` to the RPC return with `Fallback: true`. Do not log raw model output separately.

- [x] **Step 7: Extract and reuse installed capability projection.** `routeCapabilitiesForProbe` returns nil unless `Installed && RunWorkerCapable`; otherwise it returns a copy of `runroute.Capabilities(runtime)`. `installedRunWorkerPins` flattens those values to runtime/tier pins in probe/catalog order. Change `ListHarnessesCommand` to convert the same helper's capabilities to `RouteCapabilityInfo`.

- [x] **Step 8: Generate bindings and inspect them.** Run:

  ```bash
  task generate
  git diff -- pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
  ```

  Expected generated additions: `JarvisPlanDagCommand`, `CommandJarvisPlanDagData`, `DagPlanDraft`, `DagPlanTask`, and `CommandJarvisPlanDagRtnData`; no unrelated generated contract drift.

- [x] **Step 9: Verify backend and type generation.** Run:

  ```bash
  go test ./pkg/jarvis
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver -run 'Test(JarvisPlanDag|ListHarnesses)'
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  ```

- [x] **Step 10: Checkpoint without committing.** Run `git diff --check` and `git status --short`. Confirm generated files were changed only by `task generate`.

---

### Task 3: Convert planner responses into the bounded immutable draft model

**Files:**
- Modify: `frontend/app/view/orchestrate/draftmodel.ts:1-158`
- Modify: `frontend/app/view/orchestrate/draftmodel.test.ts:1-145`

**Interfaces:**
- Consumes: generated `CommandJarvisPlanDagRtnData`, `RoutePin`, `HarnessInfo`, `TaskNode`, and existing `capabilityFor`.
- Produces:

  ```ts
  export const MAX_DRAFT_TASKS = 8;
  export const MAX_DRAFT_PARALLELISM = 8;

  export type DraftTask = {
      id: string;
      label: string;
      description: string;
      deps: string[];
      gate: boolean;
      route: RoutePin | null;
  };

  export function draftFromPlan(response: CommandJarvisPlanDagRtnData): DagDraft;
  export function setDraftDescription(draft: DagDraft, id: string, description: string): DagDraft;
  export function dependencyCandidates(draft: DagDraft, id: string): DraftTask[];
  ```

- Existing mutation names remain stable. Every rejected mutation returns the identical draft object. `toDagSubmitPayload` remains the sole frontend conversion to persisted `TaskNode` values.

- [x] **Step 1: Replace subtask-conversion tests with planner-response tests.** Assert one task defaults parallelism to one, two or more tasks default to two, and every field is copied:

  ```ts
  it("converts a planner response once without dropping proposal fields", () => {
      const response = {
          draft: {
              title: "Release",
              tasks: [
                  { id: "t-1", label: "Plan", description: "pin seams", deps: [], gate: true },
                  { id: "t-2", label: "Build", description: "ship code", deps: ["t-1"], route: { runtime: "pi", tier: "cheap" } },
              ],
          },
          fallback: false,
          warnings: [],
      } as CommandJarvisPlanDagRtnData;
      expect(draftFromPlan(response)).toEqual({
          title: "Release",
          parallelism: 2,
          tasks: [
              { id: "t-1", label: "Plan", description: "pin seams", deps: [], gate: true, route: null },
              { id: "t-2", label: "Build", description: "ship code", deps: ["t-1"], gate: false, route: { runtime: "pi", tier: "cheap" } },
          ],
      });
  });
  ```

- [x] **Step 2: Add immutable bounds and deletion tests.** Assert:

  ```ts
  const one = draftFromPlan({ draft: { title: "one", tasks: [{ id: "t-1", label: "one" }] } } as CommandJarvisPlanDagRtnData);
  expect(one.parallelism).toBe(1);
  expect(deleteDraftTask(one, "t-1")).toBe(one);

  let eight = one;
  for (let i = 2; i <= 8; i++) eight = addDraftTask(eight, `task ${i}`);
  expect(eight.tasks).toHaveLength(8);
  expect(addDraftTask(eight, "ninth")).toBe(eight);
  const maxed = setDraftParallelism(eight, 8);
  expect(maxed.parallelism).toBe(8);
  expect(setDraftParallelism(maxed, 9)).toBe(maxed);
  ```

  Keep frozen-input assertions for accepted mutations.

- [x] **Step 3: Add description, dependency-candidate, and exact payload tests.** Pin the cycle-safe candidate behavior and description-bearing payload:

  ```ts
  const response = {
      draft: {
          title: "ship",
          tasks: [
              { id: "t-1", label: "Plan", description: "", deps: [] },
              { id: "t-2", label: "Build", description: "", deps: [] },
              { id: "t-3", label: "Verify", description: "", deps: [] },
          ],
      },
  } as CommandJarvisPlanDagRtnData;
  const chain = setDraftDependency(
      setDraftDependency(draftFromPlan(response), "t-2", "t-1", true),
      "t-3",
      "t-2",
      true,
  );
  expect(dependencyCandidates(chain, "t-1").map((task) => task.id)).not.toContain("t-3");
  expect(dependencyCandidates(chain, "t-3").map((task) => task.id)).toContain("t-2");
  const described = setDraftDescription(chain, "t-2", "Implement the approved API");
  expect(toDagSubmitPayload(described).tasks[1]).toEqual(
      expect.objectContaining({ description: "Implement the approved API", deps: ["t-1"] }),
  );
  expect(chain.tasks[1].description).not.toBe("Implement the approved API");
  ```

- [x] **Step 4: Add validation tests for every frontend boundary.** Construct invalid fixtures directly and assert concrete messages:

  ```ts
  const valid = draftFromPlan({ draft: { title: "ship", tasks: [{ id: "t-1", label: "Build" }] } } as CommandJarvisPlanDagRtnData);
  let eight = valid;
  for (let i = 2; i <= 8; i++) eight = addDraftTask(eight, `task ${i}`);
  const ninthTask = { id: "t-9", label: "ninth", description: "", deps: [], gate: false, route: null };
  const cycleFixture = {
      title: "cycle",
      parallelism: 2,
      tasks: [
          { id: "t-1", label: "A", description: "", deps: ["t-2"], gate: false, route: null },
          { id: "t-2", label: "B", description: "", deps: ["t-1"], gate: false, route: null },
      ],
  };
  const invalidRouteFixture = setDraftRoute(valid, "t-1", { runtime: "missing", tier: "capable" });
  expect(validateDraft({ title: "ship", parallelism: 1, tasks: [] }, harnesses)).toContain("at least one task is required");
  expect(validateDraft({ ...eight, tasks: [...eight.tasks, ninthTask] }, harnesses)).toContain("no more than 8 tasks are allowed");
  expect(validateDraft({ ...valid, parallelism: 9 }, harnesses)).toContain("parallelism must be an integer from 1 through 8");
  expect(validateDraft(cycleFixture, harnesses).some((error) => error.includes("dependency cycle"))).toBe(true);
  expect(validateDraft(invalidRouteFixture, harnesses).some((error) => error.includes("route"))).toBe(true);
  ```

  The same table includes blank title/label/ID, duplicate ID/dependency, unknown/self dependency, parallelism zero, and non-integer parallelism.

- [x] **Step 5: Run tests and observe failure.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/draftmodel.test.ts
  ```

  Expected: failures for missing planner conversion/description/candidates and current 64/unbounded/final-delete behavior.

- [x] **Step 6: Implement the minimum immutable model changes.** Use these guards before cloning:

  ```ts
  if (draft.tasks.length >= MAX_DRAFT_TASKS) return draft;
  if (draft.tasks.length <= 1 || taskIndex(draft, id) < 0) return draft;
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > MAX_DRAFT_PARALLELISM) return draft;
  ```

  `draftFromPlan` clones all arrays/route objects and sets `parallelism: tasks.length === 1 ? 1 : 2`. `dependencyCandidates` returns current dependencies plus additions for which `setDraftDependency(draft, id, candidate.id, true) !== draft`; it excludes the selected task itself. Include `description: task.description` in every submit task.

- [x] **Step 7: Verify model, layout compatibility, and typecheck.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/draftmodel.test.ts frontend/app/view/orchestrate/daglayout.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/orchestrate/draftmodel.ts frontend/app/view/orchestrate/draftmodel.test.ts
  ```

- [x] **Step 8: Checkpoint without committing.** Run `git diff --check` and inspect only `draftmodel.ts` plus its test.

---

### Task 4: Derive the exception-first authorization summary

**Files:**
- Create: `frontend/app/view/orchestrate/draftsummary.ts`
- Create: `frontend/app/view/orchestrate/draftsummary.test.ts`

**Interfaces:**
- Consumes: `DagDraftRequest`, `DagDraft`, `validateDraft`, planner fallback/warnings, and installed harnesses.
- Produces:

  ```ts
  export type DraftWave = { index: number; taskIds: string[] };
  export type DraftException =
      | { kind: "gate"; taskId: string; label: string }
      | { kind: "route"; taskId: string; label: string; route: RoutePin };

  export type DagDraftSummary = {
      title: string;
      runRoute: RoutePin;
      taskCount: number;
      parallelism: number;
      waves: DraftWave[];
      routineTaskIds: string[];
      exceptions: DraftException[];
      warnings: string[];
      fallback: boolean;
      validationErrors: string[];
      canLaunch: boolean;
  };

  export function dependencyWaves(draft: DagDraft): DraftWave[];
  export function projectDraftSummary(input: {
      request: DagDraftRequest;
      draft: DagDraft;
      fallback: boolean;
      warnings: string[];
      harnesses: HarnessInfo[];
  }): DagDraftSummary;
  ```

- [x] **Step 1: Write wave and exception tests.** Use `plan → [backend, frontend] → verify` and assert waves `[[plan], [backend,frontend], [verify]]` in draft array order. Assert inherited non-gate tasks are routine, gates and route pins are exceptions, and exception task IDs remain selectable.

  ```ts
  expect(summary.exceptions).toEqual([
      { kind: "gate", taskId: "t-3", label: "Review" },
      { kind: "route", taskId: "t-2", label: "Build UI", route: { runtime: "pi", tier: "cheap" } },
  ]);
  ```

- [x] **Step 2: Write launch-availability tests.** Define file-level `request`, `harnesses`, and `validDraft` fixtures, then assert valid exceptions never block while deterministic validation does:

  ```ts
  const request = { channelId: "channel-1", goal: "ship", route: { runtime: "claude", tier: "mid" } } as DagDraftRequest;
  const harnesses = [{ runtime: "claude", installed: true, runworkercapable: true, routecapabilities: [{ runtime: "claude", tier: "mid", resolvedmodel: "sonnet" }] }] as HarnessInfo[];
  const validDraft = {
      title: "ship",
      parallelism: 2,
      tasks: [
          { id: "t-1", label: "Plan", description: "", deps: [], gate: true, route: null },
          { id: "t-2", label: "Build", description: "", deps: ["t-1"], gate: false, route: { runtime: "claude", tier: "mid" } },
      ],
  };
  const visibleExceptions = projectDraftSummary({
      request,
      draft: validDraft,
      fallback: true,
      warnings: ["Planner returned an invalid plan"],
      harnesses,
  });
  expect(visibleExceptions.canLaunch).toBe(true);
  expect(visibleExceptions.fallback).toBe(true);
  expect(visibleExceptions.warnings).toHaveLength(1);

  const invalid = { ...validDraft, tasks: validDraft.tasks.map((task, index) => index === 0 ? { ...task, label: " " } : task) };
  const blocked = projectDraftSummary({ request, draft: invalid, fallback: false, warnings: [], harnesses });
  expect(blocked.canLaunch).toBe(false);
  expect(blocked.validationErrors.some((error) => error.includes("label"))).toBe(true);
  ```

- [x] **Step 3: Run the test and observe failure.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/draftsummary.test.ts
  ```

  Expected: module-not-found failure.

- [x] **Step 4: Implement deterministic projection.** `dependencyWaves` repeatedly takes pending tasks whose dependencies are already assigned, preserving source array order. Return `[]` if no next wave exists; `projectDraftSummary` already exposes the cycle/unknown-dependency validation errors instead of fabricating a valid shape. Compute launch availability only as:

  ```ts
  const validationErrors = validateDraft(input.draft, input.harnesses);
  const canLaunch = validationErrors.length === 0;
  ```

  Do not include fallback, warnings, gates, or pins in that boolean.

- [x] **Step 5: Verify summary and model suites.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/draftsummary.test.ts frontend/app/view/orchestrate/draftmodel.test.ts
  npx eslint frontend/app/view/orchestrate/draftsummary.ts frontend/app/view/orchestrate/draftsummary.test.ts
  ```

- [x] **Step 6: Checkpoint without committing.** Run `git diff --check` and inspect the two new files.

---

### Task 5: Make the modal reducer and planning coordinator race-safe

**Files:**
- Modify: `frontend/app/view/orchestrate/dagmodalstate.ts:7-86`
- Modify: `frontend/app/view/orchestrate/dagmodalstate.test.ts:1-66`
- Create: `frontend/app/view/orchestrate/dagplanning.ts`
- Create: `frontend/app/view/orchestrate/dagplanning.test.ts`

**Interfaces:**
- Consumes: Task 3's `draftFromPlan`, generated `JarvisPlanDagCommand` response, existing global modal atom, and `selectedTaskIdAtom` reset for live graph compatibility.
- Produces:

  ```ts
  export type DagDraftView = "summary" | "graph";

  export type DagDraftState = {
      kind: "draft";
      request: DagDraftRequest;
      draft: DagDraft;
      fallback: boolean;
      warnings: string[];
      view: DagDraftView;
      selectedTaskId: string | null;
      dirty: boolean;
      error: string;
  };

  export type DagLaunchingState = { kind: "launching" } & Omit<DagDraftState, "kind">;

  export type DagModalState =
      | { kind: "decomposing"; requestId: number; request: DagDraftRequest; error: string }
      | DagDraftState
      | DagLaunchingState
      | { kind: "live"; channelId: string; runId: string; dagOref: string; error: string };

  export function allocateDagPlanRequestId(): number;
  export function dispatchDagModal(action: DagModalAction): void;
  export function requiresRetryConfirmation(state: DagModalState | null): boolean;
  export function createDagPlanningCoordinator(
      invoke: (request: DagDraftRequest) => Promise<CommandJarvisPlanDagRtnData>,
      dispatch: (action: DagModalAction) => void,
  ): { run(requestId: number, request: DagDraftRequest): Promise<void> };
  ```

- Reducer actions include `plan-succeeded`, `plan-failed`, `retry-plan`, `set-view`, `select-task`, `close-drawer`, `apply-draft`, `begin-launch`, `launch-failed`, `launch-succeeded`, `escape`, and existing open/close/live actions. Planner completion actions carry `requestId`; stale IDs are no-ops.

- [x] **Step 1: Replace reducer tests with the full transition matrix.** Use exact state restoration assertions such as:

  ```ts
  const launching = reduceDagModalState(draftState, { type: "begin-launch" });
  expect(launching).toEqual({ ...draftState, kind: "launching" });
  expect(reduceDagModalState(launching, { type: "launch-failed", error: "submit failed" })).toEqual({
      ...draftState,
      error: "submit failed",
  });
  expect(reduceDagModalState(newerDecomposing, {
      type: "plan-succeeded",
      requestId: olderRequestId,
      draft,
      fallback: false,
      warnings: [],
  })).toBe(newerDecomposing);
  ```

  Cover:
  - open → decomposing with allocated identity;
  - matching normal/fallback planner success → Summary draft with `dirty:false`;
  - stale success/failure → identical current state;
  - transport failure → decomposing error with Retry, no draft;
  - Summary ↔ Graph and drawer selection/close;
  - accepted `apply-draft` → dirty true; rejected identity-equal draft → unchanged state;
  - draft → launching; launch failure restores exact draft/fallback/warnings/view/selection/dirty; success → live;
  - Escape closes drawer first, then modal; launching ignores Escape/close.

  Use object identity assertions for stale and rejected actions.

- [x] **Step 2: Add dirty-fallback retry tests.** Assert:

  ```ts
  expect(requiresRetryConfirmation(cleanFallback)).toBe(false);
  expect(requiresRetryConfirmation({ ...cleanFallback, dirty: true })).toBe(true);
  expect(requiresRetryConfirmation({ ...cleanFallback, fallback: false, dirty: true })).toBe(false);
  ```

  A confirmed `retry-plan` creates decomposing state with the supplied new request ID; cancelling confirmation dispatches nothing and is covered in Task 7's visual flow.

- [x] **Step 3: Write coordinator tests.** Use deferred promises to prove two calls for the same request ID invoke RPC once, a newer request can run concurrently, completion dispatches the correct ID, and rejection dispatches `plan-failed` rather than creating fallback:

  ```ts
  const coordinator = createDagPlanningCoordinator(invoke, dispatch);
  const a = coordinator.run(1, request);
  const duplicate = coordinator.run(1, request);
  expect(invoke).toHaveBeenCalledTimes(1);
  resolve({ draft: { title: "ship", tasks: [{ id: "t-1", label: "ship" }] }, fallback: true, warnings: ["fallback"] });
  await Promise.all([a, duplicate]);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "plan-succeeded", requestId: 1, fallback: true }));
  ```

- [x] **Step 4: Run tests and observe failure.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/dagplanning.test.ts
  ```

  Expected: missing coordinator plus reducer/state-shape failures.

- [x] **Step 5: Implement reducer authority.** `open-draft` and `retry-plan` receive an explicit allocated ID. `plan-succeeded` converts to the exact draft shape above. `apply-draft` sets dirty only when `action.draft !== state.draft`. `begin-launch` spreads the exact review fields into launching. `launch-failed` reverses only the discriminant and error. Components must call the exported dispatch helper; they must not write replacement states directly.

- [x] **Step 6: Implement the one-in-flight coordinator.** Keep a private `Set<number>`. Call the generated command through the injected function. On success call `draftFromPlan(response)` once and dispatch `fallback: response.fallback ?? false` plus `warnings: response.warnings ?? []`. On transport rejection dispatch:

  ```ts
  { type: "plan-failed", requestId, error: `Planning request failed: ${String(error)}` }
  ```

  Always delete the request ID in `finally`. Do not catch that failure into a local one-task draft.

- [x] **Step 7: Verify state, planning, and typecheck.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/dagplanning.test.ts frontend/app/view/orchestrate/draftmodel.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/orchestrate/dagmodalstate.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/dagplanning.ts frontend/app/view/orchestrate/dagplanning.test.ts
  ```

- [x] **Step 8: Checkpoint without committing.** Run `git diff --check` and inspect the four task files.

---

### Task 6: Implement the exact deferred launch transaction

**Files:**
- Create: `frontend/app/view/orchestrate/daglaunch.ts`
- Create: `frontend/app/view/orchestrate/daglaunch.test.ts`
- Modify: `frontend/app/view/agents/runactions.ts:62-84`
- Modify: `frontend/app/view/agents/runactions.test.ts:1-180`

**Interfaces:**
- Consumes: `DagDraftRequest`, `DagDraft`, `toDagSubmitPayload`, existing `createRun`, `CancelRunCommand`, `DagSubmitCommand`, and the current `setActiveRunId` seam during Task 7 wiring.
- Produces:

  ```ts
  export type DagSubmitPayload = ReturnType<typeof toDagSubmitPayload>;
  export type DagLaunchDeps = {
      createDeferredRun(request: DagDraftRequest): Promise<Run>;
      submitDag(channelId: string, runId: string, payload: DagSubmitPayload): Promise<TaskGroup>;
      cancelRun(channelId: string, runId: string): Promise<void>;
  };

  export type DagLaunchResult =
      | { ok: true; channelId: string; runId: string; dagOref: string }
      | { ok: false; error: string };

  export async function launchDagDraft(
      request: DagDraftRequest,
      draft: DagDraft,
      deps: DagLaunchDeps,
  ): Promise<DagLaunchResult>;
  ```

- `createRun` options gain `deferStart?: boolean` and map it only to the RPC's `deferstart` field.

- [x] **Step 1: Write exact-order transaction tests.** Inject spies and assert `create → submit`, success identity, and input immutability:

  ```ts
  const originalDraft = structuredClone(draft);
  const order: string[] = [];
  const deps: DagLaunchDeps = {
      createDeferredRun: vi.fn(async () => { order.push("create"); return { id: "run-1" } as Run; }),
      submitDag: vi.fn(async (_channelId, _runId, payload) => {
          order.push("submit");
          expect(payload).toEqual(toDagSubmitPayload(draft));
          return { oid: "dag-1" } as TaskGroup;
      }),
      cancelRun: vi.fn(),
  };
  const result = await launchDagDraft(request, draft, deps);
  expect(order).toEqual(["create", "submit"]);
  expect(result).toEqual({ ok: true, channelId: request.channelId, runId: "run-1", dagOref: "dag:dag-1" });
  expect(draft).toEqual(originalDraft);
  ```

- [x] **Step 2: Write every failure branch.** Assert:
  - Create failure calls neither submit nor cancel.
  - Submit failure calls cancel once and returns a contextual submission error.
  - Cleanup failure returns both errors and the created Run ID.
  - No branch reports success after an error.

  ```ts
  expect(result).toEqual({
      ok: false,
      error: "DAG submission failed for run run-1: submit failed. Cleanup also failed: cancel failed",
  });
  ```

- [x] **Step 3: Add a `createRun` RPC-shape test.** Extend the existing API mock with `CreateRunCommand`, seed `atoms.workspaceId`, call:

  ```ts
  await createRun("channel-1", "ship", { runtime: "pi", tier: "mid" }, {
      mode: "orchestrator",
      deferStart: true,
  });
  ```

  Assert exact `runtime`, `tier`, `mode`, and `deferstart: true`. Also assert a normal direct call leaves `deferstart` undefined.

- [x] **Step 4: Run tests and observe failure.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/daglaunch.test.ts frontend/app/view/agents/runactions.test.ts
  ```

  Expected: missing launch module and unsupported `deferStart` option.

- [x] **Step 5: Implement launch orchestration without React/jotai imports.** Compute the payload once before CreateRun. Do not cancel when CreateRun fails. On submit failure, await best-effort cancellation. Use these error forms exactly:

  ```ts
  `Couldn't create the deferred run: ${String(error)}`
  `DAG submission failed for run ${run.id}: ${String(submitError)}`
  `DAG submission failed for run ${run.id}: ${String(submitError)}. Cleanup also failed: ${String(cancelError)}`
  ```

- [x] **Step 6: Extend only the existing create wrapper.** Add `deferStart?: boolean` to `opts` and `deferstart: opts?.deferStart` to `CreateRunCommand`. Do not expose it through pipeline/quick callers.

- [x] **Step 7: Verify transaction, run actions, and typecheck.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/daglaunch.test.ts frontend/app/view/agents/runactions.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/orchestrate/daglaunch.ts frontend/app/view/orchestrate/daglaunch.test.ts frontend/app/view/agents/runactions.ts frontend/app/view/agents/runactions.test.ts
  ```

- [x] **Step 8: Checkpoint without committing.** Run `git diff --check` and inspect only the four task files.

---

### Task 7: Build the approved Summary, task drawer, and draft Graph

**Files:**
- Create: `docs/prototype/orchestrator-fast-approval.html`
- Modify: `frontend/app/view/orchestrate/dagmodal.tsx:1-123`
- Create: `frontend/app/view/orchestrate/dagdraftview.tsx`
- Create: `frontend/app/view/orchestrate/dagdraftsummary.tsx`
- Create: `frontend/app/view/orchestrate/dagdraftgraph.tsx`
- Create: `frontend/app/view/orchestrate/dagtaskdrawer.tsx`

**Interfaces:**
- Consumes: Tasks 3–6, existing `RoutePicker`, `computeLayeredLayout`, modal focus helpers, motion tokens, `harnessesAtom`, generated `JarvisPlanDagCommand`, `createRun`, `RpcApi.DagSubmitCommand`, `cancelRun`, and `setActiveRunId`.
- Produces:

  ```ts
  export function DagDraftView(props: {
      state: DagDraftState | DagLaunchingState;
      summary: DagDraftSummary;
      harnesses: HarnessInfo[];
      dispatch: (action: DagModalAction) => void;
      onLaunch: () => void;
      onRetry: () => void;
      disabled: boolean;
  }): JSX.Element;

  export function DagDraftSummaryView(props: {
      state: DagDraftState;
      summary: DagDraftSummary;
      onSelectTask: (taskId: string) => void;
      onOpenGraph: () => void;
  }): JSX.Element;

  export function DagDraftGraph(props: {
      draft: DagDraft;
      selectedTaskId: string | null;
      onSelectTask: (taskId: string | null) => void;
  }): JSX.Element;

  export function DagTaskDrawer(props: {
      draft: DagDraft;
      taskId: string;
      disabled: boolean;
      onChange: (draft: DagDraft) => void;
      onClose: () => void;
  }): JSX.Element | null;
  ```

- [x] **Step 1: Create the high-fidelity mockup from the project kit.** Run:

  ```bash
  cp docs/prototype/mockup-template.html docs/prototype/orchestrator-fast-approval.html
  ```

  Replace the template demo body with four selectable frames in one document:
  1. clean Summary with title, route, task count, parallelism, dependency waves, collapsed routine tasks, and one accent Launch button;
  2. exception Summary with gate, pinned route, warning, fallback label, and validation error treatments;
  3. focused task drawer over Summary with label, description, dependencies, gate, route inheritance, and Delete;
  4. draft Graph with non-draggable nodes, Open Summary, parallelism control, Add task, and the same drawer.

  Reuse the template's `.panel`, `.card`, `.row`, `.chip`, `.badge`, `.btn-primary`, and `.btn-secondary` recipes. Add only layout CSS using existing `--color-*`, spacing, and radius variables. Each frame starts from this semantic structure:

  ```html
  <section class="frame panel" aria-labelledby="clean-summary-title">
    <header class="review-header">
      <div><span class="badge">Draft plan</span><h2 id="clean-summary-title">Ship fast approval</h2></div>
      <button class="btn-primary" type="button">Launch <kbd>Ctrl Enter</kbd></button>
    </header>
    <div class="authorization-grid">
      <main class="summary-column">
        <section class="card" aria-label="Execution shape"></section>
        <section class="card" aria-label="Exceptions"></section>
        <button class="btn-secondary" type="button">Show all tasks</button>
      </main>
      <aside class="drawer panel" aria-labelledby="drawer-title" hidden></aside>
    </div>
  </section>
  ```

- [x] **Step 2: Audit and obtain visual approval before React work.** Verify every checklist item at the top of the copied template, then serve:

  ```bash
  cd docs/prototype && python -m http.server 8766
  ```

  Open `http://localhost:8766/orchestrator-fast-approval.html`, inspect all four frames at wide and narrow Stage widths, and present it for approval. Stop before Step 3 until the user approves the mockup.

- [x] **Step 3: Implement the thin draft editor container.** `DagDraftView` calls `projectDraftSummary`, dispatches all accepted model mutations through `{type:"apply-draft", draft: next}`, and never owns a second draft copy. Render Summary when `state.view === "summary"`, Graph otherwise, and render one `DagTaskDrawer` when `selectedTaskId` is non-null.

- [x] **Step 4: Implement exception-first Summary markup.** Render:
  - title, proposed Run route, task count, parallelism, and wave rows;
  - fallback/warnings/validation as labelled status rows;
  - gates and pinned routes as semantic `<button type="button">` rows that select their task;
  - inherited routine tasks only after **Show all tasks** is activated;
  - **Open graph**, Retry for fallback, and the single accent Launch action.

  The Launch button uses `disabled={!summary.canLaunch || disabled}`. Do not include fallback, warnings, gates, or pins in that expression. Add:

  ```tsx
  <div aria-live="polite" className="sr-only">
      {summary.validationErrors.length === 0
          ? "Draft is valid and ready to launch"
          : `${summary.validationErrors.length} validation errors block launch`}
  </div>
  ```

- [x] **Step 5: Implement the focused task drawer.** Read the selected task from `draft.tasks`; return null when absent. Use controlled label/description fields, cycle-safe dependency candidates, gate checkbox, `RoutePicker` with inheritance, and Delete. Every handler calls the existing pure mutation and passes its result to `onChange`; identity-equal rejected changes remain no-ops. Give the first input visible focus treatment and `autoFocus`.

- [x] **Step 6: Implement the draft-only Graph.** Feed `DagDraft` directly to `computeLayeredLayout` and ReactFlow. Set `nodesDraggable={false}`, `nodesConnectable={false}`, and open the shared drawer on node click. Do not call `useDagGroup`, construct a `TaskGroup`, write WOS, or dispatch DAG RPCs. Graph toolbar changes parallelism from one through eight, adds a task only below eight, and switches back to Summary.

- [x] **Step 7: Wire the planner effect in `DagModal`.** Create the coordinator once with `useRef`. Its production invoke is:

  ```ts
  (request) => RpcApi.JarvisPlanDagCommand(TabRpcClient, {
      channelid: request.channelId,
      goal: request.goal,
      route: request.route,
  })
  ```

  When state is decomposing, call `coordinator.run(state.requestId, state.request)`. The coordinator's Set prevents StrictMode duplication; reducer identity rejects stale close/reopen/new-request completions.

- [x] **Step 8: Wire explicit Retry with dirty-fallback confirmation.** For transport error, dispatch `retry-plan` with `allocateDagPlanRequestId()`. For fallback draft, call the same action directly only when `requiresRetryConfirmation(state)` is false. Otherwise push existing `ConfirmModal` with:

  ```ts
  {
      title: "Replace edited fallback?",
      message: "Retrying planning will replace your edited fallback draft.",
      confirmLabel: "Retry planning",
      cancelLabel: "Keep draft",
      onConfirm: () => dispatch({ type: "retry-plan", requestId: allocateDagPlanRequestId() }),
  }
  ```

  Cancelling dispatches nothing.

- [x] **Step 9: Wire the authoritative launch transaction.** Build `DagLaunchDeps` with:

  ```ts
  {
      createDeferredRun: (request) => createRun(request.channelId, request.goal, request.route, {
          mode: "orchestrator",
          deferStart: true,
      }),
      submitDag: (channelId, runId, payload) => RpcApi.DagSubmitCommand(TabRpcClient, {
          channelid: channelId,
          runid: runId,
          ...payload,
      }),
      cancelRun,
  }
  ```

  Dispatch `begin-launch` before awaiting. On failure dispatch `launch-failed` only. On success call `setActiveRunId(channelId, runId)` and dispatch `launch-succeeded`. No other modal action may call CreateRun or DagSubmit.

- [x] **Step 10: Finish keyboard and dismissal ownership.** In the existing window key handler:
  - `Ctrl+Enter` or `Cmd+Enter` invokes launch only for a valid draft and calls `preventDefault`;
  - plain Enter is untouched;
  - Escape dispatches drawer-first `escape`, and does nothing while launching;
  - Tab remains trapped;
  - backdrop and Close use `canDismissDagModal`;
  - launching hides close and disables every mutable control.

- [x] **Step 11: Verify pure behavior, compile, and lint.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/draftmodel.test.ts frontend/app/view/orchestrate/draftsummary.test.ts frontend/app/view/orchestrate/dagmodalstate.test.ts frontend/app/view/orchestrate/dagplanning.test.ts frontend/app/view/orchestrate/daglaunch.test.ts frontend/app/view/orchestrate/daglayout.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/orchestrate/dagmodal.tsx frontend/app/view/orchestrate/dagdraftview.tsx frontend/app/view/orchestrate/dagdraftsummary.tsx frontend/app/view/orchestrate/dagdraftgraph.tsx frontend/app/view/orchestrate/dagtaskdrawer.tsx
  ```

- [x] **Step 12: Checkpoint without committing.** Run `git diff --check`, inspect all new markup for raw colors/SCSS/nonsemantic click handlers, and confirm no draft path imports WOS or DAG write commands except the explicit launch dependency.

---

### Task 8: Finish read-only effective route display in the live DAG

**Files:**
- Modify: `frontend/app/view/orchestrate/dagstore.ts:1-53`
- Modify: `frontend/app/view/orchestrate/dagstore.test.ts:1-55`
- Modify: `frontend/app/view/orchestrate/daggraph.tsx:1-260`
- Modify: `frontend/app/view/orchestrate/dagmodal.tsx`

**Interfaces:**
- Consumes: persisted owning `Run.Runtime + Tier`, task `RunSpec.Runtime + Tier`, `normalizeLegacyRoute`, `capabilityFor`, `harnessesAtom`, and existing `useWaveObjectValue`.
- Produces:

  ```ts
  export type DagNodeRoute = {
      source: "pinned" | "inherited";
      runtime: string;
      tier: string;
      resolvedModel: string;
  };

  export interface DagViewNode {
      // existing fields
      route: DagNodeRoute;
  }

  export function buildViewData(
      group: TaskGroup,
      owner: Run,
      harnesses: HarnessInfo[],
  ): { nodes: DagViewNode[]; edges: DagViewEdge[] };
  ```

- [x] **Step 1: Extend pure live projection tests.** Assert explicit task pin wins, no pin inherits owner, runtime-only legacy task becomes capable, owner empty tier becomes capable, matching backend `resolvedmodel` is displayed, and missing capability reports `unavailable` rather than guessing a model.

  ```ts
  expect(pinned.route).toEqual({ source: "pinned", runtime: "pi", tier: "cheap", resolvedModel: "pi-cheap" });
  expect(inherited.route).toEqual({ source: "inherited", runtime: "claude", tier: "mid", resolvedModel: "sonnet" });
  ```

- [x] **Step 2: Run the test and observe failure.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/agents/route.test.ts
  ```

  Expected: `buildViewData` lacks owner/harness arguments and route output.

- [x] **Step 3: Implement pure effective route projection.** A task with both runtime and tier uses its explicit pin; a runtime-only legacy task uses `normalizeLegacyRoute(runtime, tier)`; otherwise normalize the owning Run. Resolve display metadata through `capabilityFor`. Use `resolvedModel: capability?.resolvedmodel ?? "unavailable"`.

- [x] **Step 4: Load the owning Run only in live modal state.** Add a live-only child component in `dagmodal.tsx` that subscribes to `run:${state.runId}`, reads `harnessesAtom`, and passes owner+harnesses to `DagGraphView`. Draft Graph remains local and separate.

- [x] **Step 5: Render read-only route text.** Each live node and detail rail renders `pinned` or `inherits run route`, runtime, tier, and resolved model. The live header shows the immutable Run route. Add stable `data-dag-node-route="<source>:<runtime>:<tier>"`. Do not render a live RoutePicker.

- [x] **Step 6: Remove raw colors from the touched live graph.** Replace edge marker/stroke hex values with `var(--color-edge-strong)` and `var(--color-warning)`. Replace Background rgba with `color-mix(in srgb, var(--color-ink-mid) 14%, transparent)`. Replace the node's raw shadow class with existing `shadow-popover-line` or no shadow. Do not sweep unrelated files.

- [x] **Step 7: Verify live projection, typecheck, and lint.** Run:

  ```bash
  npx vitest run frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/agents/route.test.ts
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx eslint frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/orchestrate/dagmodal.tsx
  ```

- [x] **Step 8: Checkpoint without committing.** Run `git diff --check`; confirm live graph still reads only persisted TaskGroup/Run objects and exposes no mutation control.

---

### Task 9: Add end-to-end UI coverage, run full verification, and prepare one commit

**Files:**
- Modify: `scripts/cdp/scenarios.mjs:4540-4680`
- Modify after grounded verification: `docs/superpowers/specs/2026-08-21-orchestrator-fast-approval-design.md`
- Update task checkboxes/results: `docs/superpowers/plans/2026-08-21-orchestrator-fast-approval.md`
- Include generated outputs from Task 2 when changed:
  - `pkg/wshrpc/wshclient/wshclient.go`
  - `frontend/app/store/wshclientapi.ts`
  - `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: all prior tasks, existing `dag-lifecycle` CDP scenario, dev-only `window.__waveDagModalFixture`, real CreateRun/DagSubmit/Cancel RPCs, and the approved prototype.
- Produces: repeatable evidence for exception-first approval, draft editing, retry safety, keyboard/accessibility, exact launch boundary, live route display, and cleanup failures.

- [ ] **Step 1: Expand the existing `dag-lifecycle` scenario instead of adding a parallel scenario.** Preserve temporary channel/project cleanup. Add stable assertions for:
  1. opening an orchestrator draft produces a decomposing/draft `role="dialog"` and does not change Run count;
  2. clean Summary is the initial view and Launch is enabled;
  3. gate, pinned-route, warning, fallback, and validation-error fixtures render labelled exceptions; only validation disables Launch;
  4. drawer edits immediately recompute Summary;
  5. Graph → Summary round-trip preserves the same draft;
  6. dirty fallback Retry opens confirmation; cancel preserves the draft;
  7. Ctrl/Cmd+Enter launches a valid draft; plain Enter edits the focused field;
  8. Escape closes drawer first, then modal; launching ignores Escape/backdrop;
  9. launch creates exactly one deferred orchestrator Run, submits the exact draft, and transitions live;
  10. live nodes show pinned/inherited route lines over the still-mounted Stage;
  11. deterministic Create failure and submit-plus-cleanup failure fixtures show contextual errors and preserve review state.

  Use explicit before/after counts and stable hooks rather than timing-only claims:

  ```js
  const before = await getChannelRunCount(h, ctx.channelId);
  const modalKind = await h.ev(`document.querySelector('[data-dag-modal-kind]')?.getAttribute('data-dag-modal-kind')`);
  const afterPlanning = await getChannelRunCount(h, ctx.channelId);
  rec("planning creates no Run", modalKind === "draft" && afterPlanning === before, JSON.stringify({ before, afterPlanning, modalKind }));

  const launchClicked = await h.ev(`(() => {
      const button = document.querySelector('[data-dag-launch]');
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
  })()`);
  const liveKind = await h.ev(`document.querySelector('[data-dag-modal-kind]')?.getAttribute('data-dag-modal-kind')`);
  const afterLaunch = await getChannelRunCount(h, ctx.channelId);
  rec("Launch creates one Run and enters live", launchClicked && liveKind === "live" && afterLaunch === before + 1, JSON.stringify({ before, afterLaunch, liveKind }));
  ```

  Define `getChannelRunCount` beside the scenario's existing `getRun` helper by loading `getchannels`, selecting `ctx.channelId`, and returning `(channel.runs ?? []).length`.

- [ ] **Step 2: Capture and inspect deterministic frames.** Use the dev fixture for clean, exception, fallback, invalid, launching, create-failure, and submit-cleanup-failure frames. Use the production launch path for Run-count boundary and live transition. Capture:

  ```text
  cdp-shots/dag-summary-clean.png
  cdp-shots/dag-summary-exceptions.png
  cdp-shots/dag-task-drawer.png
  cdp-shots/dag-draft-graph.png
  cdp-shots/dag-fallback-retry.png
  cdp-shots/dag-launch-error.png
  cdp-shots/dag-live-routes.png
  ```

  Compare them by eye with `docs/prototype/orchestrator-fast-approval.html`; record any approved deviation in the spec's implementation note.

- [x] **Step 3: Regenerate once more and inspect drift.** Run:

  ```bash
  task generate
  git diff -- pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
  ```

  Expected: only the planned planner command/types remain.

- [ ] **Step 4: Run complete automated verification.** Run:

  ```bash
  go test ./pkg/jarvis ./pkg/runroute ./pkg/orchestrate
  CGO_CFLAGS="-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc" go test ./pkg/wshrpc/wshserver
  node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  npx vitest run
  npx eslint .
  task build:backend
  ```

  Do not label skipped or failing commands as passing. If full eslint exposes an unrelated baseline failure, record exact paths and rerun eslint over every touched frontend/script file.

- [ ] **Step 5: Run rebuilt UI verification.** Start the rebuilt app normally with `task dev`; then run:

  ```bash
  task verify:ui -- dag-lifecycle harness-picker runs-lifecycle surface-smoke
  ```

  Expected: every scenario row passes. Inspect `cdp-shots/index.html` for Stage-local layering, initial Summary, exceptions, drawer focus, Graph preservation, fallback/retry confirmation, validation announcements, launching guard, live route labels, and no pre-Launch Run.

- [ ] **Step 6: Update documentation only from evidence.** Change the spec status to `Implemented` only after Steps 4–5 pass. Add a short implementation note listing commands run and any approved mockup deviation. Tick this plan's completed boxes and leave any failed/skipped verification unchecked with its exact reason.

- [ ] **Step 7: Self-review the complete diff.** Run:

  ```bash
  git status --short
  git diff --stat
  git diff --check
  git diff -- docs/superpowers/specs/2026-08-20-route-chain-and-dag-modal-design.md docs/superpowers/plans/2026-08-20-route-chain-and-dag-modal.md
  rg -n 'console\.log|debugger|#[0-9a-fA-F]{3,8}|rgba\(' pkg/jarvis/plandag.go frontend/app/view/orchestrate scripts/cdp/scenarios.mjs
  ```

  Confirm no unrelated old-spec/old-plan edits, debug output, commented-out code, raw touched colors, SCSS, dependency changes, frontend capability matrix, draft persistence, live route picker, or planner modification to legacy decompose.

- [ ] **Step 8: Show the final commit proposal and ask approval.** Present:
  - every M/A/D path from `git status --short`;
  - a one-line summary per file group;
  - proposed message: `feat(dag): add structured fast-approval planning`;
  - why: planning remains ephemeral while valid drafts gain a fast explicit authorization and safe launch path.

  Ask exactly: **“Awaiting approval. Proceed? (yes/no)”** Do not stage or commit before the answer.

- [ ] **Step 9: After explicit yes, create the single feature commit.** Stage only the planned files:

  ```bash
  git add \
    pkg/jarvis/plandag.go \
    pkg/jarvis/plandag_test.go \
    pkg/wshrpc/wshrpctypes_jarvis.go \
    pkg/wshrpc/wshserver/wshserver_jarvis.go \
    pkg/wshrpc/wshserver/wshserver_plandag_test.go \
    pkg/wshrpc/wshserver/wshserver_harness_test.go \
    pkg/wshrpc/wshclient/wshclient.go \
    frontend/app/store/wshclientapi.ts \
    frontend/types/gotypes.d.ts \
    frontend/app/view/agents/runactions.ts \
    frontend/app/view/agents/runactions.test.ts \
    frontend/app/view/orchestrate/draftmodel.ts \
    frontend/app/view/orchestrate/draftmodel.test.ts \
    frontend/app/view/orchestrate/draftsummary.ts \
    frontend/app/view/orchestrate/draftsummary.test.ts \
    frontend/app/view/orchestrate/dagmodalstate.ts \
    frontend/app/view/orchestrate/dagmodalstate.test.ts \
    frontend/app/view/orchestrate/dagplanning.ts \
    frontend/app/view/orchestrate/dagplanning.test.ts \
    frontend/app/view/orchestrate/daglaunch.ts \
    frontend/app/view/orchestrate/daglaunch.test.ts \
    frontend/app/view/orchestrate/dagmodal.tsx \
    frontend/app/view/orchestrate/dagdraftview.tsx \
    frontend/app/view/orchestrate/dagdraftsummary.tsx \
    frontend/app/view/orchestrate/dagdraftgraph.tsx \
    frontend/app/view/orchestrate/dagtaskdrawer.tsx \
    frontend/app/view/orchestrate/dagstore.ts \
    frontend/app/view/orchestrate/dagstore.test.ts \
    frontend/app/view/orchestrate/daggraph.tsx \
    docs/prototype/orchestrator-fast-approval.html \
    scripts/cdp/scenarios.mjs \
    docs/superpowers/specs/2026-08-21-orchestrator-fast-approval-design.md \
    docs/superpowers/plans/2026-08-21-orchestrator-fast-approval.md
  git diff --cached --name-only
  git commit -m "feat(dag): add structured fast-approval planning"
  ```

  Verify the staged-name list contains no file outside this plan. Do not push.


## Execution results

- Tasks 1–8 completed without commits. Targeted and full backend/frontend tests passed; TypeScript typecheck, targeted lint, generation, and backend build passed.
- The approved prototype was served and inspected at `http://localhost:8766/orchestrator-fast-approval.html` at wide and 390×844 viewports.
- Task 9 automated verification was partial: full ESLint remains blocked by the repository baseline (545 errors, including existing `.worktrees/` artifacts and Node/browser global configuration gaps); touched-file lint passed except the existing `scripts/cdp/scenarios.mjs` global-environment errors.
- Task 9 UI verification was attempted with `task verify:ui -- dag-lifecycle harness-picker runs-lifecycle surface-smoke` and blocked before scenario steps because the attached app reported `TypeError: Cannot read properties of undefined (reading 'wshRpcCall')`; `surface-smoke` teardown also could not find the `Cockpit` nav button. The spec remains `conversational design approved; awaiting written review`; no implementation status claim is made.
- The final commit proposal and commit remain pending explicit user approval.
