# Mutation survivors, wave 5 of 5: fix the tests that miss behaviour

A mutation run over the repo (Stryker for `frontend/` and `claude/`, a custom overlay mutator for Go) changed one
operator, condition or call at a time and ran the tests. Each change listed below **survived**: the code was altered
and every test still passed. The lists were made on commit `c5f1c39c3`; a task names any of its sources that changed
since. The pilot (run 31c29f30, commit `4b178a0`) found 90% of survivors were real gaps in the tests and no code bugs.
This wave works the next part of the list, for the initiative 23e51be3.

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`

## How every task works a survivor

For each survivor in the task's list, in order:

1. Read the line and decide whether the change alters behaviour a caller can observe through the function's
   exported result (return value, emitted events, state the function writes).
   - **Equivalent:** it cannot be observed (the guard is redundant with an earlier one, the value is overwritten,
     the branch is unreachable from any input). Record it with a one-line reason. Do not write a test for it.
   - **Real gap:** some input makes the mutated code return something different. Go on to step 2.
2. Write or fix a test that feeds that input and asserts the exact correct output. Put it in the function's test
   file, beside the tests for the same behaviour, in that file's style. Test behaviour through the public function,
   not internals. A strong assertion on the specific value, never `toBeTruthy`, `toBeDefined`, `not.toBeNull`, a
   length-only check, or a Go `!= nil`/`len(x) > 0` alone. When a kill depends on a key being present with the value
   `undefined`, the assertion must be `toStrictEqual`, not `toEqual`.
   One test can kill several survivors that share a cause (for example every mutant of one `&&` chain); group them.
   A function that is not exported is tested through the exported function that calls it.
3. **Prove it:** apply the mutation to the source, run that one test, and see it fail; a kill counts only on a test
   FAIL, not a compile or import error. Then restore the source at once. Never end a turn, commit or report with a
   mutation still applied: `git diff` must show no change to any non-test file when the task ends.
4. If a survivor shows the code itself is wrong (the test would have to assert buggy behaviour), do not change the
   code and do not encode the bug in a test. Record it under **Bugs found** with the input and both outputs.

Change only test files. Run each touched test file whole after its tests are written.

## Report

End the task's report with this table and lists:

| Function | Survivors | Real gap, now killed | Equivalent | Bug found | Not reached |
|---|---|---|---|---|---|

- **Equivalent:** each as `L<line>:<col>`: one-line reason.
- **Bugs found:** each with the input, the expected output and the actual one.
- **Not reached:** survivors left unworked, with the reason.

### Task 1: Kill the survivors in frontend/app/view/jarvis (jarvissubjectstore.ts to runsettings.ts)

**Depends on:** none
**Files:** `frontend/app/view/jarvis/jarvissubjectstore.test.ts`, `frontend/app/view/jarvis/newrun.test.ts`, `frontend/app/view/jarvis/openref.test.ts`, `frontend/app/view/jarvis/peek/peekeffortmodel.test.ts`, `frontend/app/view/jarvis/peek/peekrunmodel.test.ts`, `frontend/app/view/jarvis/petjoin.test.ts`, `frontend/app/view/jarvis/petpeekmodel.test.ts`, `frontend/app/view/jarvis/profilemodel.test.ts`, `frontend/app/view/jarvis/projectpicker.test.ts`, `frontend/app/view/jarvis/returnsurface.test.ts`, `frontend/app/view/jarvis/runreport.test.ts`, `frontend/app/view/jarvis/runsettings.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

These sources changed after the mutation run, so their line numbers can be off: `frontend/app/view/jarvis/openref.ts`. Find each survivor by its source text; one whose line no longer exists goes under Not reached with the reason.

`frontend/app/view/jarvis/jarvissubjectstore.ts` `selectSubject` (23 survivors):

- L60:25 ConditionalExpression: `if (prev != null && prev.kind === "channel" && (subject.kind !== "channel" || subject.id !== prev.id)) {` => `true`
- L60:53 ConditionalExpression: `if (prev != null && prev.kind === "channel" && (subject.kind !== "channel" || subject.id !== prev.id)) {` => `false`
- L62:13 ConditionalExpression: `if (cur != null) {` => `true`
- L63:76 ConditionalExpression: `const run = globalStore.get(activeChannelRunsAtom).find((r) => r.id === cur);` => `true`
- L73:40 ConditionalExpression: `if (subject.kind !== "briefing" && subject.kind !== "effort") {` => `true`
- L76:9 ConditionalExpression: `if (subject.kind === "channel") {` => `false`
- L76:9 ConditionalExpression: `if (subject.kind === "channel") {` => `true`
- L76:9 EqualityOperator: `if (subject.kind === "channel") {` => `subject.kind !== "channel"`
- L76:37 BlockStatement: `if (subject.kind === "channel") {` => `{}`
- L77:23 ArrowFunction: `fireAndForget(() => selectChannel(subject.id));` => `() => undefined`
- L80:9 ConditionalExpression: `if (subject.kind === "briefing") {` => `true`
- L80:9 ConditionalExpression: `if (subject.kind === "briefing") {` => `false`
- L80:9 EqualityOperator: `if (subject.kind === "briefing") {` => `subject.kind !== "briefing"`
- L80:38 BlockStatement: `if (subject.kind === "briefing") {` => `{}`
- L83:9 ConditionalExpression: `if (subject.kind === "effort") {` => `true`
- L83:9 ConditionalExpression: `if (subject.kind === "effort") {` => `false`
- L83:9 EqualityOperator: `if (subject.kind === "effort") {` => `subject.kind !== "effort"`
- L83:36 BlockStatement: `if (subject.kind === "effort") {` => `{}`
- L85:23 ArrowFunction: `fireAndForget(() => loadEffortDetail("effort:" + subject.id));` => `() => undefined`
- L88:9 ConditionalExpression: `if (subject.kind === "dossier") {` => `true`
- L88:9 ConditionalExpression: `if (subject.kind === "dossier") {` => `false`
- L88:9 EqualityOperator: `if (subject.kind === "dossier") {` => `subject.kind !== "dossier"`
- L88:37 BlockStatement: `if (subject.kind === "dossier") {` => `{}`

`frontend/app/view/jarvis/newrun.ts` `rankProjects` (10 survivors):

- L158:15 MethodExpression: `const q = query.trim();` => `query`
- L159:9 ConditionalExpression: `if (q === "") {` => `false`
- L159:19 BlockStatement: `if (q === "") {` => `{}`
- L162:12 MethodExpression: `return names` => `names.map((name, index) => ({
  name,
  index,
  score: fuzzyScore(q, name)
})).filter((row): row is {
  name:`
- L165:15 ArrowFunction: `.sort((a, b) => b.score - a.score || a.index - b.index)` => `() => undefined`
- L165:25 ConditionalExpression: `.sort((a, b) => b.score - a.score || a.index - b.index)` => `true`
- L165:25 ConditionalExpression: `.sort((a, b) => b.score - a.score || a.index - b.index)` => `false`
- L165:25 LogicalOperator: `.sort((a, b) => b.score - a.score || a.index - b.index)` => `b.score - a.score && a.index - b.index`
- L165:25 ArithmeticOperator: `.sort((a, b) => b.score - a.score || a.index - b.index)` => `b.score + a.score`
- L165:46 ArithmeticOperator: `.sort((a, b) => b.score - a.score || a.index - b.index)` => `a.index + b.index`

`frontend/app/view/jarvis/openref.ts` `loadCanvas` (5 survivors):

- L400:37 ConditionalExpression: `if (!isCanvasSegment(topic) || (board != null && !isCanvasSegment(board))) {` => `false`
- L401:16 ObjectLiteral: `return { ok: false, reason: "unsupported", message: 'Not a canvas name: ${topic}' };` => `{}`
- L408:38 ConditionalExpression: `const agent = roster.find((a) => a.blockId != null && a.blockId === caller.blockId);` => `true`
- L415:9 ConditionalExpression: `if (!current()) {` => `false`
- L418:9 ConditionalExpression: `if (info == null || info.notfound) {` => `false`

`frontend/app/view/jarvis/openref.ts` `selectCanvas` (5 survivors):

- L427:13 ConditionalExpression: `if (board != null && board !== getCanvas(landing.owner)?.board) {` => `true`
- L427:13 ConditionalExpression: `if (board != null && board !== getCanvas(landing.owner)?.board) {` => `false`
- L427:13 LogicalOperator: `if (board != null && board !== getCanvas(landing.owner)?.board) {` => `board != null || board !== getCanvas(landing.owner)?.board`
- L427:13 ConditionalExpression: `if (board != null && board !== getCanvas(landing.owner)?.board) {` => `true`
- L427:13 EqualityOperator: `if (board != null && board !== getCanvas(landing.owner)?.board) {` => `board == null`

`frontend/app/view/jarvis/peek/peekeffortmodel.ts` `effortPeekModel` (16 survivors):

- L27:39 ArrayDeclaration: `const facts = effortFacts(effort, []);` => `["Stryker was here"]`
- L29:22 MethodExpression: `const doneRows = rows.filter((r) => r.tone === "done");` => `rows`
- L29:34 ArrowFunction: `const doneRows = rows.filter((r) => r.tone === "done");` => `() => undefined`
- L30:20 ArrayDeclaration: `const stages = [...new Set(doneRows.map((r) => r.stage).filter((s) => s !== ""))];` => `[]`
- L30:32 MethodExpression: `const stages = [...new Set(doneRows.map((r) => r.stage).filter((s) => s !== ""))];` => `doneRows.map(r => r.stage)`
- L30:45 ArrowFunction: `const stages = [...new Set(doneRows.map((r) => r.stage).filter((s) => s !== ""))];` => `() => undefined`
- L30:68 ArrowFunction: `const stages = [...new Set(doneRows.map((r) => r.stage).filter((s) => s !== ""))];` => `() => undefined`
- L31:23 ArrayDeclaration: `const objective = [...(effort.notes ?? [])].sort((a, b) => a.ts - b.ts)[0]?.text;` => `[]`
- L31:23 MethodExpression: `const objective = [...(effort.notes ?? [])].sort((a, b) => a.ts - b.ts)[0]?.text;` => `[...(effort.notes ?? [])]`
- L31:28 LogicalOperator: `const objective = [...(effort.notes ?? [])].sort((a, b) => a.ts - b.ts)[0]?.text;` => `effort.notes && []`
- L31:54 ArrowFunction: `const objective = [...(effort.notes ?? [])].sort((a, b) => a.ts - b.ts)[0]?.text;` => `() => undefined`
- L38:28 ArrowFunction: `segments: rows.map((r) => r.tone),` => `() => undefined`
- L39:19 ConditionalExpression: `doneLine: doneRows.length > 0 ? ['${doneRows.length} done', ...stages].join(" · ") : null,` => `false`
- L40:20 MethodExpression: `remaining: rows` => `rows.map((r, i) => ({
  n: i + 1,
  label: r.label,
  status: r.status,
  tone: r.tone,
  active: r.tone === "`
- L41:18 ArrowFunction: `.map((r, i) => ({ n: i + 1, label: r.label, status: r.status, tone: r.tone, active: r.tone === "active" }))` => `() => undefined`
- L42:21 ArrowFunction: `.filter((r) => r.tone !== "done" && r.tone !== "skipped"),` => `() => undefined`

`frontend/app/view/jarvis/peek/peekrunmodel.ts` `tasksPhase` (10 survivors):

- L112:9 ConditionalExpression: `if (total > 0 && done === total) {` => `true`
- L112:9 EqualityOperator: `if (total > 0 && done === total) {` => `total >= 0`
- L115:9 MethodExpression: `if (group.tasks.some((t) => FAILED_STATES.has(t.state))) {` => `group.tasks.every(t => FAILED_STATES.has(t.state))`
- L115:9 ConditionalExpression: `if (group.tasks.some((t) => FAILED_STATES.has(t.state))) {` => `false`
- L115:26 ArrowFunction: `if (group.tasks.some((t) => FAILED_STATES.has(t.state))) {` => `() => undefined`
- L115:62 BlockStatement: `if (group.tasks.some((t) => FAILED_STATES.has(t.state))) {` => `{}`
- L116:16 ObjectLiteral: `return { label: "Tasks", state, tone: "failed" };` => `{}`
- L118:9 ConditionalExpression: `if (group.tasks.some((t) => ATTENTION_STATES.has(t.state))) {` => `false`
- L118:9 MethodExpression: `if (group.tasks.some((t) => ATTENTION_STATES.has(t.state))) {` => `group.tasks.every(t => ATTENTION_STATES.has(t.state))`
- L118:26 ArrowFunction: `if (group.tasks.some((t) => ATTENTION_STATES.has(t.state))) {` => `() => undefined`

`frontend/app/view/jarvis/peek/peekrunmodel.ts` `taskMark` (9 survivors):

- L157:9 ConditionalExpression: `if (ATTENTION_STATES.has(state)) {` => `false`
- L160:9 ConditionalExpression: `if (state === "running" || state === "verifying" || state === "reviewing") {` => `false`
- L160:9 LogicalOperator: `if (state === "running" || state === "verifying" || state === "reviewing") {` => `(state === "running" || state === "verifying") && state === "reviewing"`
- L160:9 ConditionalExpression: `if (state === "running" || state === "verifying" || state === "reviewing") {` => `false`
- L160:9 LogicalOperator: `if (state === "running" || state === "verifying" || state === "reviewing") {` => `state === "running" && state === "verifying"`
- L160:9 ConditionalExpression: `if (state === "running" || state === "verifying" || state === "reviewing") {` => `false`
- L160:32 ConditionalExpression: `if (state === "running" || state === "verifying" || state === "reviewing") {` => `false`
- L160:57 ConditionalExpression: `if (state === "running" || state === "verifying" || state === "reviewing") {` => `false`
- L160:80 BlockStatement: `if (state === "running" || state === "verifying" || state === "reviewing") {` => `{}`

`frontend/app/view/jarvis/petjoin.ts` `shouldSpeakAsk` (10 survivors):

- L188:9 LogicalOperator: `if (oid != null && ctx.focusedBlockId != null && oid === ctx.focusedBlockId) {` => `oid != null && ctx.focusedBlockId != null || oid === ctx.focusedBlockId`
- L188:9 ConditionalExpression: `if (oid != null && ctx.focusedBlockId != null && oid === ctx.focusedBlockId) {` => `true`
- L188:9 LogicalOperator: `if (oid != null && ctx.focusedBlockId != null && oid === ctx.focusedBlockId) {` => `oid != null || ctx.focusedBlockId != null`
- L188:9 ConditionalExpression: `if (oid != null && ctx.focusedBlockId != null && oid === ctx.focusedBlockId) {` => `true`
- L188:24 ConditionalExpression: `if (oid != null && ctx.focusedBlockId != null && oid === ctx.focusedBlockId) {` => `true`
- L188:54 ConditionalExpression: `if (oid != null && ctx.focusedBlockId != null && oid === ctx.focusedBlockId) {` => `true`
- L191:9 ConditionalExpression: `if (ctx.surface === "agent" && ctx.askTabId != null && ctx.askTabId === ctx.focusTabId) {` => `true`
- L191:9 LogicalOperator: `if (ctx.surface === "agent" && ctx.askTabId != null && ctx.askTabId === ctx.focusTabId) {` => `ctx.surface === "agent" || ctx.askTabId != null`
- L191:9 ConditionalExpression: `if (ctx.surface === "agent" && ctx.askTabId != null && ctx.askTabId === ctx.focusTabId) {` => `true`
- L191:36 ConditionalExpression: `if (ctx.surface === "agent" && ctx.askTabId != null && ctx.askTabId === ctx.focusTabId) {` => `true`

`frontend/app/view/jarvis/petpeekmodel.ts` `dedupeUpdates` (6 survivors):

- L104:28 MethodExpression: `const queued = new Set((items ?? []).filter((item) => item.kind === "ask").map((item) => item.key));` => `items ?? []`
- L104:59 ConditionalExpression: `const queued = new Set((items ?? []).filter((item) => item.kind === "ask").map((item) => item.key));` => `true`
- L106:22 ConditionalExpression: `(event) => !(event.kind === "ask" && event.ref != null && queued.has('ask:${event.ref}'))` => `true`
- L106:22 LogicalOperator: `(event) => !(event.kind === "ask" && event.ref != null && queued.has('ask:${event.ref}'))` => `event.kind === "ask" || event.ref != null`
- L106:22 ConditionalExpression: `(event) => !(event.kind === "ask" && event.ref != null && queued.has('ask:${event.ref}'))` => `true`
- L106:46 ConditionalExpression: `(event) => !(event.kind === "ask" && event.ref != null && queued.has('ask:${event.ref}'))` => `true`

`frontend/app/view/jarvis/profilemodel.ts` `normalizeOverride` (6 survivors):

- L170:9 ConditionalExpression: `if (cleaned == null) {` => `false`
- L172:12 BlockStatement: `} else {` => `{}`
- L175:37 ConditionalExpression: `if (o.route?.runtime == null || o.route.runtime === "") {` => `false`
- L175:61 BlockStatement: `if (o.route?.runtime == null || o.route.runtime === "") {` => `{}`
- L177:12 BlockStatement: `} else {` => `{}`
- L178:21 ObjectLiteral: `out.route = { runtime: o.route.runtime, ...(o.route.model ? { model: o.route.model } : {}) };` => `{}`

`frontend/app/view/jarvis/profilemodel.ts` `reducePrinciplePatch` (6 survivors):

- L30:26 ObjectLiteral: `const replacements = { ...(patch?.replacements ?? {}) };` => `{}`
- L30:32 LogicalOperator: `const replacements = { ...(patch?.replacements ?? {}) };` => `patch?.replacements && {}`
- L46:17 ConditionalExpression: `if (idx >= 0) {` => `true`
- L56:21 ConditionalExpression: `if (additions[i].id === action.id) {` => `true`
- L62:52 ConditionalExpression: `const idx = additions.findIndex((a) => a.id === action.id);` => `true`
- L63:17 ConditionalExpression: `if (idx >= 0) {` => `true`

`frontend/app/view/jarvis/projectpicker.ts` `projectWhere` (5 survivors):

- L51:9 ConditionalExpression: `if (home !== "") {` => `true`
- L53:22 Regex: `const fold = /^[a-z]:$/i.test(h.segs[0] ?? "");` => `/^[a-z]:/i`
- L53:22 Regex: `const fold = /^[a-z]:$/i.test(h.segs[0] ?? "");` => `/[a-z]:$/i`
- L57:13 ConditionalExpression: `if (parent.length >= h.segs.length && sameSegs(parent.slice(0, h.segs.length), h.segs, fold)) {` => `true`
- L64:12 Regex: `return /^[a-z]:$/i.test(full) ? full + p.sep : full;` => `/[a-z]:$/i`

`frontend/app/view/jarvis/returnsurface.ts` `backToOrigin` (5 survivors):

- L86:9 LogicalOperator: `if (visit == null || watched == null) {` => `visit == null && watched == null`
- L86:9 ConditionalExpression: `if (visit == null || watched == null) {` => `false`
- L86:26 ConditionalExpression: `if (visit == null || watched == null) {` => `false`
- L90:9 ConditionalExpression: `if (trail.length === 0) {` => `false`
- L90:29 BlockStatement: `if (trail.length === 0) {` => `{}`

`frontend/app/view/jarvis/runreport.ts` `parseRunReport` (10 survivors):

- L73:28 ObjectLiteral: `const out: RunReport = { title: "", lead: "", sections: [] };` => `{}`
- L73:61 ArrayDeclaration: `const out: RunReport = { title: "", lead: "", sections: [] };` => `["Stryker was here"]`
- L76:43 BlockStatement: `for (const rawLine of md.split("\n")) {` => `{}`
- L77:19 MethodExpression: `const l = rawLine.trimEnd();` => `rawLine.trimStart()`
- L78:13 ConditionalExpression: `if (/^# /.test(l)) {` => `true`
- L78:13 ConditionalExpression: `if (/^# /.test(l)) {` => `false`
- L78:13 Regex: `if (/^# /.test(l)) {` => `/# /`
- L78:28 BlockStatement: `if (/^# /.test(l)) {` => `{}`
- L79:25 MethodExpression: `out.title = l.slice(2).trim();` => `l.slice(2)`
- L79:25 MethodExpression: `out.title = l.slice(2).trim();` => `l`

`frontend/app/view/jarvis/runsettings.ts` `draftSeedKey` (5 survivors):

- L145:9 LogicalOperator: `route?.model ?? "",` => `route?.model && ""`
- L147:9 LogicalOperator: `reviewer?.runtime ?? "",` => `reviewer?.runtime && ""`
- L148:9 LogicalOperator: `reviewer?.model ?? "",` => `reviewer?.model && ""`
- L149:9 LogicalOperator: `light?.runtime ?? "",` => `light?.runtime && ""`
- L150:9 LogicalOperator: `light?.model ?? "",` => `light?.model && ""`

### Task 2: Kill the survivors in frontend/app/view/jarvis, frontend/app/view/orchestrate (runsheetmodel.ts to recoverysummary.ts)

**Depends on:** none
**Files:** `frontend/app/view/jarvis/runsheetmodel.test.ts`, `frontend/app/view/jarvis/runtiming.test.ts`, `frontend/app/view/jarvis/sidebarnotes.test.ts`, `frontend/app/view/jarvis/tasksderive.test.ts`, `frontend/app/view/jarvis/trackeredit.test.ts`, `frontend/app/view/orchestrate/dagdescription.test.ts`, `frontend/app/view/orchestrate/dagdigest.test.ts`, `frontend/app/view/orchestrate/dagpeek.test.ts`, `frontend/app/view/orchestrate/recoverysummary.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/view/jarvis/runsheetmodel.ts` `doneStatus` (10 survivors):

- L130:9 ConditionalExpression: `if (group != null) {` => `true`
- L133:9 ConditionalExpression: `if (wallMs > 0) {` => `true`
- L133:9 EqualityOperator: `if (wallMs > 0) {` => `wallMs >= 0`
- L137:9 ConditionalExpression: `if (run.completedts) {` => `true`
- L140:9 ConditionalExpression: `if (report?.workerms) {` => `true`
- L144:71 ObjectLiteral: `run.evidence ? { text: "evidence sealed", tone: "success" } : { text: "sealing evidence", tone: "muted" }` => `{}`
- L148:14 ConditionalExpression: `sub: parts.length > 0 ? parts.join(", ") : "the run finished",` => `true`
- L148:14 EqualityOperator: `sub: parts.length > 0 ? parts.join(", ") : "the run finished",` => `parts.length >= 0`
- L151:16 ConditionalExpression: `meter: group != null ? STRIP : null,` => `true`
- L154:16 BooleanLiteral: `retry: false,` => `true`

`frontend/app/view/jarvis/runsheetmodel.ts` `liveTaskRow` (10 survivors):

- L509:18 ObjectLiteral: `const base = { taskId: task.id, label: task.label || task.id };` => `{}`
- L509:44 ConditionalExpression: `const base = { taskId: task.id, label: task.label || task.id };` => `true`
- L509:44 ConditionalExpression: `const base = { taskId: task.id, label: task.label || task.id };` => `false`
- L509:44 LogicalOperator: `const base = { taskId: task.id, label: task.label || task.id };` => `task.label && task.id`
- L550:17 ConditionalExpression: `if (task.runid) {` => `true`
- L571:56 ConditionalExpression: `const runMs = input.durations?.find((d) => d.taskid === task.id)?.runms;` => `true`
- L572:27 MethodExpression: `const parts = [` => `[lane != null ? 'lane ${lane}' : null, runMs ? formatElapsed(runMs) : null, task.runid ? shortRun(task.runid) `
- L573:17 ConditionalExpression: `lane != null ? 'lane ${lane}' : null,` => `true`
- L576:42 ConditionalExpression: `].filter((p): p is string => p != null);` => `true`
- L620:33 ConditionalExpression: `meta: firstLine(task.state === "verify-failed" ? task.verifyerror : task.mergeerror) || "merge blocked",` => `false`

`frontend/app/view/jarvis/runsheetmodel.ts` `cancelledStatus` (8 survivors):

- L168:9 ConditionalExpression: `if (run.completedts) {` => `true`
- L171:9 ConditionalExpression: `if (survivors > 0) {` => `true`
- L171:9 EqualityOperator: `if (survivors > 0) {` => `survivors >= 0`
- L178:16 BooleanLiteral: `pulse: false,` => `true`
- L181:15 ConditionalExpression: `next: group != null ? "nothing — the scheduler stopped dispatching" : null,` => `true`
- L181:15 ConditionalExpression: `next: group != null ? "nothing — the scheduler stopped dispatching" : null,` => `false`
- L181:15 EqualityOperator: `next: group != null ? "nothing — the scheduler stopped dispatching" : null,` => `group == null`
- L182:16 BooleanLiteral: `retry: false,` => `true`

`frontend/app/view/jarvis/runsheetmodel.ts` `readonlyBody` (7 survivors):

- L733:9 ConditionalExpression: `if (run.status === "done" && run.mode === "orchestrator") {` => `false`
- L733:9 ConditionalExpression: `if (run.status === "done" && run.mode === "orchestrator") {` => `true`
- L733:9 EqualityOperator: `if (run.status === "done" && run.mode === "orchestrator") {` => `run.status !== "done"`
- L733:63 BlockStatement: `if (run.status === "done" && run.mode === "orchestrator") {` => `{}`
- L736:9 ConditionalExpression: `if (run.status === "cancelled") {` => `false`
- L739:9 ConditionalExpression: `if (run.mode === "orchestrator") {` => `false`
- L743:9 LogicalOperator: `run.runtime || "claude",` => `run.runtime && "claude"`

`frontend/app/view/jarvis/runsheetmodel.ts` `undaggedStatus` (7 survivors):

- L205:19 ObjectLiteral: `const quiet = { meter: null, retry: false };` => `{}`
- L205:41 BooleanLiteral: `const quiet = { meter: null, retry: false };` => `true`
- L214:24 BooleanLiteral: `pulse: true,` => `false`
- L224:20 BooleanLiteral: `pulse: true,` => `false`
- L230:9 ConditionalExpression: `if (workerAsking) {` => `false`
- L241:9 ConditionalExpression: `if (run.status === "planning") {` => `false`
- L252:95 BooleanLiteral: `return { ...quiet, verb: "Executing", sub: "one worker, no plan", tone: "success", pulse: true, meta, next: nu` => `false`

`frontend/app/view/jarvis/runtiming.ts` `liveNote` (5 survivors):

- L110:22 ConditionalExpression: `const verb = overlapping.length === 1 ? "has" : "have";` => `false`
- L114:9 ConditionalExpression: `if (notStarted.length > 0) {` => `true`
- L114:9 EqualityOperator: `if (notStarted.length > 0) {` => `notStarted.length >= 0`
- L118:12 ConditionalExpression: `return sentences.length > 0 ? sentences.join(" ") : null;` => `true`
- L118:12 EqualityOperator: `return sentences.length > 0 ? sentences.join(" ") : null;` => `sentences.length >= 0`

`frontend/app/view/jarvis/sidebarnotes.ts` `sidebarNotes` (13 survivors):

- L26:21 MethodExpression: `const entries = feed.filter((f) => f.chunk === label && noteBody(f) !== "");` => `feed`
- L26:40 ConditionalExpression: `const entries = feed.filter((f) => f.chunk === label && noteBody(f) !== "");` => `true`
- L26:40 LogicalOperator: `const entries = feed.filter((f) => f.chunk === label && noteBody(f) !== "");` => `f.chunk === label || noteBody(f) !== ""`
- L26:40 ConditionalExpression: `const entries = feed.filter((f) => f.chunk === label && noteBody(f) !== "");` => `true`
- L26:61 ConditionalExpression: `const entries = feed.filter((f) => f.chunk === label && noteBody(f) !== "");` => `true`
- L30:40 EqualityOperator: `const newestShort = i === 0 && text.length < NOTE_OPEN_CHARS;` => `text.length <= NOTE_OPEN_CHARS`
- L38:21 ConditionalExpression: `edited: f.edited === true,` => `true`
- L38:21 ConditionalExpression: `edited: f.edited === true,` => `false`
- L38:21 EqualityOperator: `edited: f.edited === true,` => `f.edited !== true`
- L38:34 BooleanLiteral: `edited: f.edited === true,` => `false`
- L43:23 ConditionalExpression: `editable: f.noteAt != null && who !== "agent",` => `true`
- L44:43 Regex: `runOid: (f.run ?? "").replace(/^run:/, ""),` => `/run:/`
- L45:51 Regex: `sessionTab: (f.session ?? "").replace(/^agent:/, ""),` => `/agent:/`

`frontend/app/view/jarvis/tasksderive.ts` `decisionHeading` (7 survivors):

- L56:21 MethodExpression: `const summary = card.summary?.trim() ?? "";` => `card.summary`
- L57:23 MethodExpression: `const rationale = card.rationale.trim();` => `card.rationale`
- L62:42 ConditionalExpression: `const first = lines.findIndex((l) => l.trim() !== "");` => `true`
- L62:42 MethodExpression: `const first = lines.findIndex((l) => l.trim() !== "");` => `l`
- L66:19 MethodExpression: `const title = lines[first].trim().replace(/^[#>*+\-\s]+/, "");` => `lines[first]`
- L66:47 Regex: `const title = lines[first].trim().replace(/^[#>*+\-\s]+/, "");` => `/[#>*+\-\s]+/`
- L70:20 ArithmeticOperator: `.slice(first + 1)` => `first - 1`

`frontend/app/view/jarvis/trackeredit.ts` `chunkRef` (5 survivors):

- L74:10 Regex: `if (!/^\d+$/.test(label)) {` => `/\d+$/`
- L74:10 Regex: `if (!/^\d+$/.test(label)) {` => `/^\d+/`
- L74:10 Regex: `if (!/^\d+$/.test(label)) {` => `/^\d$/`
- L77:41 ConditionalExpression: `const idx = chunks.findIndex((c) => c.label === label);` => `true`
- L78:12 ConditionalExpression: `return idx < 0 ? label : String(idx + 1);` => `false`

`frontend/app/view/orchestrate/dagdescription.ts` `descriptionBlocks` (23 survivors):

- L24:17 ConditionalExpression: `if (/^\s*'''/.test(line)) {` => `false`
- L24:17 Regex: `if (/^\s*'''/.test(line)) {` => `/\s*'''/`
- L24:17 Regex: `if (/^\s*'''/.test(line)) {` => `/^\s'''/`
- L24:17 Regex: `if (/^\s*'''/.test(line)) {` => `/^\S*'''/`
- L24:39 BlockStatement: `if (/^\s*'''/.test(line)) {` => `{}`
- L27:20 AssignmentOperator: `} else fence.text += (fence.text ? "\n" : "") + line;` => `fence.text -= (fence.text ? "\n" : "") + line`
- L27:34 ArithmeticOperator: `} else fence.text += (fence.text ? "\n" : "") + line;` => `(fence.text ? "\n" : "") - line`
- L30:30 Regex: `const f = line.match(/^(\s*)'''/);` => `/(\s*)'''/`
- L30:30 Regex: `const f = line.match(/^(\s*)'''/);` => `/^(\S*)'''/`
- L33:55 ArithmeticOperator: `fence = { kind: "code", depth: Math.floor(f[1].length / INDENT), text: "", check: "" };` => `f[1].length * INDENT`
- L36:14 MethodExpression: `if (!line.trim()) {` => `line`
- L40:30 Regex: `const h = line.match(/^#{1,6}\s+(.*)/);` => `/#{1,6}\s+(.*)/`
- L40:30 Regex: `const h = line.match(/^#{1,6}\s+(.*)/);` => `/^#{1,6}\s(.*)/`
- L40:30 Regex: `const h = line.match(/^#{1,6}\s+(.*)/);` => `/^#{1,6}\S+(.*)/`
- L40:30 Regex: `const h = line.match(/^#{1,6}\s+(.*)/);` => `/^#{1,6}\s+(.)/`
- L46:31 Regex: `const li = line.match(/^(\s*)([-*]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)/);` => `/^(\s*)([-*]|\d\.)\s+(\[[ xX]\]\s+)?(.*)/`
- L46:31 Regex: `const li = line.match(/^(\s*)([-*]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)/);` => `/^(\s*)([-*]|\D+\.)\s+(\[[ xX]\]\s+)?(.*)/`
- L46:31 Regex: `const li = line.match(/^(\s*)([-*]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)/);` => `/^(\s*)([-*]|\d+\.)\s(\[[ xX]\]\s+)?(.*)/`
- L46:31 Regex: `const li = line.match(/^(\s*)([-*]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)/);` => `/^(\s*)([-*]|\d+\.)\s+(\[[ xX]\]\s)?(.*)/`
- L53:22 ConditionalExpression: `if (para && (para.kind === "p" || /^\s/.test(line))) {` => `true`
- L54:32 MethodExpression: `para.text += " " + line.trim();` => `line`
- L58:45 MethodExpression: `para = { kind: "p", depth: 0, text: line.trim(), check: "" };` => `line`
- L61:9 ConditionalExpression: `if (fence) blocks.push(fence);` => `false`

`frontend/app/view/orchestrate/dagdescription.ts` `descriptionLead` (7 survivors):

- L71:43 ConditionalExpression: `const prose = blocks.findIndex((b) => b.kind === "p" && !isLabel(b));` => `true`
- L73:9 ConditionalExpression: `if (files < 0 || (prose >= 0 && prose < files)) return { lead: prose >= 0 ? blocks[prose].text : "", more };` => `false`
- L73:23 EqualityOperator: `if (files < 0 || (prose >= 0 && prose < files)) return { lead: prose >= 0 ? blocks[prose].text : "", more };` => `prose > 0`
- L73:37 EqualityOperator: `if (files < 0 || (prose >= 0 && prose < files)) return { lead: prose >= 0 ? blocks[prose].text : "", more };` => `prose <= files`
- L75:50 ConditionalExpression: `for (let i = files + 1; i < blocks.length && blocks[i].kind === "li" && !blocks[i].check; i++) {` => `true`
- L79:44 EqualityOperator: `if (paths.length === 0) return { lead: prose >= 0 ? blocks[prose].text : "", more };` => `prose > 0`
- L84:18 EqualityOperator: `const rest = paths.length > LEAD_FILES_MAX ? ' +${paths.length - LEAD_FILES_MAX} more' : "";` => `paths.length >= LEAD_FILES_MAX`

`frontend/app/view/orchestrate/dagdescription.ts` `isFiles` (6 survivors):

- L66:35 ConditionalExpression: `const isFiles = (b: DescBlock) => b.kind === "p" && /^\*\*Files:\*\*$/.test(b.text.trim());` => `true`
- L66:35 LogicalOperator: `const isFiles = (b: DescBlock) => b.kind === "p" && /^\*\*Files:\*\*$/.test(b.text.trim());` => `b.kind === "p" || /^\*\*Files:\*\*$/.test(b.text.trim())`
- L66:35 ConditionalExpression: `const isFiles = (b: DescBlock) => b.kind === "p" && /^\*\*Files:\*\*$/.test(b.text.trim());` => `true`
- L66:53 Regex: `const isFiles = (b: DescBlock) => b.kind === "p" && /^\*\*Files:\*\*$/.test(b.text.trim());` => `/\*\*Files:\*\*$/`
- L66:53 Regex: `const isFiles = (b: DescBlock) => b.kind === "p" && /^\*\*Files:\*\*$/.test(b.text.trim());` => `/^\*\*Files:\*\*/`
- L66:77 MethodExpression: `const isFiles = (b: DescBlock) => b.kind === "p" && /^\*\*Files:\*\*$/.test(b.text.trim());` => `b.text`

`frontend/app/view/orchestrate/dagdigest.ts` `waitingText` (5 survivors):

- L99:45 ArrayDeclaration: `const blockers = td?.blockingtaskids ?? [];` => `["Stryker was here"]`
- L100:9 LogicalOperator: `if (td?.waitreason === "dependency" && blockers.length > 0) {` => `td?.waitreason === "dependency" || blockers.length > 0`
- L100:9 ConditionalExpression: `if (td?.waitreason === "dependency" && blockers.length > 0) {` => `true`
- L100:44 ConditionalExpression: `if (td?.waitreason === "dependency" && blockers.length > 0) {` => `true`
- L100:44 EqualityOperator: `if (td?.waitreason === "dependency" && blockers.length > 0) {` => `blockers.length >= 0`

`frontend/app/view/orchestrate/dagdigest.ts` `lastUpdatedText` (5 survivors):

- L299:40 ConditionalExpression: `if (state.lastUpdatedTs == null || state.lastUpdatedTs <= 0) {` => `false`
- L299:40 EqualityOperator: `if (state.lastUpdatedTs == null || state.lastUpdatedTs <= 0) {` => `state.lastUpdatedTs < 0`
- L303:9 EqualityOperator: `if (secs < 60) {` => `secs <= 60`
- L307:12 ConditionalExpression: `return mins < 60 ? 'updated ${mins}m ago' : 'updated ${Math.floor(mins / 60)}h ago';` => `true`
- L307:12 EqualityOperator: `return mins < 60 ? 'updated ${mins}m ago' : 'updated ${Math.floor(mins / 60)}h ago';` => `mins <= 60`

`frontend/app/view/orchestrate/dagpeek.ts` `taskPeek` (7 survivors):

- L85:37 ConditionalExpression: `if (task.state === "pending" || task.state === "ready") {` => `false`
- L93:25 EqualityOperator: `const attempt = (task.attempts ?? 0) > 1 ? ' · attempt ${task.attempts}' : "";` => `(task.attempts ?? 0) >= 1`
- L96:9 ConditionalExpression: `if (task.state === "reviewing") {` => `false`
- L105:24 ConditionalExpression: `const failed = task.state === "review-failed" || task.reviewverdict === "fail";` => `true`
- L105:24 LogicalOperator: `const failed = task.state === "review-failed" || task.reviewverdict === "fail";` => `task.state === "review-failed" && task.reviewverdict === "fail"`
- L105:24 ConditionalExpression: `const failed = task.state === "review-failed" || task.reviewverdict === "fail";` => `false`
- L105:24 EqualityOperator: `const failed = task.state === "review-failed" || task.reviewverdict === "fail";` => `task.state !== "review-failed"`

`frontend/app/view/orchestrate/recoverysummary.ts` `recoverySummary` (8 survivors):

- L29:18 UnaryOperator: `let lastTs = -1;` => `+1`
- L38:17 ConditionalExpression: `if (event.ts > lastTs) {` => `true`
- L38:17 EqualityOperator: `if (event.ts > lastTs) {` => `event.ts >= lastTs`
- L44:17 ConditionalExpression: `if (detail?.taskid !== taskId) {` => `false`
- L48:26 MethodExpression: `maxAttempt = Math.max(maxAttempt, detail.attempts ?? 0);` => `Math.min(maxAttempt, detail.attempts ?? 0)`
- L48:47 LogicalOperator: `maxAttempt = Math.max(maxAttempt, detail.attempts ?? 0);` => `detail.attempts && 0`
- L49:17 ConditionalExpression: `if (event.ts > lastTs) {` => `true`
- L49:17 EqualityOperator: `if (event.ts > lastTs) {` => `event.ts >= lastTs`

### Task 3: Kill the survivors in frontend/app/view/orchestrate and 5 more (timelinegroups.ts to keyutil.ts)

**Depends on:** none
**Files:** `frontend/app/view/orchestrate/timelinegroups.test.ts`, `frontend/app/view/orchestrate/workertasksort.test.ts`, `frontend/app/view/term/term-model.test.ts`, `frontend/tauri/api.test.ts`, `frontend/tauri/chrome.test.ts`, `frontend/util/getenv.test.ts`, `frontend/util/keyutil.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/view/orchestrate/timelinegroups.ts` `priority` (11 survivors):

- L39:9 ConditionalExpression: `if (kind === "task-first-activity") {` => `true`
- L39:9 ConditionalExpression: `if (kind === "task-first-activity") {` => `false`
- L39:9 EqualityOperator: `if (kind === "task-first-activity") {` => `kind !== "task-first-activity"`
- L39:41 BlockStatement: `if (kind === "task-first-activity") {` => `{}`
- L42:9 ConditionalExpression: `if (ATTENTION_KINDS.has(kind)) {` => `true`
- L45:9 ConditionalExpression: `if (kind === "task-merged" || kind === "task-verify-passed") {` => `true`
- L45:35 ConditionalExpression: `if (kind === "task-merged" || kind === "task-verify-passed") {` => `false`
- L45:35 EqualityOperator: `if (kind === "task-merged" || kind === "task-verify-passed") {` => `kind !== "task-verify-passed"`
- L48:9 ConditionalExpression: `if (LANDED_KINDS.has(kind)) {` => `true`
- L48:9 ConditionalExpression: `if (LANDED_KINDS.has(kind)) {` => `false`
- L48:33 BlockStatement: `if (LANDED_KINDS.has(kind)) {` => `{}`

`frontend/app/view/orchestrate/timelinegroups.ts` `groupEvents` (6 survivors):

- L120:20 MethodExpression: `const sorted = [...events].sort((a, b) => a.ts - b.ts);` => `[...events]`
- L120:37 ArrowFunction: `const sorted = [...events].sort((a, b) => a.ts - b.ts);` => `() => undefined`
- L120:47 ArithmeticOperator: `const sorted = [...events].sort((a, b) => a.ts - b.ts);` => `a.ts + b.ts`
- L126:18 EqualityOperator: `if (g && e.ts - g.last <= BURST_MS) {` => `e.ts - g.last < BURST_MS`
- L138:24 BooleanLiteral: `attention: false,` => `true`
- L139:20 ArrayDeclaration: `steps: [],` => `["Stryker was here"]`

`frontend/app/view/orchestrate/workertasksort.ts` `workerBucket` (10 survivors):

- L21:36 ConditionalExpression: `if (td.waitreason === "ask" || td.waitreason === "failure") {` => `false`
- L41:9 ConditionalExpression: `case "cancelled":` => `case "cancelled":`
- L43:9 ConditionalExpression: `default:` => `default:`
- L47:9 ConditionalExpression: `if (td.waitreason === "dependency" || td.waitreason === "parallelism" || node.state === "pending" || node.stat` => `true`
- L47:9 ConditionalExpression: `if (td.waitreason === "dependency" || td.waitreason === "parallelism" || node.state === "pending" || node.stat` => `false`
- L47:9 LogicalOperator: `if (td.waitreason === "dependency" || td.waitreason === "parallelism" || node.state === "pending" || node.stat` => `td.waitreason === "dependency" && td.waitreason === "parallelism"`
- L47:9 ConditionalExpression: `if (td.waitreason === "dependency" || td.waitreason === "parallelism" || node.state === "pending" || node.stat` => `false`
- L47:9 EqualityOperator: `if (td.waitreason === "dependency" || td.waitreason === "parallelism" || node.state === "pending" || node.stat` => `td.waitreason !== "dependency"`
- L47:43 ConditionalExpression: `if (td.waitreason === "dependency" || td.waitreason === "parallelism" || node.state === "pending" || node.stat` => `false`
- L47:43 EqualityOperator: `if (td.waitreason === "dependency" || td.waitreason === "parallelism" || node.state === "pending" || node.stat` => `td.waitreason !== "parallelism"`

`frontend/app/view/term/term-model.ts` `handleTerminalKeydown` (8 survivors):

- L403:13 ConditionalExpression: `if (waveEvent.type != "keydown") {` => `false`
- L407:13 ConditionalExpression: `if (this.keyDownHandler(waveEvent)) {` => `false`
- L413:13 ConditionalExpression: `if (isMacOS()) {` => `false`
- L413:13 ConditionalExpression: `if (isMacOS()) {` => `true`
- L427:13 ConditionalExpression: `if (keyutil.checkKeyPressed(waveEvent, "Shift:Enter")) {` => `false`
- L439:13 ConditionalExpression: `if (this.shouldHandleCtrlVPaste() && keyutil.checkKeyPressed(waveEvent, "Ctrl:v")) {` => `true`
- L439:13 LogicalOperator: `if (this.shouldHandleCtrlVPaste() && keyutil.checkKeyPressed(waveEvent, "Ctrl:v")) {` => `this.shouldHandleCtrlVPaste() || keyutil.checkKeyPressed(waveEvent, "Ctrl:v")`
- L446:13 ConditionalExpression: `if (keyutil.checkKeyPressed(waveEvent, "Ctrl:Shift:v")) {` => `true`

`frontend/tauri/api.ts` `installTauriApi` (7 survivors):

- L38:81 ArrowFunction: `listen<WaveInitOpts>("wave-init", (e) => callback(e.payload)).catch((err) =>` => `() => undefined`
- L55:17 LogicalOperator: `if (url && typeof url === "string") {` => `url || typeof url === "string"`
- L55:24 ConditionalExpression: `if (url && typeof url === "string") {` => `true`
- L57:20 BlockStatement: `} else {` => `{}`
- L64:29 ArrowFunction: `onZoomFactorChange: (cb: (zoomFactor: number) => void) => chrome.onZoomFactorChange(cb),` => `() => undefined`
- L65:29 ArrowFunction: `onFullScreenChange: (cb: (isFullScreen: boolean) => void) => chrome.onFullScreenChange(cb),` => `() => undefined`
- L66:36 ArrowFunction: `onControlShiftStateUpdate: (cb: (state: boolean) => void) => chrome.onControlShiftStateUpdate(cb),` => `() => undefined`

`frontend/tauri/chrome.ts` `applyKeyToCtrlShift` (6 survivors):

- L58:9 ConditionalExpression: `if (e.type === "keyup") {` => `false`
- L58:29 BlockStatement: `if (e.type === "keyup") {` => `{}`
- L59:13 ConditionalExpression: `if (!e.ctrl || !e.shift) setCtrlShift(false);` => `true`
- L59:13 BooleanLiteral: `if (!e.ctrl || !e.shift) setCtrlShift(false);` => `e.ctrl`
- L62:18 ConditionalExpression: `setCtrlShift(e.ctrl && e.shift && !e.meta);` => `true`
- L62:18 LogicalOperator: `setCtrlShift(e.ctrl && e.shift && !e.meta);` => `e.ctrl || e.shift`

`frontend/util/getenv.ts` `getEnv` (6 survivors):

- L21:51 BlockStatement: `export function getEnv(paramName: string): string {` => `{}`
- L23:9 ConditionalExpression: `if (win != null) {` => `false`
- L27:9 ConditionalExpression: `if (proc != null) {` => `true`
- L27:9 ConditionalExpression: `if (proc != null) {` => `false`
- L27:9 EqualityOperator: `if (proc != null) {` => `proc == null`
- L27:23 BlockStatement: `if (proc != null) {` => `{}`

`frontend/util/keyutil.ts` `checkKeyPressed` (21 survivors):

- L190:9 ConditionalExpression: `if (notMod(keyPress.mods.Option, event.option)) {` => `false`
- L193:9 ConditionalExpression: `if (notMod(keyPress.mods.Cmd, event.cmd)) {` => `false`
- L202:9 ConditionalExpression: `if (notMod(keyPress.mods.Alt, event.alt)) {` => `false`
- L205:9 ConditionalExpression: `if (notMod(keyPress.mods.Meta, event.meta)) {` => `false`
- L210:9 ConditionalExpression: `if (keyPress.keyType == KeyTypeCode) {` => `true`
- L210:9 ConditionalExpression: `if (keyPress.keyType == KeyTypeCode) {` => `false`
- L210:9 EqualityOperator: `if (keyPress.keyType == KeyTypeCode) {` => `keyPress.keyType != KeyTypeCode`
- L213:9 ConditionalExpression: `if (keyPress.keyType == KeyTypeKey) {` => `true`
- L215:13 ConditionalExpression: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `true`
- L215:13 ConditionalExpression: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `false`
- L215:13 LogicalOperator: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `eventKey != null && eventKey.length == 1 || /[A-Z]/.test(eventKey.charAt(0))`
- L215:13 ConditionalExpression: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `true`
- L215:13 LogicalOperator: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `eventKey != null || eventKey.length == 1`
- L215:13 ConditionalExpression: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `true`
- L215:13 EqualityOperator: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `eventKey == null`
- L215:33 ConditionalExpression: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `true`
- L215:33 EqualityOperator: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `eventKey.length != 1`
- L215:57 Regex: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `/[^A-Z]/`
- L215:70 MethodExpression: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `eventKey`
- L215:91 BlockStatement: `if (eventKey != null && eventKey.length == 1 && /[A-Z]/.test(eventKey.charAt(0))) {` => `{}`
- L220:20 ConditionalExpression: `} else if (eventKey == " ") {` => `false`

`frontend/util/keyutil.ts` `parseKeyDescription` (12 survivors):

- L78:13 ConditionalExpression: `if (key == "Cmd") {` => `false`
- L89:20 ConditionalExpression: `} else if (key == "Option") {` => `false`
- L96:20 ConditionalExpression: `} else if (key == "Alt") {` => `false`
- L103:20 ConditionalExpression: `} else if (key == "Meta") {` => `false`
- L114:17 ConditionalExpression: `if (rtn.keyType == KeyTypeKey && key.length == 1) {` => `false`
- L114:17 ConditionalExpression: `if (rtn.keyType == KeyTypeKey && key.length == 1) {` => `true`
- L114:17 EqualityOperator: `if (rtn.keyType == KeyTypeKey && key.length == 1) {` => `rtn.keyType != KeyTypeKey`
- L114:63 BlockStatement: `if (rtn.keyType == KeyTypeKey && key.length == 1) {` => `{}`
- L117:21 ConditionalExpression: `if (/[A-Z]/.test(key.charAt(0))) {` => `false`
- L117:34 MethodExpression: `if (/[A-Z]/.test(key.charAt(0))) {` => `key`
- L117:50 BlockStatement: `if (/[A-Z]/.test(key.charAt(0))) {` => `{}`
- L120:28 ConditionalExpression: `} else if (key == " ") {` => `false`

`frontend/util/keyutil.ts` `adaptFromReactOrNativeKeyEvent` (7 survivors):

- L235:15 ConditionalExpression: `rtn.cmd = PLATFORM == PlatformMacOS ? event.metaKey : event.altKey;` => `true`
- L235:15 ConditionalExpression: `rtn.cmd = PLATFORM == PlatformMacOS ? event.metaKey : event.altKey;` => `false`
- L235:15 EqualityOperator: `rtn.cmd = PLATFORM == PlatformMacOS ? event.metaKey : event.altKey;` => `PLATFORM != PlatformMacOS`
- L236:18 ConditionalExpression: `rtn.option = PLATFORM == PlatformMacOS ? event.altKey : event.metaKey;` => `true`
- L236:18 ConditionalExpression: `rtn.option = PLATFORM == PlatformMacOS ? event.altKey : event.metaKey;` => `false`
- L236:18 EqualityOperator: `rtn.option = PLATFORM == PlatformMacOS ? event.altKey : event.metaKey;` => `PLATFORM != PlatformMacOS`
- L243:9 ConditionalExpression: `if (event.type == "keydown" || event.type == "keyup" || event.type == "keypress") {` => `true`
