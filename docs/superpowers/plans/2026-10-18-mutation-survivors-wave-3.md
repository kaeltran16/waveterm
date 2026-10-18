# Mutation survivors, wave 3 of 5: fix the tests that miss behaviour

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

### Task 1: Kill the survivors in frontend/app/view/agents (jarviscards.ts to opencodetranscriptprojection.ts)

**Depends on:** none
**Files:** `frontend/app/view/agents/jarviscards.test.ts`, `frontend/app/view/agents/jarvisderive.test.ts`, `frontend/app/view/agents/launch.test.ts`, `frontend/app/view/agents/leadcardmodel.test.ts`, `frontend/app/view/agents/livetranscript.test.ts`, `frontend/app/view/agents/memorymodel.test.ts`, `frontend/app/view/agents/modellabel.test.ts`, `frontend/app/view/agents/opencodetranscriptprojection.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/view/agents/jarviscards.ts` `parseCardData` (14 survivors):

- L28:9 ConditionalExpression: `if (!msg.data) {` => `false`
- L28:20 BlockStatement: `if (!msg.data) {` => `{}`
- L33:13 LogicalOperator: `if (typeof p.question !== "string" || !Array.isArray(p.options) || typeof p.askORef !== "string") {` => `(typeof p.question !== "string" || !Array.isArray(p.options)) && typeof p.askORef !== "string"`
- L33:13 ConditionalExpression: `if (typeof p.question !== "string" || !Array.isArray(p.options) || typeof p.askORef !== "string") {` => `false`
- L33:13 LogicalOperator: `if (typeof p.question !== "string" || !Array.isArray(p.options) || typeof p.askORef !== "string") {` => `typeof p.question !== "string" && !Array.isArray(p.options)`
- L33:13 ConditionalExpression: `if (typeof p.question !== "string" || !Array.isArray(p.options) || typeof p.askORef !== "string") {` => `false`
- L33:76 ConditionalExpression: `if (typeof p.question !== "string" || !Array.isArray(p.options) || typeof p.askORef !== "string") {` => `false`
- L38:20 ConditionalExpression: `askId: typeof p.askId === "string" ? p.askId : undefined,` => `true`
- L39:25 ConditionalExpression: `workerORef: typeof p.workerORef === "string" ? p.workerORef : "",` => `true`
- L42:21 ConditionalExpression: `choice: typeof p.choice === "number" ? p.choice : undefined,` => `true`
- L43:24 ConditionalExpression: `humanPick: typeof p.humanPick === "number" ? p.humanPick : undefined,` => `true`
- L44:21 ConditionalExpression: `reason: typeof p.reason === "string" ? p.reason : undefined,` => `true`
- L44:21 ConditionalExpression: `reason: typeof p.reason === "string" ? p.reason : undefined,` => `false`
- L44:21 EqualityOperator: `reason: typeof p.reason === "string" ? p.reason : undefined,` => `typeof p.reason !== "string"`

`frontend/app/view/agents/jarvisderive.ts` `buildFleetSnapshot` (11 survivors):

- L36:13 ConditionalExpression: `if (!m.reforef?.startsWith(OREF_PREFIX)) {` => `false`
- L36:50 BlockStatement: `if (!m.reforef?.startsWith(OREF_PREFIX)) {` => `{}`
- L51:13 ConditionalExpression: `if (m.kind === "outcome") {` => `true`
- L53:17 ConditionalExpression: `if (!prev || (m.ts ?? 0) > prev.ts) {` => `true`
- L55:21 BlockStatement: `try {` => `{}`
- L62:40 LogicalOperator: `outcome: { status: parsed.status ?? "done", summary: parsed.summary ?? m.text ?? "" },` => `parsed.status && "done"`
- L62:74 LogicalOperator: `outcome: { status: parsed.status ?? "done", summary: parsed.summary ?? m.text ?? "" },` => `parsed.summary && m.text`
- L72:35 EqualityOperator: `const outcome = oc && oc.ts > (activeTs.get(oref) ?? 0) ? oc.outcome : undefined;` => `oc.ts >= (activeTs.get(oref) ?? 0)`
- L73:45 ConditionalExpression: `const live = agents.find((a) => a.id === id);` => `true`
- L81:30 ConditionalExpression: `askText: live.state === "asking" ? live.ask?.questions?.[0]?.question : undefined,` => `true`
- L82:28 ConditionalExpression: `askId: live.state === "asking" ? live.ask?.askId : undefined,` => `true`

`frontend/app/view/agents/launch.ts` `buildLaunchMeta` (6 survivors):

- L133:13 ConditionalExpression: `if (spec.cwd) {` => `true`
- L138:27 MethodExpression: `const startupTokens = spec.startupCommand.trim().split(/\s+/).filter(Boolean);` => `spec.startupCommand.trim().split(/\s+/)`
- L138:27 MethodExpression: `const startupTokens = spec.startupCommand.trim().split(/\s+/).filter(Boolean);` => `spec.startupCommand`
- L138:60 Regex: `const startupTokens = spec.startupCommand.trim().split(/\s+/).filter(Boolean);` => `/\s/`
- L163:20 BooleanLiteral: `"cmd:jwt": true,` => `false`
- L165:9 ConditionalExpression: `if (spec.cwd) {` => `true`

`frontend/app/view/agents/leadcardmodel.ts` `taskRow` (17 survivors):

- L137:16 ConditionalExpression: `label: task.label || task.id,` => `true`
- L137:16 ConditionalExpression: `label: task.label || task.id,` => `false`
- L137:16 LogicalOperator: `label: task.label || task.id,` => `task.label && task.id`
- L160:69 ConditionalExpression: `const ranMs = run.digest?.durations?.tasks?.find((t) => t.taskid === task.id)?.runms;` => `true`
- L200:23 ConditionalExpression: `tone: task.state === "stalled" ? "warn" : "err",` => `true`
- L200:23 ConditionalExpression: `tone: task.state === "stalled" ? "warn" : "err",` => `false`
- L200:23 EqualityOperator: `tone: task.state === "stalled" ? "warn" : "err",` => `task.state !== "stalled"`
- L204:21 ConditionalExpression: `task.state === "stalled" ? "no output · process alive" : task.lastfailurekind || "failed"` => `true`
- L204:21 ConditionalExpression: `task.state === "stalled" ? "no output · process alive" : task.lastfailurekind || "failed"` => `false`
- L204:21 EqualityOperator: `task.state === "stalled" ? "no output · process alive" : task.lastfailurekind || "failed"` => `task.state !== "stalled"`
- L214:46 ConditionalExpression: `sub: join(task.id, laneText, task.state === "verify-failed" ? "Verify failed" : "merge conflict"),` => `true`
- L214:46 ConditionalExpression: `sub: join(task.id, laneText, task.state === "verify-failed" ? "Verify failed" : "merge conflict"),` => `false`
- L214:46 EqualityOperator: `sub: join(task.id, laneText, task.state === "verify-failed" ? "Verify failed" : "merge conflict"),` => `task.state !== "verify-failed"`
- L226:26 ConditionalExpression: `const slot = run.digest?.tasks?.find((t) => t.taskid === task.id)?.waitreason === "parallelism";` => `true`
- L226:57 ConditionalExpression: `const slot = run.digest?.tasks?.find((t) => t.taskid === task.id)?.waitreason === "parallelism";` => `true`
- L254:9 LogicalOperator: `if (workerNeedsYou(run, task.id, worker) && worker.ask != null) {` => `workerNeedsYou(run, task.id, worker) || worker.ask != null`
- L254:49 ConditionalExpression: `if (workerNeedsYou(run, task.id, worker) && worker.ask != null) {` => `true`

`frontend/app/view/agents/leadcardmodel.ts` `buildLeadCard` (6 survivors):

- L293:30 MethodExpression: `const leadModel = lead ? 'lead ${lead.model || lead.agent || ""}'.trim() : "no lead";` => `'lead ${lead.model || lead.agent || ""}'`
- L300:19 ConditionalExpression: `needsYou: askCount > 0 || lead?.state === "asking",` => `true`
- L300:19 EqualityOperator: `needsYou: askCount > 0 || lead?.state === "asking",` => `askCount >= 0`
- L300:35 ConditionalExpression: `needsYou: askCount > 0 || lead?.state === "asking",` => `false`
- L300:35 EqualityOperator: `needsYou: askCount > 0 || lead?.state === "asking",` => `lead?.state !== "asking"`
- L302:19 ConditionalExpression: `planning: dag == null && !runFinished(run),` => `true`

`frontend/app/view/agents/leadcardmodel.ts` `isLeadDown` (5 survivors):

- L398:20 MethodExpression: `const failed = events.filter((e) => e.kind === "lead-wake-failed").sort((a, b) => b.ts - a.ts)[0];` => `events.filter(e => e.kind === "lead-wake-failed")`
- L398:20 MethodExpression: `const failed = events.filter((e) => e.kind === "lead-wake-failed").sort((a, b) => b.ts - a.ts)[0];` => `events`
- L398:41 ConditionalExpression: `const failed = events.filter((e) => e.kind === "lead-wake-failed").sort((a, b) => b.ts - a.ts)[0];` => `true`
- L398:77 ArrowFunction: `const failed = events.filter((e) => e.kind === "lead-wake-failed").sort((a, b) => b.ts - a.ts)[0];` => `() => undefined`
- L399:65 BooleanLiteral: `return failed != null && relaunchLeadAction(failed, events, false) != null;` => `true`

`frontend/app/view/agents/livetranscript.ts` `startTranscriptStream` (16 survivors):

- L45:9 ConditionalExpression: `if (!path || streams.has(id)) {` => `false`
- L45:9 LogicalOperator: `if (!path || streams.has(id)) {` => `!path && streams.has(id)`
- L53:18 LogicalOperator: `const isPi = agent?.toLowerCase() === "pi" || path.replace(/\\/g, "/").includes("/.pi/agent/sessions/");` => `agent?.toLowerCase() === "pi" && path.replace(/\\/g, "/").includes("/.pi/agent/sessions/")`
- L53:18 ConditionalExpression: `const isPi = agent?.toLowerCase() === "pi" || path.replace(/\\/g, "/").includes("/.pi/agent/sessions/");` => `false`
- L53:18 MethodExpression: `const isPi = agent?.toLowerCase() === "pi" || path.replace(/\\/g, "/").includes("/.pi/agent/sessions/");` => `agent?.toUpperCase()`
- L58:9 ObjectLiteral: `{ timeout: STREAM_TIMEOUT_MS }` => `{}`
- L65:25 BooleanLiteral: `cancelled = true;` => `false`
- L74:21 ConditionalExpression: `if (cancelled) {` => `false`
- L77:21 ConditionalExpression: `if (!chunk?.lines?.length) {` => `false`
- L84:55 ObjectLiteral: `globalStore.set(lastActivityByIdAtom, { ...globalStore.get(lastActivityByIdAtom), [id]: Date.now() });` => `{}`
- L86:21 ConditionalExpression: `if (tasks != null) {` => `true`
- L86:21 ConditionalExpression: `if (tasks != null) {` => `false`
- L86:21 EqualityOperator: `if (tasks != null) {` => `tasks == null`
- L92:19 BlockStatement: `} finally {` => `{}`
- L95:17 ConditionalExpression: `if (streams.get(id) === handle) {` => `false`
- L95:45 BlockStatement: `if (streams.get(id) === handle) {` => `{}`

`frontend/app/view/agents/memorymodel.ts` `repoName` (5 survivors):

- L59:25 MethodExpression: `const folderParts = folder.split(/[\\/]/).filter((s) => s !== "");` => `folder.split(/[\\/]/)`
- L59:61 ConditionalExpression: `const folderParts = folder.split(/[\\/]/).filter((s) => s !== "");` => `true`
- L62:31 Regex: `const segs = path.replace(/[\\/]+$/, "").split(/[\\/]/);` => `/[\\/]$/`
- L62:31 Regex: `const segs = path.replace(/[\\/]+$/, "").split(/[\\/]/);` => `/[^\\/]+$/`
- L63:31 EqualityOperator: `for (let i = segs.length; i > 0; i--) {` => `i >= 0`

`frontend/app/view/agents/modellabel.ts` `versionAfter` (6 survivors):

- L10:18 MethodExpression: `const rest = m.slice(m.indexOf(family) + family.length);` => `m`
- L10:26 ArithmeticOperator: `const rest = m.slice(m.indexOf(family) + family.length);` => `m.indexOf(family) - family.length`
- L12:9 ConditionalExpression: `if (!nums || nums.length === 0) {` => `false`
- L12:9 LogicalOperator: `if (!nums || nums.length === 0) {` => `!nums && nums.length === 0`
- L12:18 ConditionalExpression: `if (!nums || nums.length === 0) {` => `false`
- L17:26 EqualityOperator: `if (minor != null && minor.length <= 2) {` => `minor.length < 2`

`frontend/app/view/agents/opencodetranscriptprojection.ts` `projectOpencodeTranscript` (15 survivors):

- L61:36 ConditionalExpression: `if (rec.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `true`
- L61:68 ConditionalExpression: `if (rec.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `true`
- L61:68 MethodExpression: `if (rec.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `rec.text`
- L65:13 LogicalOperator: `if (rec.type === "assistant" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `rec.type === "assistant" || typeof rec.text === "string"`
- L65:13 ConditionalExpression: `if (rec.type === "assistant" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `true`
- L65:41 ConditionalExpression: `if (rec.type === "assistant" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `true`
- L65:73 ConditionalExpression: `if (rec.type === "assistant" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `true`
- L65:73 MethodExpression: `if (rec.type === "assistant" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `rec.text`
- L69:13 LogicalOperator: `if (rec.type === "tool" && typeof rec.name === "string") {` => `rec.type === "tool" || typeof rec.name === "string"`
- L69:13 ConditionalExpression: `if (rec.type === "tool" && typeof rec.name === "string") {` => `true`
- L69:36 ConditionalExpression: `if (rec.type === "tool" && typeof rec.name === "string") {` => `true`
- L70:27 ConditionalExpression: `const input = typeof rec.input === "string" ? rec.input : "";` => `true`
- L72:17 ConditionalExpression: `if (rec.name === "bash" && input) {` => `true`
- L72:17 LogicalOperator: `if (rec.name === "bash" && input) {` => `rec.name === "bash" || input`
- L72:17 ConditionalExpression: `if (rec.name === "bash" && input) {` => `true`

`frontend/app/view/agents/opencodetranscriptprojection.ts` `extractOpencodeTitle` (13 survivors):

- L92:13 LogicalOperator: `if (rec?.type === "session" && typeof rec.title === "string" && rec.title.trim() !== "") {` => `rec?.type === "session" || typeof rec.title === "string"`
- L92:13 ConditionalExpression: `if (rec?.type === "session" && typeof rec.title === "string" && rec.title.trim() !== "") {` => `true`
- L92:40 ConditionalExpression: `if (rec?.type === "session" && typeof rec.title === "string" && rec.title.trim() !== "") {` => `true`
- L92:73 ConditionalExpression: `if (rec?.type === "session" && typeof rec.title === "string" && rec.title.trim() !== "") {` => `true`
- L92:73 MethodExpression: `if (rec?.type === "session" && typeof rec.title === "string" && rec.title.trim() !== "") {` => `rec.title`
- L106:13 ConditionalExpression: `if (rec?.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `true`
- L106:13 LogicalOperator: `if (rec?.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `rec?.type === "user" && typeof rec.text === "string" || rec.text.trim() !== ""`
- L106:13 ConditionalExpression: `if (rec?.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `true`
- L106:13 ConditionalExpression: `if (rec?.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `true`
- L106:13 LogicalOperator: `if (rec?.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `rec?.type === "user" || typeof rec.text === "string"`
- L106:37 ConditionalExpression: `if (rec?.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `true`
- L106:69 ConditionalExpression: `if (rec?.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `true`
- L106:69 MethodExpression: `if (rec?.type === "user" && typeof rec.text === "string" && rec.text.trim() !== "") {` => `rec.text`

`frontend/app/view/agents/opencodetranscriptprojection.ts` `targetFor` (6 survivors):

- L26:9 ConditionalExpression: `if (name === "bash") {` => `false`
- L26:26 BlockStatement: `if (name === "bash") {` => `{}`
- L29:9 ConditionalExpression: `if (!input) {` => `false`
- L39:13 ConditionalExpression: `if (typeof args[key] === "string" && args[key]) {` => `true`
- L39:13 LogicalOperator: `if (typeof args[key] === "string" && args[key]) {` => `typeof args[key] === "string" || args[key]`
- L39:13 ConditionalExpression: `if (typeof args[key] === "string" && args[key]) {` => `true`

### Task 2: Kill the survivors in frontend/app/view/agents (pitranscriptprojection.ts to projectname.ts)

**Depends on:** none
**Files:** `frontend/app/view/agents/pitranscriptprojection.test.ts`, `frontend/app/view/agents/projectlabel.test.ts`, `frontend/app/view/agents/projectname.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/view/agents/pitranscriptprojection.ts` `targetFor` (20 survivors):

- L88:9 ConditionalExpression: `if (typeof args === "string") {` => `false`
- L91:9 ConditionalExpression: `if (args != null && typeof args === "object") {` => `true`
- L91:9 LogicalOperator: `if (args != null && typeof args === "object") {` => `args != null || typeof args === "object"`
- L91:9 ConditionalExpression: `if (args != null && typeof args === "object") {` => `true`
- L91:25 ConditionalExpression: `if (args != null && typeof args === "object") {` => `true`
- L93:46 ConditionalExpression: `if (typeof a.command === "string" && a.command.trim() !== "") {` => `true`
- L93:46 MethodExpression: `if (typeof a.command === "string" && a.command.trim() !== "") {` => `a.command`
- L94:20 MethodExpression: `return a.command.trim();` => `a.command`
- L96:13 ConditionalExpression: `if (typeof a.path === "string" && a.path !== "") {` => `false`
- L96:43 ConditionalExpression: `if (typeof a.path === "string" && a.path !== "") {` => `true`
- L96:43 EqualityOperator: `if (typeof a.path === "string" && a.path !== "") {` => `a.path === ""`
- L96:58 BlockStatement: `if (typeof a.path === "string" && a.path !== "") {` => `{}`
- L99:13 ConditionalExpression: `if (typeof a.pattern === "string" && a.pattern !== "") {` => `false`
- L102:46 ConditionalExpression: `if (typeof a.subject === "string" && a.subject !== "") {` => `true`
- L105:45 ConditionalExpression: `if (typeof a.taskId === "string" && a.taskId !== "") {` => `true`
- L108:13 ConditionalExpression: `if (Array.isArray(a.task_ids)) {` => `false`
- L111:13 ConditionalExpression: `if (typeof a.agent === "string" && a.agent !== "") {` => `true`
- L111:13 LogicalOperator: `if (typeof a.agent === "string" && a.agent !== "") {` => `typeof a.agent === "string" || a.agent !== ""`
- L111:13 ConditionalExpression: `if (typeof a.agent === "string" && a.agent !== "") {` => `true`
- L111:44 ConditionalExpression: `if (typeof a.agent === "string" && a.agent !== "") {` => `true`

`frontend/app/view/agents/pitranscriptprojection.ts` `applyToolResult` (19 survivors):

- L207:9 ConditionalExpression: `if (msg == null) {` => `false`
- L210:22 ConditionalExpression: `let toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";` => `true`
- L211:9 ConditionalExpression: `if (toolCallId === "" && Array.isArray(msg.content)) {` => `false`
- L211:9 ConditionalExpression: `if (toolCallId === "" && Array.isArray(msg.content)) {` => `true`
- L211:9 LogicalOperator: `if (toolCallId === "" && Array.isArray(msg.content)) {` => `toolCallId === "" || Array.isArray(msg.content)`
- L211:9 ConditionalExpression: `if (toolCallId === "" && Array.isArray(msg.content)) {` => `true`
- L211:9 EqualityOperator: `if (toolCallId === "" && Array.isArray(msg.content)) {` => `toolCallId !== ""`
- L219:9 ConditionalExpression: `if (toolCallId === "") {` => `false`
- L223:9 ConditionalExpression: `if (action == null) {` => `false`
- L236:52 ConditionalExpression: `action.summary = '${matches.length} match${matches.length === 1 ? "" : "es"}';` => `false`
- L237:16 LogicalOperator: `} else if (tool === "bash" && body) {` => `tool === "bash" || body`
- L237:16 ConditionalExpression: `} else if (tool === "bash" && body) {` => `true`
- L245:19 ConditionalExpression: `const resTs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;` => `true`
- L247:9 ConditionalExpression: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `true`
- L247:9 LogicalOperator: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `Number.isFinite(resTs) && Number.isFinite(useTs) || resTs >= useTs`
- L247:9 ConditionalExpression: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `true`
- L247:9 LogicalOperator: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `Number.isFinite(resTs) || Number.isFinite(useTs)`
- L247:61 ConditionalExpression: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `true`
- L247:61 EqualityOperator: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `resTs > useTs`

`frontend/app/view/agents/pitranscriptprojection.ts` `editDetailFor` (17 survivors):

- L140:9 ConditionalExpression: `if (args == null || typeof args !== "object") {` => `false`
- L140:9 LogicalOperator: `if (args == null || typeof args !== "object") {` => `args == null && typeof args !== "object"`
- L140:9 ConditionalExpression: `if (args == null || typeof args !== "object") {` => `false`
- L140:25 ConditionalExpression: `if (args == null || typeof args !== "object") {` => `false`
- L144:18 ConditionalExpression: `const path = typeof a.path === "string" ? a.path : "";` => `true`
- L145:9 LogicalOperator: `if (name === "write" && typeof a.content === "string") {` => `name === "write" || typeof a.content === "string"`
- L145:9 ConditionalExpression: `if (name === "write" && typeof a.content === "string") {` => `true`
- L145:29 ConditionalExpression: `if (name === "write" && typeof a.content === "string") {` => `true`
- L148:9 LogicalOperator: `if (name === "edit" && Array.isArray(a.edits)) {` => `name === "edit" || Array.isArray(a.edits)`
- L148:9 ConditionalExpression: `if (name === "edit" && Array.isArray(a.edits)) {` => `true`
- L149:23 MethodExpression: `const files = a.edits` => `a.edits`
- L152:24 ConditionalExpression: `return typeof ed.oldText === "string" && typeof ed.newText === "string";` => `true`
- L152:24 LogicalOperator: `return typeof ed.oldText === "string" && typeof ed.newText === "string";` => `typeof ed.oldText === "string" || typeof ed.newText === "string"`
- L152:24 ConditionalExpression: `return typeof ed.oldText === "string" && typeof ed.newText === "string";` => `true`
- L152:58 ConditionalExpression: `return typeof ed.oldText === "string" && typeof ed.newText === "string";` => `true`
- L155:13 ConditionalExpression: `if (files.length > 0) {` => `true`
- L155:13 EqualityOperator: `if (files.length > 0) {` => `files.length >= 0`

`frontend/app/view/agents/pitranscriptprojection.ts` `activeBranch` (16 survivors):

- L341:9 ConditionalExpression: `if (records.length === 0) {` => `false`
- L346:13 ConditionalExpression: `if (rec != null && typeof rec.id === "string" && rec.id !== "") {` => `true`
- L346:13 LogicalOperator: `if (rec != null && typeof rec.id === "string" && rec.id !== "") {` => `rec != null && typeof rec.id === "string" || rec.id !== ""`
- L346:13 ConditionalExpression: `if (rec != null && typeof rec.id === "string" && rec.id !== "") {` => `true`
- L346:13 LogicalOperator: `if (rec != null && typeof rec.id === "string" && rec.id !== "") {` => `rec != null || typeof rec.id === "string"`
- L346:13 ConditionalExpression: `if (rec != null && typeof rec.id === "string" && rec.id !== "") {` => `true`
- L346:28 ConditionalExpression: `if (rec != null && typeof rec.id === "string" && rec.id !== "") {` => `true`
- L346:58 ConditionalExpression: `if (rec != null && typeof rec.id === "string" && rec.id !== "") {` => `true`
- L350:29 ArrayDeclaration: `const chain: number[] = [];` => `["Stryker was here"]`
- L354:13 ConditionalExpression: `if (cur < 0 || onChain.has(cur)) {` => `false`
- L361:13 ConditionalExpression: `if (parentId == null || parentId === "") {` => `false`
- L361:13 LogicalOperator: `if (parentId == null || parentId === "") {` => `parentId == null && parentId === ""`
- L361:13 ConditionalExpression: `if (parentId == null || parentId === "") {` => `false`
- L361:33 ConditionalExpression: `if (parentId == null || parentId === "") {` => `false`
- L361:50 BlockStatement: `if (parentId == null || parentId === "") {` => `{}`
- L365:13 ConditionalExpression: `if (parent == null) {` => `false`

`frontend/app/view/agents/pitranscriptprojection.ts` `textBlocks` (12 survivors):

- L120:16 ConditionalExpression: `return content.trim() === "" ? [] : [content.trim()];` => `false`
- L120:16 MethodExpression: `return content.trim() === "" ? [] : [content.trim()];` => `content`
- L120:46 MethodExpression: `return content.trim() === "" ? [] : [content.trim()];` => `content`
- L122:9 ConditionalExpression: `if (!Array.isArray(content)) {` => `false`
- L127:13 LogicalOperator: `if (b != null && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {` => `b != null && b.type === "text" || typeof b.text === "string"`
- L127:13 ConditionalExpression: `if (b != null && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {` => `true`
- L127:13 LogicalOperator: `if (b != null && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {` => `b != null || b.type === "text"`
- L127:13 ConditionalExpression: `if (b != null && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {` => `true`
- L127:26 ConditionalExpression: `if (b != null && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {` => `true`
- L127:47 ConditionalExpression: `if (b != null && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {` => `true`
- L127:77 ConditionalExpression: `if (b != null && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {` => `true`
- L127:77 MethodExpression: `if (b != null && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {` => `b.text`

`frontend/app/view/agents/pitranscriptprojection.ts` `extractPiTitle` (12 survivors):

- L493:13 LogicalOperator: `if (rec?.type === "session_info" && typeof rec.name === "string" && rec.name.trim() !== "") {` => `rec?.type === "session_info" || typeof rec.name === "string"`
- L493:13 ConditionalExpression: `if (rec?.type === "session_info" && typeof rec.name === "string" && rec.name.trim() !== "") {` => `true`
- L493:45 ConditionalExpression: `if (rec?.type === "session_info" && typeof rec.name === "string" && rec.name.trim() !== "") {` => `true`
- L493:77 ConditionalExpression: `if (rec?.type === "session_info" && typeof rec.name === "string" && rec.name.trim() !== "") {` => `true`
- L493:77 MethodExpression: `if (rec?.type === "session_info" && typeof rec.name === "string" && rec.name.trim() !== "") {` => `rec.name`
- L494:21 MethodExpression: `title = rec.name.trim();` => `rec.name`
- L502:13 ConditionalExpression: `if (rec?.type === "message" && rec.message?.role === "user") {` => `true`
- L502:13 LogicalOperator: `if (rec?.type === "message" && rec.message?.role === "user") {` => `rec?.type === "message" || rec.message?.role === "user"`
- L502:13 ConditionalExpression: `if (rec?.type === "message" && rec.message?.role === "user") {` => `true`
- L502:40 ConditionalExpression: `if (rec?.type === "message" && rec.message?.role === "user") {` => `true`
- L504:17 ConditionalExpression: `if (!raw) {` => `false`
- L509:17 ConditionalExpression: `if (text) {` => `true`

`frontend/app/view/agents/pitranscriptprojection.ts` `toolResultFailed` (10 survivors):

- L258:33 ConditionalExpression: `if (msg.isError === true || msg.is_error === true) {` => `false`
- L258:50 BooleanLiteral: `if (msg.isError === true || msg.is_error === true) {` => `false`
- L261:9 ConditionalExpression: `if (Array.isArray(msg.content)) {` => `true`
- L261:9 ConditionalExpression: `if (Array.isArray(msg.content)) {` => `false`
- L261:37 BlockStatement: `if (Array.isArray(msg.content)) {` => `{}`
- L262:51 BlockStatement: `for (const b of msg.content as PiBlock[]) {` => `{}`
- L263:17 ConditionalExpression: `if (b?.type === "tool_result" && (b.isError === true || b.is_error === true)) {` => `false`
- L263:17 LogicalOperator: `if (b?.type === "tool_result" && (b.isError === true || b.is_error === true)) {` => `b?.type === "tool_result" || b.isError === true || b.is_error === true`
- L263:17 ConditionalExpression: `if (b?.type === "tool_result" && (b.isError === true || b.is_error === true)) {` => `true`
- L263:17 EqualityOperator: `if (b?.type === "tool_result" && (b.isError === true || b.is_error === true)) {` => `b?.type !== "tool_result"`

`frontend/app/view/agents/pitranscriptprojection.ts` `mapRecord` (7 survivors):

- L300:9 LogicalOperator: `if (rec == null || rec.type !== "message" || rec.message == null) {` => `(rec == null || rec.type !== "message") && rec.message == null`
- L300:9 ConditionalExpression: `if (rec == null || rec.type !== "message" || rec.message == null) {` => `false`
- L300:9 ConditionalExpression: `if (rec == null || rec.type !== "message" || rec.message == null) {` => `false`
- L300:9 LogicalOperator: `if (rec == null || rec.type !== "message" || rec.message == null) {` => `rec == null && rec.type !== "message"`
- L300:24 ConditionalExpression: `if (rec == null || rec.type !== "message" || rec.message == null) {` => `false`
- L300:50 ConditionalExpression: `if (rec == null || rec.type !== "message" || rec.message == null) {` => `false`
- L314:9 ConditionalExpression: `if (msg.role === "toolResult") {` => `true`

`frontend/app/view/agents/pitranscriptprojection.ts` `projectPiTranscript` (7 survivors):

- L387:17 ConditionalExpression: `if (typeof rec.summary === "string" && rec.summary.trim() !== "") {` => `true`
- L387:17 LogicalOperator: `if (typeof rec.summary === "string" && rec.summary.trim() !== "") {` => `typeof rec.summary === "string" || rec.summary.trim() !== ""`
- L387:17 ConditionalExpression: `if (typeof rec.summary === "string" && rec.summary.trim() !== "") {` => `true`
- L387:52 ConditionalExpression: `if (typeof rec.summary === "string" && rec.summary.trim() !== "") {` => `true`
- L387:52 MethodExpression: `if (typeof rec.summary === "string" && rec.summary.trim() !== "") {` => `rec.summary`
- L390:17 ConditionalExpression: `if (typeof rec.tokensBefore === "number") {` => `true`
- L400:13 ConditionalExpression: `if (e.kind === "action") {` => `true`

`frontend/app/view/agents/projectlabel.ts` `registeredProjectFor` (5 survivors):

- L25:9 ConditionalExpression: `if (!cwd) return "";` => `false`
- L28:19 UnaryOperator: `let bestLen = -1;` => `+1`
- L30:13 ConditionalExpression: `if (!pk?.path) continue;` => `false`
- L32:57 ConditionalExpression: `if ((want === p || want.startsWith(p + "/")) && p.length > bestLen) {` => `true`
- L32:57 EqualityOperator: `if ((want === p || want.startsWith(p + "/")) && p.length > bestLen) {` => `p.length >= bestLen`

`frontend/app/view/agents/projectlabel.ts` `channelProjectLabel` (5 survivors):

- L59:9 ConditionalExpression: `if (path !== "") {` => `true`
- L62:17 ConditionalExpression: `if (p?.path != null && normProjectPath(p.path) === want) {` => `true`
- L62:17 LogicalOperator: `if (p?.path != null && normProjectPath(p.path) === want) {` => `p?.path != null || normProjectPath(p.path) === want`
- L62:17 ConditionalExpression: `if (p?.path != null && normProjectPath(p.path) === want) {` => `true`
- L62:36 ConditionalExpression: `if (p?.path != null && normProjectPath(p.path) === want) {` => `true`

`frontend/app/view/agents/projectname.ts` `projectNameFromTranscriptPath` (8 survivors):

- L9:9 ConditionalExpression: `if (!path) {` => `false`
- L9:16 BlockStatement: `if (!path) {` => `{}`
- L12:19 MethodExpression: `const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);` => `path.replace(/\\/g, "/").split("/")`
- L14:9 EqualityOperator: `if (projIdx < 0 || projIdx + 1 >= parts.length) {` => `projIdx <= 0`
- L14:24 ConditionalExpression: `if (projIdx < 0 || projIdx + 1 >= parts.length) {` => `false`
- L14:24 EqualityOperator: `if (projIdx < 0 || projIdx + 1 >= parts.length) {` => `projIdx + 1 > parts.length`
- L14:24 ArithmeticOperator: `if (projIdx < 0 || projIdx + 1 >= parts.length) {` => `projIdx - 1`
- L17:18 MethodExpression: `const segs = parts[projIdx + 1].split("-").filter(Boolean);` => `parts[projIdx + 1].split("-")`

### Task 3: Kill the survivors in frontend/app/view/agents (radarstore.ts to sessionsarchivestore.ts)

**Depends on:** none
**Files:** `frontend/app/view/agents/radarstore.test.ts`, `frontend/app/view/agents/ratelimitstore.test.ts`, `frontend/app/view/agents/reviewmarks.test.ts`, `frontend/app/view/agents/runactions.test.ts`, `frontend/app/view/agents/runmodel.test.ts`, `frontend/app/view/agents/runrail.test.ts`, `frontend/app/view/agents/runtimeline.test.ts`, `frontend/app/view/agents/runusage.test.ts`, `frontend/app/view/agents/session-models/agentresumestore.test.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.test.ts`, `frontend/app/view/agents/sessionsarchivestore.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

These sources changed after the mutation run, so their line numbers can be off: `frontend/app/view/agents/session-models/sessionviewmodel.ts`. Find each survivor by its source text; one whose line no longer exists goes under Not reached with the reason.

`frontend/app/view/agents/radarstore.ts` `loadReports` (9 survivors):

- L128:9 ConditionalExpression: `if (loadingPaths.has(path)) {` => `false`
- L139:22 MethodExpression: `const list = (rtn.reports ?? []).slice().sort((a, b) => b.startedts - a.startedts);` => `(rtn.reports ?? []).slice()`
- L139:22 MethodExpression: `const list = (rtn.reports ?? []).slice().sort((a, b) => b.startedts - a.startedts);` => `rtn.reports ?? []`
- L139:55 ArrowFunction: `const list = (rtn.reports ?? []).slice().sort((a, b) => b.startedts - a.startedts);` => `() => undefined`
- L139:65 ArithmeticOperator: `const list = (rtn.reports ?? []).slice().sort((a, b) => b.startedts - a.startedts);` => `b.startedts + a.startedts`
- L141:13 ConditionalExpression: `if (list.length > 0) {` => `false`
- L141:30 BlockStatement: `if (list.length > 0) {` => `{}`
- L143:16 BlockStatement: `} else {` => `{}`
- L148:13 ConditionalExpression: `if (globalStore.get(radarScopeAtom)?.path === path) {` => `true`

`frontend/app/view/agents/ratelimitstore.ts` `readSavedRateLimits` (5 survivors):

- L40:13 ConditionalExpression: `if (!raw) {` => `false`
- L40:19 BlockStatement: `if (!raw) {` => `{}`
- L44:16 ConditionalExpression: `return parsed && typeof parsed === "object" ? (parsed as Record<string, SavedSnapshot>) : {};` => `true`
- L44:16 LogicalOperator: `return parsed && typeof parsed === "object" ? (parsed as Record<string, SavedSnapshot>) : {};` => `parsed || typeof parsed === "object"`
- L44:26 ConditionalExpression: `return parsed && typeof parsed === "object" ? (parsed as Record<string, SavedSnapshot>) : {};` => `true`

`frontend/app/view/agents/reviewmarks.ts` `parseStoredReviews` (5 survivors):

- L140:9 ConditionalExpression: `if (raw == null) {` => `false`
- L140:22 BlockStatement: `if (raw == null) {` => `{}`
- L146:17 BlockStatement: `} catch (e) {` => `{}`
- L150:9 ConditionalExpression: `if (!isObject(parsed)) {` => `false`
- L150:28 BlockStatement: `if (!isObject(parsed)) {` => `{}`

`frontend/app/view/agents/runactions.ts` `createRunPayload` (6 survivors):

- L85:27 ObjectLiteral: `...(route.model ? { model: route.model } : {}),` => `{}`
- L88:13 ConditionalExpression: `...(orchestrator && opts.parallelism ? { parallelism: opts.parallelism } : {}),` => `false`
- L89:13 ConditionalExpression: `...(orchestrator && opts.planPath ? { planpath: opts.planPath } : {}),` => `false`
- L89:45 ObjectLiteral: `...(orchestrator && opts.planPath ? { planpath: opts.planPath } : {}),` => `{}`
- L91:29 ConditionalExpression: `...(orchestrator && opts.reviewerPicks != null ? { reviewerpicks: opts.reviewerPicks } : {}),` => `true`
- L96:29 ConditionalExpression: `...(orchestrator && opts.autonomous != null ? { autonomous: opts.autonomous } : {}),` => `true`

`frontend/app/view/agents/runmodel.ts` `phaseThread` (19 survivors):

- L306:55 ConditionalExpression: `const startedFresh = phase.state !== "pending" && phase.state !== "skipped";` => `true`
- L308:24 ConditionalExpression: `const unreported = recorded.length > 0 && workers.length === 0;` => `true`
- L308:24 EqualityOperator: `const unreported = recorded.length > 0 && workers.length === 0;` => `recorded.length >= 0`
- L309:58 MethodExpression: `const starting = unreported && liveTabIds != null && recorded.some((id) => liveTabIds.has(id));` => `recorded.every(id => liveTabIds.has(id))`
- L316:22 ConditionalExpression: `showWorkers: phase.state === "running" && workers.length > 0 && !asker,` => `true`
- L316:22 LogicalOperator: `showWorkers: phase.state === "running" && workers.length > 0 && !asker,` => `phase.state === "running" || workers.length > 0`
- L316:22 ConditionalExpression: `showWorkers: phase.state === "running" && workers.length > 0 && !asker,` => `true`
- L316:51 ConditionalExpression: `showWorkers: phase.state === "running" && workers.length > 0 && !asker,` => `true`
- L316:51 EqualityOperator: `showWorkers: phase.state === "running" && workers.length > 0 && !asker,` => `workers.length >= 0`
- L318:23 ConditionalExpression: `showStarting: phase.state === "running" && starting,` => `true`
- L321:13 ConditionalExpression: `phase.state === "blocked" || phase.state === "failed" || (phase.state === "running" && recordedButGone),` => `false`
- L321:71 ConditionalExpression: `phase.state === "blocked" || phase.state === "failed" || (phase.state === "running" && recordedButGone),` => `true`
- L322:19 ConditionalExpression: `showShip: idx === phases.length - 1 && phase.state === "done" && run.status === "done",` => `true`
- L322:19 LogicalOperator: `showShip: idx === phases.length - 1 && phase.state === "done" && run.status === "done",` => `idx === phases.length - 1 && phase.state === "done" || run.status === "done"`
- L322:19 ConditionalExpression: `showShip: idx === phases.length - 1 && phase.state === "done" && run.status === "done",` => `true`
- L322:19 LogicalOperator: `showShip: idx === phases.length - 1 && phase.state === "done" && run.status === "done",` => `idx === phases.length - 1 || phase.state === "done"`
- L322:19 ConditionalExpression: `showShip: idx === phases.length - 1 && phase.state === "done" && run.status === "done",` => `true`
- L322:48 ConditionalExpression: `showShip: idx === phases.length - 1 && phase.state === "done" && run.status === "done",` => `true`
- L322:74 ConditionalExpression: `showShip: idx === phases.length - 1 && phase.state === "done" && run.status === "done",` => `true`

`frontend/app/view/agents/runmodel.ts` `reviewGate` (8 survivors):

- L152:13 LogicalOperator: `if (phases[i].state === "running" && phases[i].held) {` => `phases[i].state === "running" || phases[i].held`
- L152:13 ConditionalExpression: `if (phases[i].state === "running" && phases[i].held) {` => `true`
- L157:21 EqualityOperator: `for (let i = 0; i < phases.length; i++) {` => `i <= phases.length`
- L158:13 ConditionalExpression: `if (phases[i].gate && phases[i].state === "done") {` => `true`
- L158:13 LogicalOperator: `if (phases[i].gate && phases[i].state === "done") {` => `phases[i].gate || phases[i].state === "done"`
- L158:31 ConditionalExpression: `if (phases[i].gate && phases[i].state === "done") {` => `true`
- L160:17 ConditionalExpression: `if (!next || next.state === "pending") {` => `true`
- L160:17 BooleanLiteral: `if (!next || next.state === "pending") {` => `next`

`frontend/app/view/agents/runmodel.ts` `defaultRunId` (5 survivors):

- L207:9 ConditionalExpression: `if (list.length === 0) {` => `false`
- L207:28 BlockStatement: `if (list.length === 0) {` => `{}`
- L210:20 MethodExpression: `const sorted = [...list].sort((a, b) => b.createdts - a.createdts);` => `[...list]`
- L210:35 ArrowFunction: `const sorted = [...list].sort((a, b) => b.createdts - a.createdts);` => `() => undefined`
- L210:45 ArithmeticOperator: `const sorted = [...list].sort((a, b) => b.createdts - a.createdts);` => `b.createdts + a.createdts`

`frontend/app/view/agents/runrail.ts` `laneRow` (7 survivors):

- L87:21 ConditionalExpression: `const current = i === -1 ? tasks[tasks.length - 1] : tasks[i];` => `true`
- L90:22 ConditionalExpression: `const done = current.state === "done";` => `true`
- L100:23 MethodExpression: `const waits = (current.deps ?? []).filter((d) => byId.get(d)?.state !== "done");` => `current.deps ?? []`
- L100:58 ConditionalExpression: `const waits = (current.deps ?? []).filter((d) => byId.get(d)?.state !== "done");` => `true`
- L101:30 ConditionalExpression: `const hist = [prior, waits.length > 0 ? 'waits on ${waits.join(", ")}' : ""].filter(Boolean).join(" · ");` => `true`
- L101:30 EqualityOperator: `const hist = [prior, waits.length > 0 ? 'waits on ${waits.join(", ")}' : ""].filter(Boolean).join(" · ");` => `waits.length >= 0`
- L104:9 ConditionalExpression: `if (FAILING.has(current.state)) {` => `false`

`frontend/app/view/agents/runtimeline.ts` `eventText` (7 survivors):

- L189:19 MethodExpression: `: ['${task} handed to you', d?.note].filter(Boolean).join(" · ");` => `['${task} handed to you', d?.note]`
- L191:20 MethodExpression: `return ['${task} asked', d?.question].filter(Boolean).join(" · ");` => `['${task} asked', d?.question]`
- L195:20 MethodExpression: `return ['you told ${task}', d?.text?.replace(/\s+/g, " ")].filter(Boolean).join(" · ");` => `['you told ${task}', d?.text?.replace(/\s+/g, " ")]`
- L195:58 Regex: `return ['you told ${task}', d?.text?.replace(/\s+/g, " ")].filter(Boolean).join(" · ");` => `/\s/g`
- L201:9 ConditionalExpression: `case "task-review-failed":` => `case "task-review-failed":`
- L202:20 MethodExpression: `return ['${eventTitle(event)} · ${task}', d?.note?.replace(/\s+/g, " ")].filter(Boolean).join(" · ");` => `['${eventTitle(event)} · ${task}', d?.note?.replace(/\s+/g, " ")]`
- L202:20 ArrayDeclaration: `return ['${eventTitle(event)} · ${task}', d?.note?.replace(/\s+/g, " ")].filter(Boolean).join(" · ");` => `[]`

`frontend/app/view/agents/runusage.ts` `summarizeUsage` (6 survivors):

- L79:18 MethodExpression: `byModel: [...byModel]` => `[...byModel].filter(([, tokens]) => tokens > 0).map(([model, tokens]) => ({
  model,
  tokens
}))`
- L79:18 MethodExpression: `byModel: [...byModel]` => `[...byModel]`
- L80:37 ConditionalExpression: `.filter(([, tokens]) => tokens > 0)` => `true`
- L80:37 EqualityOperator: `.filter(([, tokens]) => tokens > 0)` => `tokens >= 0`
- L82:19 ArrowFunction: `.sort((a, b) => b.tokens - a.tokens),` => `() => undefined`
- L82:29 ArithmeticOperator: `.sort((a, b) => b.tokens - a.tokens),` => `b.tokens + a.tokens`

`frontend/app/view/agents/session-models/agentresumestore.ts` `persistResume` (20 survivors):

- L59:9 ConditionalExpression: `if (!shouldPersistResume(provider, globalStore.get(naRememberFlagsAtom))) {` => `false`
- L65:9 ConditionalExpression: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `false`
- L65:9 LogicalOperator: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `(!meta || meta["controller"] !== "cmd") && cmd !== "claude" && cmd !== "opencode" && cmd !== "pi"`
- L65:9 ConditionalExpression: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `false`
- L65:9 LogicalOperator: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `!meta && meta["controller"] !== "cmd"`
- L65:18 ConditionalExpression: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `false`
- L65:51 ConditionalExpression: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `false`
- L65:51 ConditionalExpression: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `true`
- L65:51 LogicalOperator: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `cmd !== "claude" || cmd !== "opencode"`
- L65:51 ConditionalExpression: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `true`
- L65:51 EqualityOperator: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `cmd === "claude"`
- L65:71 ConditionalExpression: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `true`
- L65:71 EqualityOperator: `if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {` => `cmd === "opencode"`
- L69:9 ConditionalExpression: `if (baseArgs == null) {` => `false`
- L74:22 ConditionalExpression: `const cacheKey = cmd === "pi" ? transcriptPath : sessionIdFromTranscript(transcriptPath);` => `true`
- L74:22 ConditionalExpression: `const cacheKey = cmd === "pi" ? transcriptPath : sessionIdFromTranscript(transcriptPath);` => `false`
- L74:22 EqualityOperator: `const cacheKey = cmd === "pi" ? transcriptPath : sessionIdFromTranscript(transcriptPath);` => `cmd !== "pi"`
- L79:9 ConditionalExpression: `cmd === "pi"` => `true`
- L84:21 LogicalOperator: `const curArgs = (meta["cmd:args"] as string[] | undefined) ?? [];` => `meta["cmd:args"] as string[] | undefined && []`
- L85:9 ConditionalExpression: `if (sameArgs(nextArgs, curArgs)) {` => `false`

`frontend/app/view/agents/session-models/agentresumestore.ts` `sameArgs` (7 survivors):

- L48:54 BlockStatement: `function sameArgs(a: string[], b: string[]): boolean {` => `{}`
- L49:12 ConditionalExpression: `return a.length === b.length && a.every((v, i) => v === b[i]);` => `false`
- L49:12 ConditionalExpression: `return a.length === b.length && a.every((v, i) => v === b[i]);` => `true`
- L49:12 EqualityOperator: `return a.length === b.length && a.every((v, i) => v === b[i]);` => `a.length !== b.length`
- L49:45 ArrowFunction: `return a.length === b.length && a.every((v, i) => v === b[i]);` => `() => undefined`
- L49:55 ConditionalExpression: `return a.length === b.length && a.every((v, i) => v === b[i]);` => `false`
- L49:55 EqualityOperator: `return a.length === b.length && a.every((v, i) => v === b[i]);` => `v !== b[i]`

`frontend/app/view/agents/session-models/sessionviewmodel.ts` `rowLabel` (9 survivors):

- L152:37 ConditionalExpression: `const custom = s.customLabel && s.customLabel.length > 0 ? s.customLabel : undefined;` => `true`
- L152:37 EqualityOperator: `const custom = s.customLabel && s.customLabel.length > 0 ? s.customLabel : undefined;` => `s.customLabel.length >= 0`
- L154:74 MethodExpression: `const project = s.projectLabel && s.projectLabel.trim().length > 0 ? s.projectLabel.trim() : undefined;` => `s.projectLabel`
- L155:30 ConditionalExpression: `const agent = s.agent && s.agent.length > 0 ? s.agent : s.name;` => `true`
- L155:30 EqualityOperator: `const agent = s.agent && s.agent.length > 0 ? s.agent : s.name;` => `s.agent.length >= 0`
- L156:49 ConditionalExpression: `const base = custom ?? title ?? project ?? (agent && agent.length > 0 ? agent : "session");` => `true`
- L156:49 LogicalOperator: `const base = custom ?? title ?? project ?? (agent && agent.length > 0 ? agent : "session");` => `agent || agent.length > 0`
- L156:58 ConditionalExpression: `const base = custom ?? title ?? project ?? (agent && agent.length > 0 ? agent : "session");` => `true`
- L156:58 EqualityOperator: `const base = custom ?? title ?? project ?? (agent && agent.length > 0 ? agent : "session");` => `agent.length >= 0`

`frontend/app/view/agents/session-models/sessionviewmodel.ts` `cwdToServiceLabel` (5 survivors):

- L217:33 Regex: `const trimmed = cwd.replace(/[\\/]+$/, "");` => `/[\\/]$/`
- L218:36 Regex: `const segments = trimmed.split(/[\\/]+/);` => `/[\\/]/`
- L220:12 LogicalOperator: `return last && last.length > 0 ? last : NO_CWD_LABEL;` => `last || last.length > 0`
- L220:20 ConditionalExpression: `return last && last.length > 0 ? last : NO_CWD_LABEL;` => `true`
- L220:20 EqualityOperator: `return last && last.length > 0 ? last : NO_CWD_LABEL;` => `last.length >= 0`

`frontend/app/view/agents/sessionsarchivestore.ts` `groupByRecency` (11 survivors):

- L106:24 ArrayDeclaration: `const today: T[] = [];` => `["Stryker was here"]`
- L107:26 ArrayDeclaration: `const earlier: T[] = [];` => `["Stryker was here"]`
- L111:20 EqualityOperator: `} else if (s.lastactivets >= startOfToday) {` => `s.lastactivets > startOfToday`
- L111:20 EqualityOperator: `} else if (s.lastactivets >= startOfToday) {` => `s.lastactivets < startOfToday`
- L117:18 ArrowFunction: `const desc = (a: T, b: T) => b.lastactivets - a.lastactivets;` => `() => undefined`
- L118:5 MethodExpression: `live.sort(desc);` => `live`
- L119:5 MethodExpression: `today.sort(desc);` => `today`
- L120:5 MethodExpression: `earlier.sort(desc);` => `earlier`
- L121:12 MethodExpression: `return (` => `[{
  key: "live",
  label: "Live now",
  items: live
}, {
  key: "today",
  label: "Today",
  items: today
}, `
- L127:21 ConditionalExpression: `).filter((g) => g.items.length > 0);` => `true`
- L127:21 EqualityOperator: `).filter((g) => g.items.length > 0);` => `g.items.length >= 0`

`frontend/app/view/agents/sessionsarchivestore.ts` `overlayLive` (5 survivors):

- L61:13 ConditionalExpression: `if (a.transcriptPath) {` => `true`
- L62:72 ConditionalExpression: `liveByPath.set(norm(a.transcriptPath), { id: a.id, asking: a.state === "asking" });` => `true`
- L68:47 ArrowFunction: `const events = live ? s.events.filter((e) => e.type !== "finished") : s.events;` => `() => undefined`
- L68:54 ConditionalExpression: `const events = live ? s.events.filter((e) => e.type !== "finished") : s.events;` => `false`
- L69:55 ConditionalExpression: `const needsAttention = live ? !!hit?.asking : s.status === "waiting";` => `true`

### Task 4: Kill the survivors in frontend/app/view/agents (sessionsruns.ts to shelltasks.ts)

**Depends on:** none
**Files:** `frontend/app/view/agents/sessionsruns.test.ts`, `frontend/app/view/agents/sessionusage.test.ts`, `frontend/app/view/agents/settingsmodel.test.ts`, `frontend/app/view/agents/setupmodel.test.ts`, `frontend/app/view/agents/shelltasks.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/view/agents/sessionsruns.ts` `runView` (31 survivors):

- L284:37 ArrowFunction: `tokens: sum(group.lead, (s) => s.tokenstotal),` => `() => undefined`
- L285:41 ArrowFunction: `durationMs: sum(group.lead, (s) => s.durationms),` => `() => undefined`
- L291:9 MethodExpression: `Object.keys(group.tasks)` => `Object.keys(group.tasks)`
- L299:20 ConditionalExpression: `label: task.label || task.id,` => `true`
- L299:20 ConditionalExpression: `label: task.label || task.id,` => `false`
- L299:20 LogicalOperator: `label: task.label || task.id,` => `task.label && task.id`
- L302:25 ConditionalExpression: `childRunId: task.runid || undefined,` => `true`
- L302:25 ConditionalExpression: `childRunId: task.runid || undefined,` => `false`
- L302:25 LogicalOperator: `childRunId: task.runid || undefined,` => `task.runid && undefined`
- L303:35 ArrowFunction: `tokens: sum(sessions, (s) => s.tokenstotal),` => `() => undefined`
- L304:39 ArrowFunction: `durationMs: sum(sessions, (s) => s.durationms),` => `() => undefined`
- L320:39 ArrowFunction: `durationMs: sum(sessions, (s) => s.durationms),` => `() => undefined`
- L324:58 ConditionalExpression: `const askText = askTask ? digest?.tasks?.find((t) => t.taskid === askTask.key)?.asksummary : undefined;` => `true`
- L328:18 ConditionalExpression: `project: basename(run?.projectpath) || lead?.projectname || "",` => `true`
- L328:18 ConditionalExpression: `project: basename(run?.projectpath) || lead?.projectname || "",` => `false`
- L328:18 LogicalOperator: `project: basename(run?.projectpath) || lead?.projectname || "",` => `(basename(run?.projectpath) || lead?.projectname) && ""`
- L328:18 ConditionalExpression: `project: basename(run?.projectpath) || lead?.projectname || "",` => `false`
- L328:18 LogicalOperator: `project: basename(run?.projectpath) || lead?.projectname || "",` => `basename(run?.projectpath) && lead?.projectname`
- L330:18 ConditionalExpression: `runtime: run?.runtime || lead?.runtime || "claude",` => `true`
- L330:18 ConditionalExpression: `runtime: run?.runtime || lead?.runtime || "claude",` => `false`
- L330:18 LogicalOperator: `runtime: run?.runtime || lead?.runtime || "claude",` => `(run?.runtime || lead?.runtime) && "claude"`
- L330:18 ConditionalExpression: `runtime: run?.runtime || lead?.runtime || "claude",` => `false`
- L330:18 LogicalOperator: `runtime: run?.runtime || lead?.runtime || "claude",` => `run?.runtime && lead?.runtime`
- L341:20 ConditionalExpression: `startedts: run?.createdts || Math.min(...group.sessions.map((s) => s.startedts || s.lastactivets)),` => `true`
- L341:20 ConditionalExpression: `startedts: run?.createdts || Math.min(...group.sessions.map((s) => s.startedts || s.lastactivets)),` => `false`
- L341:20 LogicalOperator: `startedts: run?.createdts || Math.min(...group.sessions.map((s) => s.startedts || s.lastactivets)),` => `run?.createdts && Math.min(...group.sessions.map(s => s.startedts || s.lastactivets))`
- L341:38 MethodExpression: `startedts: run?.createdts || Math.min(...group.sessions.map((s) => s.startedts || s.lastactivets)),` => `Math.max(...group.sessions.map(s => s.startedts || s.lastactivets))`
- L341:69 ArrowFunction: `startedts: run?.createdts || Math.min(...group.sessions.map((s) => s.startedts || s.lastactivets)),` => `() => undefined`
- L341:76 ConditionalExpression: `startedts: run?.createdts || Math.min(...group.sessions.map((s) => s.startedts || s.lastactivets)),` => `true`
- L341:76 ConditionalExpression: `startedts: run?.createdts || Math.min(...group.sessions.map((s) => s.startedts || s.lastactivets)),` => `false`
- L341:76 LogicalOperator: `startedts: run?.createdts || Math.min(...group.sessions.map((s) => s.startedts || s.lastactivets)),` => `s.startedts && s.lastactivets`

`frontend/app/view/agents/sessionsruns.ts` `leadStatus` (7 survivors):

- L209:13 ConditionalExpression: `if (lead.needsAttention) {` => `false`
- L212:25 ConditionalExpression: `const dagOpen = input.dag != null && input.dag.status !== "done" && input.dag.status !== "cancelled";` => `true`
- L212:46 ConditionalExpression: `const dagOpen = input.dag != null && input.dag.status !== "done" && input.dag.status !== "cancelled";` => `true`
- L212:77 ConditionalExpression: `const dagOpen = input.dag != null && input.dag.status !== "done" && input.dag.status !== "cancelled";` => `true`
- L213:16 ConditionalExpression: `return input.leadAtPrompt && dagOpen` => `true`
- L213:16 LogicalOperator: `return input.leadAtPrompt && dagOpen` => `input.leadAtPrompt || dagOpen`
- L215:15 ObjectLiteral: `: { key: "running", text: "working" };` => `{}`

`frontend/app/view/agents/sessionsruns.ts` `headStatus` (7 survivors):

- L256:9 ConditionalExpression: `if (failed > 0) {` => `false`
- L260:72 ConditionalExpression: `(m) => m.key !== LEAD_MEMBER && (m.status.key === "running" || m.status.key === "review")` => `false`
- L265:9 ConditionalExpression: `if (dag?.status === "cancelled") {` => `false`
- L268:9 ConditionalExpression: `if (live) {` => `false`
- L268:15 BlockStatement: `if (live) {` => `{}`
- L269:16 ObjectLiteral: `return { key: "running", text: dag ? "working" : "planning" };` => `{}`
- L271:43 ArithmeticOperator: `return { key: "done", text: formatAge(now - lastactivets) };` => `now + lastactivets`

`frontend/app/view/agents/sessionsruns.ts` `resumeLaunchOpts` (6 survivors):

- L379:9 ConditionalExpression: `s.runtime === "pi" && s.resumeargs?.length ? { startupArgs: s.resumeargs, resumePath: s.transcriptpath } : {};` => `true`
- L379:9 LogicalOperator: `s.runtime === "pi" && s.resumeargs?.length ? { startupArgs: s.resumeargs, resumePath: s.transcriptpath } : {};` => `s.runtime === "pi" || s.resumeargs?.length`
- L379:9 ConditionalExpression: `s.runtime === "pi" && s.resumeargs?.length ? { startupArgs: s.resumeargs, resumePath: s.transcriptpath } : {};` => `true`
- L385:22 ConditionalExpression: `projectName: s.projectname || "agent",` => `true`
- L385:22 ConditionalExpression: `projectName: s.projectname || "agent",` => `false`
- L385:22 LogicalOperator: `projectName: s.projectname || "agent",` => `s.projectname && "agent"`

`frontend/app/view/agents/sessionsruns.ts` `groupRunSessions` (5 survivors):

- L60:28 LogicalOperator: `channelId: s.channelid ?? "",` => `s.channelid && ""`
- L70:9 AssignmentOperator: `run.channelId ||= s.channelid ?? "";` => `run.channelId &&= s.channelid ?? ""`
- L70:27 LogicalOperator: `run.channelId ||= s.channelid ?? "";` => `s.channelid && ""`
- L78:20 ConditionalExpression: `} else if (s.taskid) {` => `true`
- L83:9 MethodExpression: `run.lead.sort(newestFirst);` => `run.lead`

`frontend/app/view/agents/sessionusage.ts` `aggregateSessionUsage` (22 survivors):

- L61:9 AssignmentOperator: `tok.reasoning += b.reasoning;` => `tok.reasoning -= b.reasoning`
- L66:9 AssignmentOperator: `spd.reasoning += sb.reasoning;` => `spd.reasoning -= sb.reasoning`
- L71:21 ArithmeticOperator: `m.tokens += b.input + b.output + b.reasoning + b.cacheread + b.cachecreate;` => `b.input + b.output + b.reasoning + b.cacheread - b.cachecreate`
- L71:21 ArithmeticOperator: `m.tokens += b.input + b.output + b.reasoning + b.cacheread + b.cachecreate;` => `b.input + b.output + b.reasoning - b.cacheread`
- L71:21 ArithmeticOperator: `m.tokens += b.input + b.output + b.reasoning + b.cacheread + b.cachecreate;` => `b.input + b.output - b.reasoning`
- L72:9 AssignmentOperator: `m.spend += sb.input + sb.output + sb.reasoning + sb.cacheRead + sb.cacheWrite;` => `m.spend -= sb.input + sb.output + sb.reasoning + sb.cacheRead + sb.cacheWrite`
- L72:20 ArithmeticOperator: `m.spend += sb.input + sb.output + sb.reasoning + sb.cacheRead + sb.cacheWrite;` => `sb.input + sb.output + sb.reasoning + sb.cacheRead - sb.cacheWrite`
- L72:20 ArithmeticOperator: `m.spend += sb.input + sb.output + sb.reasoning + sb.cacheRead + sb.cacheWrite;` => `sb.input + sb.output - sb.reasoning`
- L72:20 ArithmeticOperator: `m.spend += sb.input + sb.output + sb.reasoning + sb.cacheRead + sb.cacheWrite;` => `sb.input + sb.output + sb.reasoning - sb.cacheRead`
- L72:20 ArithmeticOperator: `m.spend += sb.input + sb.output + sb.reasoning + sb.cacheRead + sb.cacheWrite;` => `sb.input - sb.output`
- L75:9 AssignmentOperator: `m.classes.reasoning += b.reasoning;` => `m.classes.reasoning -= b.reasoning`
- L76:9 AssignmentOperator: `m.classes.cacheRead += b.cacheread;` => `m.classes.cacheRead -= b.cacheread`
- L77:9 AssignmentOperator: `m.classes.cacheWrite += b.cachecreate;` => `m.classes.cacheWrite -= b.cachecreate`
- L81:25 ArithmeticOperator: `const totalTokens = tok.input + tok.output + tok.reasoning + tok.cacheRead + tok.cacheWrite;` => `tok.input + tok.output - tok.reasoning`
- L82:27 ArithmeticOperator: `const totalSpendUsd = spd.input + spd.output + spd.reasoning + spd.cacheRead + spd.cacheWrite;` => `spd.input + spd.output - spd.reasoning`
- L97:62 EqualityOperator: `const topCostClass = CLASS_ORDER.reduce((top, c) => (spd[c] > spd[top] ? c : top), CLASS_ORDER[0]);` => `spd[c] >= spd[top]`
- L100:26 ConditionalExpression: `readCostPct: totalSpendUsd > 0 ? (spd.cacheRead / totalSpendUsd) * 100 : 0,` => `true`
- L100:26 ConditionalExpression: `readCostPct: totalSpendUsd > 0 ? (spd.cacheRead / totalSpendUsd) * 100 : 0,` => `false`
- L100:26 EqualityOperator: `readCostPct: totalSpendUsd > 0 ? (spd.cacheRead / totalSpendUsd) * 100 : 0,` => `totalSpendUsd >= 0`
- L100:26 EqualityOperator: `readCostPct: totalSpendUsd > 0 ? (spd.cacheRead / totalSpendUsd) * 100 : 0,` => `totalSpendUsd <= 0`
- L100:46 ArithmeticOperator: `readCostPct: totalSpendUsd > 0 ? (spd.cacheRead / totalSpendUsd) * 100 : 0,` => `spd.cacheRead / totalSpendUsd / 100`
- L100:47 ArithmeticOperator: `readCostPct: totalSpendUsd > 0 ? (spd.cacheRead / totalSpendUsd) * 100 : 0,` => `spd.cacheRead * totalSpendUsd`

`frontend/app/view/agents/settingsmodel.ts` `settingsSections` (17 survivors):

- L86:19 ArrayDeclaration: `rows: [` => `[]`
- L87:17 ObjectLiteral: `{` => `{}`
- L94:17 ObjectLiteral: `{` => `{}`
- L101:17 ObjectLiteral: `{` => `{}`
- L108:17 ObjectLiteral: `{` => `{}`
- L115:17 ObjectLiteral: `{` => `{}`
- L130:17 ObjectLiteral: `{` => `{}`
- L137:17 ObjectLiteral: `{` => `{}`
- L159:19 ArrayDeclaration: `rows: [` => `[]`
- L160:17 ObjectLiteral: `{` => `{}`
- L167:17 ObjectLiteral: `{` => `{}`
- L354:19 ArrayDeclaration: `rows: [],` => `["Stryker was here"]`
- L361:19 ArrayDeclaration: `rows: [` => `[]`
- L362:17 ObjectLiteral: `{ id: "about.app", title: "App version", desc: "This shell.", key: "tauri.conf.json" },` => `{}`
- L363:17 ObjectLiteral: `{` => `{}`
- L369:17 ObjectLiteral: `{` => `{}`
- L375:17 ObjectLiteral: `{ id: "about.platform", title: "Platform", desc: "Host the shell reported at boot.", key: "runtime" },` => `{}`

`frontend/app/view/agents/setupmodel.ts` `changedLineCount` (6 survivors):

- L92:13 ConditionalExpression: `if (left > 0) {` => `true`
- L92:13 EqualityOperator: `if (left > 0) {` => `left >= 0`
- L94:16 BlockStatement: `} else {` => `{}`
- L95:13 UpdateOperator: `added++;` => `added--`
- L99:39 BlockStatement: `for (const left of pool.values()) {` => `{}`
- L100:9 AssignmentOperator: `removed += left;` => `removed -= left`

`frontend/app/view/agents/shelltasks.ts` `startedTask` (16 survivors):

- L67:9 LogicalOperator: `if (typeof id !== "string" || id === "" || !Array.isArray(content)) {` => `(typeof id !== "string" || id === "") && !Array.isArray(content)`
- L67:9 ConditionalExpression: `if (typeof id !== "string" || id === "" || !Array.isArray(content)) {` => `false`
- L67:9 LogicalOperator: `if (typeof id !== "string" || id === "" || !Array.isArray(content)) {` => `typeof id !== "string" && id === ""`
- L67:9 ConditionalExpression: `if (typeof id !== "string" || id === "" || !Array.isArray(content)) {` => `false`
- L67:35 ConditionalExpression: `if (typeof id !== "string" || id === "" || !Array.isArray(content)) {` => `false`
- L70:45 ConditionalExpression: `const result = content.find((b: any) => b?.type === "tool_result");` => `true`
- L72:21 ConditionalExpression: `const command = typeof input.command === "string" ? input.command : "";` => `true`
- L74:50 ConditionalExpression: `typeof input.description === "string" && input.description.trim() !== ""` => `true`
- L74:50 MethodExpression: `typeof input.description === "string" && input.description.trim() !== ""` => `input.description`
- L75:15 MethodExpression: `? input.description.trim()` => `input.description`
- L78:33 ConditionalExpression: `redirectTarget(command, typeof rec.cwd === "string" ? rec.cwd : undefined) ??` => `true`
- L78:33 EqualityOperator: `redirectTarget(command, typeof rec.cwd === "string" ? rec.cwd : undefined) ??` => `typeof rec.cwd !== "string"`
- L78:33 ConditionalExpression: `redirectTarget(command, typeof rec.cwd === "string" ? rec.cwd : undefined) ??` => `false`
- L79:9 Regex: `/Output is being written to: (.+?)\.(?:\s|$)/.exec(toolResultText(result?.content))?.[1];` => `/Output is being written to: (.+?)\.(?:\s)/`
- L80:16 ConditionalExpression: `const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;` => `true`
- L84:13 ConditionalExpression: `...(command !== "" ? { command } : {}),` => `true`

`frontend/app/view/agents/shelltasks.ts` `extractShellTasks` (11 survivors):

- L167:17 BlockStatement: `} catch {` => `{}`
- L170:28 ConditionalExpression: `if (rec == null || typeof rec !== "object") {` => `false`
- L175:21 ConditionalExpression: `if (block?.type === "tool_use" && typeof block.id === "string") {` => `true`
- L175:21 LogicalOperator: `if (block?.type === "tool_use" && typeof block.id === "string") {` => `block?.type === "tool_use" || typeof block.id === "string"`
- L175:21 ConditionalExpression: `if (block?.type === "tool_use" && typeof block.id === "string") {` => `true`
- L175:51 ConditionalExpression: `if (block?.type === "tool_use" && typeof block.id === "string") {` => `true`
- L183:27 ConditionalExpression: `const stoppedId = rec.type === "user" ? rec?.toolUseResult?.task_id : undefined;` => `true`
- L184:13 LogicalOperator: `if (typeof stoppedId === "string" && tasks.has(stoppedId)) {` => `typeof stoppedId === "string" || tasks.has(stoppedId)`
- L184:13 ConditionalExpression: `if (typeof stoppedId === "string" && tasks.has(stoppedId)) {` => `true`
- L188:25 ConditionalExpression: `const started = rec.type === "user" ? startedTask(rec, toolUses) : null;` => `true`
- L196:67 ArrayDeclaration: `for (const id of content != null ? finishedIds(content) : []) {` => `["Stryker was here"]`

`frontend/app/view/agents/shelltasks.ts` `notificationContent` (5 survivors):

- L145:9 ConditionalExpression: `if (rec.type === "queue-operation" && rec.operation === "enqueue" && typeof rec.content === "string") {` => `true`
- L145:74 ConditionalExpression: `if (rec.type === "queue-operation" && rec.operation === "enqueue" && typeof rec.content === "string") {` => `true`
- L148:9 LogicalOperator: `if (rec.type === "user" && typeof rec?.message?.content === "string") {` => `rec.type === "user" || typeof rec?.message?.content === "string"`
- L148:9 ConditionalExpression: `if (rec.type === "user" && typeof rec?.message?.content === "string") {` => `true`
- L148:32 ConditionalExpression: `if (rec.type === "user" && typeof rec?.message?.content === "string") {` => `true`

`frontend/app/view/agents/shelltasks.ts` `finishedIds` (5 survivors):

- L36:16 ArrayDeclaration: `return [];` => `["Stryker was here"]`
- L42:20 Regex: `const listed = /Task ids: ([^]*)$/.exec(tag(content, "summary") ?? "")?.[1];` => `/Task ids: ([^]*)/`
- L44:9 MethodExpression: `listed` => `listed?.split(/[,\s]+/).map(s => s.replace(/\.$/, ""))`
- L45:21 Regex: `?.split(/[,\s]+/)` => `/[,\s]/`
- L46:35 Regex: `.map((s) => s.replace(/\.$/, ""))` => `/\./`
