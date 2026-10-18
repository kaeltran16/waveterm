# Mutation survivors, wave 4 of 5: fix the tests that miss behaviour

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

### Task 1: Kill the survivors in frontend/app/view/agents (shelltasksstore.ts to transcriptusagestore.ts)

**Depends on:** none
**Files:** `frontend/app/view/agents/shelltasksstore.test.ts`, `frontend/app/view/agents/skillsmatrix.test.ts`, `frontend/app/view/agents/storagemodel.test.ts`, `frontend/app/view/agents/storagestore.test.ts`, `frontend/app/view/agents/subagentcorrelate.test.ts`, `frontend/app/view/agents/tooldetail.test.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/transcriptusagestore.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/view/agents/shelltasksstore.ts` `refreshShellTasks` (6 survivors):

- L58:17 ArithmeticOperator: `const seq = (loadSeq.get(id) ?? 0) + 1;` => `(loadSeq.get(id) ?? 0) - 1`
- L61:9 ConditionalExpression: `if (!transcriptPath) {` => `false`
- L67:73 ObjectLiteral: `const tr = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {` => `{}`
- L71:13 ConditionalExpression: `if (loadSeq.get(id) !== seq) {` => `false`
- L74:39 LogicalOperator: `setList(id, extractShellTasks(tr.lines ?? []));` => `tr.lines && []`
- L79:13 ConditionalExpression: `if (loadSeq.get(id) === seq) {` => `true`

`frontend/app/view/agents/skillsmatrix.ts` `skillGroups` (10 survivors):

- L224:31 LogicalOperator: `const colOrder = new Map((data.columns ?? []).map((c, i) => [c.runtime, i]));` => `data.columns && []`
- L224:65 ArrayDeclaration: `const colOrder = new Map((data.columns ?? []).map((c, i) => [c.runtime, i]));` => `[]`
- L235:13 ConditionalExpression: `if (g.kind === "same") {` => `true`
- L238:13 ConditionalExpression: `if (g.kind === "only") {` => `false`
- L238:32 BlockStatement: `if (g.kind === "only") {` => `{}`
- L239:27 LogicalOperator: `return [kind, colOrder.get(first.copies[0].runtime) ?? 0];` => `colOrder.get(first.copies[0].runtime) && 0`
- L244:26 BlockStatement: `for (const g of out) {` => `{}`
- L245:9 MethodExpression: `g.rows.sort((a, b) => a.name.localeCompare(b.name));` => `g.rows`
- L245:21 ArrowFunction: `g.rows.sort((a, b) => a.name.localeCompare(b.name));` => `() => undefined`
- L250:27 ArithmeticOperator: `return ka - kb || sa - sb;` => `sa + sb`

`frontend/app/view/agents/skillsmatrix.ts` `unmanagedByName` (8 survivors):

- L65:28 LogicalOperator: `const order = new Map((data.columns ?? []).map((c, i) => [c.runtime, i]));` => `data.columns && []`
- L65:62 ArrayDeclaration: `const order = new Map((data.columns ?? []).map((c, i) => [c.runtime, i]));` => `[]`
- L80:40 BlockStatement: `for (const copies of out.values()) {` => `{}`
- L81:9 MethodExpression: `copies.sort((a, b) => (order.get(a.runtime) ?? 0) - (order.get(b.runtime) ?? 0));` => `copies`
- L81:21 ArrowFunction: `copies.sort((a, b) => (order.get(a.runtime) ?? 0) - (order.get(b.runtime) ?? 0));` => `() => undefined`
- L81:31 ArithmeticOperator: `copies.sort((a, b) => (order.get(a.runtime) ?? 0) - (order.get(b.runtime) ?? 0));` => `(order.get(a.runtime) ?? 0) + (order.get(b.runtime) ?? 0)`
- L81:32 LogicalOperator: `copies.sort((a, b) => (order.get(a.runtime) ?? 0) - (order.get(b.runtime) ?? 0));` => `order.get(a.runtime) && 0`
- L81:62 LogicalOperator: `copies.sort((a, b) => (order.get(a.runtime) ?? 0) - (order.get(b.runtime) ?? 0));` => `order.get(b.runtime) && 0`

`frontend/app/view/agents/skillsmatrix.ts` `managedCell` (5 survivors):

- L102:49 ArrayDeclaration: `const over = skill.deltas?.[col.runtime] ?? [];` => `["Stryker was here"]`
- L103:19 ConditionalExpression: `const title = over.length > 0 ? 'Overrides ${over.join(", ")}' : undefined;` => `true`
- L103:19 ConditionalExpression: `const title = over.length > 0 ? 'Overrides ${over.join(", ")}' : undefined;` => `false`
- L103:19 EqualityOperator: `const title = over.length > 0 ? 'Overrides ${over.join(", ")}' : undefined;` => `over.length >= 0`
- L103:19 EqualityOperator: `const title = over.length > 0 ? 'Overrides ${over.join(", ")}' : undefined;` => `over.length <= 0`

`frontend/app/view/agents/storagemodel.ts` `kindLine` (7 survivors):

- L147:29 LogicalOperator: `return treeRole(it.suffix ?? "") + gitState(it);` => `it.suffix && ""`
- L149:17 ConditionalExpression: `if (!it.hasgit) {` => `false`
- L156:17 LogicalOperator: `if (it.runlandstate === "held" && it.runlanddismissed) {` => `it.runlandstate === "held" || it.runlanddismissed`
- L156:17 ConditionalExpression: `if (it.runlandstate === "held" && it.runlanddismissed) {` => `true`
- L163:40 LogicalOperator: `return 'Final build slot ${it.slot ?? 0} · warm cargo target';` => `it.slot && 0`
- L164:9 ConditionalExpression: `case "finalstores":` => `case "finalstores":`
- L169:20 ConditionalExpression: `return it.harness === "pi" ? "pi sessions and config" : "Claude Code session transcripts";` => `true`

`frontend/app/view/agents/storagemodel.ts` `sorted` (6 survivors):

- L317:16 MethodExpression: `return list.sort((a, b) => b.size - a.size);` => `list`
- L317:26 ArrowFunction: `return list.sort((a, b) => b.size - a.size);` => `() => undefined`
- L317:36 ArithmeticOperator: `return list.sort((a, b) => b.size - a.size);` => `b.size + a.size`
- L319:9 ConditionalExpression: `if (group === "inuse") {` => `false`
- L319:28 BlockStatement: `if (group === "inuse") {` => `{}`
- L320:16 MethodExpression: `return list.sort(newest);` => `list`

`frontend/app/view/agents/storagemodel.ts` `ownerMeta` (5 survivors):

- L211:9 ConditionalExpression: `case "finalstores":` => `case "finalstores":`
- L213:9 ConditionalExpression: `case "finalshots":` => `case "finalshots":`
- L215:9 ConditionalExpression: `case "transcripts":` => `case "transcripts":`
- L221:16 ConditionalExpression: `} else if (it.runid) {` => `true`
- L224:12 MethodExpression: `return parts.filter(Boolean).join(" · ");` => `parts`

`frontend/app/view/agents/storagemodel.ts` `loses` (5 survivors):

- L231:9 ConditionalExpression: `if (it.clearstate === "skipped") {` => `false`
- L239:46 LogicalOperator: `return 'The next Final on slot ${it.slot ?? 0} builds the app cold';` => `it.slot && 0`
- L240:9 ConditionalExpression: `case "transcripts":` => `case "transcripts":`
- L245:9 ConditionalExpression: `if (it.skip === "unreadable") {` => `false`
- L252:9 ConditionalExpression: `if (it.dirty) {` => `false`

`frontend/app/view/agents/storagemodel.ts` `deletePlan` (5 survivors):

- L426:23 LogicalOperator: `const hasFolder = item.kind !== "branch" && !!item.path;` => `item.kind !== "branch" || !!item.path`
- L426:23 ConditionalExpression: `const hasFolder = item.kind !== "branch" && !!item.path;` => `true`
- L433:89 BooleanLiteral: `let lead: StorageText[] = [{ text: "Deletes the branch " }, { text: branch, strong: true }];` => `false`
- L438:13 ConditionalExpression: `if (branch) {` => `true`
- L446:17 ConditionalExpression: `only === 1` => `false`

`frontend/app/view/agents/storagestore.ts` `loadStorage` (6 survivors):

- L53:9 ConditionalExpression: `if (fixture) {` => `false`
- L56:16 BooleanLiteral: `inFlight = true;` => `false`
- L59:23 BooleanLiteral: `loadFailing = false;` => `true`
- L65:13 ConditionalExpression: `if (!loadFailing && !fixture) {` => `true`
- L65:13 LogicalOperator: `if (!loadFailing && !fixture) {` => `!loadFailing || !fixture`
- L68:23 BooleanLiteral: `loadFailing = true;` => `false`

`frontend/app/view/agents/subagentcorrelate.ts` `firstLineLabel` (7 survivors):

- L24:18 MethodExpression: `const line = prompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";` => `prompt.split("\n").find(l => l.trim() !== "")`
- L24:49 ConditionalExpression: `const line = prompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";` => `true`
- L24:49 MethodExpression: `const line = prompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";` => `l`
- L25:12 ConditionalExpression: `return line.length > FALLBACK_LABEL_MAX ? line.slice(0, FALLBACK_LABEL_MAX) : line;` => `true`
- L25:12 ConditionalExpression: `return line.length > FALLBACK_LABEL_MAX ? line.slice(0, FALLBACK_LABEL_MAX) : line;` => `false`
- L25:12 EqualityOperator: `return line.length > FALLBACK_LABEL_MAX ? line.slice(0, FALLBACK_LABEL_MAX) : line;` => `line.length >= FALLBACK_LABEL_MAX`
- L25:12 EqualityOperator: `return line.length > FALLBACK_LABEL_MAX ? line.slice(0, FALLBACK_LABEL_MAX) : line;` => `line.length <= FALLBACK_LABEL_MAX`

`frontend/app/view/agents/tooldetail.ts` `askQuestions` (9 survivors):

- L55:12 MethodExpression: `return raw` => `raw`
- L56:29 ConditionalExpression: `.filter((q: any) => typeof q?.question === "string")` => `true`
- L59:17 ConditionalExpression: `...(typeof q.header === "string" && q.header !== "" ? { header: q.header } : {}),` => `true`
- L59:17 LogicalOperator: `...(typeof q.header === "string" && q.header !== "" ? { header: q.header } : {}),` => `typeof q.header === "string" || q.header !== ""`
- L59:17 ConditionalExpression: `...(typeof q.header === "string" && q.header !== "" ? { header: q.header } : {}),` => `true`
- L59:49 ConditionalExpression: `...(typeof q.header === "string" && q.header !== "" ? { header: q.header } : {}),` => `true`
- L60:22 MethodExpression: `options: (Array.isArray(q.options) ? q.options : [])` => `Array.isArray(q.options) ? q.options : []`
- L61:37 ConditionalExpression: `.filter((o: any) => typeof o?.label === "string")` => `true`
- L64:25 ConditionalExpression: `...(typeof o.description === "string" && o.description !== ""` => `true`

`frontend/app/view/agents/tooldetail.ts` `answerAsk` (6 survivors):

- L93:13 ConditionalExpression: `if (typeof answer !== "string" || answer === "") {` => `false`
- L93:13 LogicalOperator: `if (typeof answer !== "string" || answer === "") {` => `typeof answer !== "string" && answer === ""`
- L93:13 ConditionalExpression: `if (typeof answer !== "string" || answer === "") {` => `false`
- L93:43 ConditionalExpression: `if (typeof answer !== "string" || answer === "") {` => `false`
- L105:9 ConditionalExpression: `if (given.length === 0) {` => `false`
- L111:12 EqualityOperator: `return given[0].length > ASK_SUMMARY_MAX ? given[0].slice(0, ASK_SUMMARY_MAX - 1) + "…" : given[0];` => `given[0].length >= ASK_SUMMARY_MAX`

`frontend/app/view/agents/tooldetail.ts` `toolResultText` (5 survivors):

- L13:16 MethodExpression: `return content` => `content`
- L14:33 ConditionalExpression: `.filter((b: any) => b?.type === "text" && typeof b.text === "string")` => `true`
- L14:33 LogicalOperator: `.filter((b: any) => b?.type === "text" && typeof b.text === "string")` => `b?.type === "text" || typeof b.text === "string"`
- L14:33 ConditionalExpression: `.filter((b: any) => b?.type === "text" && typeof b.text === "string")` => `true`
- L14:55 ConditionalExpression: `.filter((b: any) => b?.type === "text" && typeof b.text === "string")` => `true`

`frontend/app/view/agents/transcriptprojection.ts` `extractSubagentSpawns` (11 survivors):

- L364:13 ConditionalExpression: `if (!Array.isArray(content)) {` => `false`
- L369:17 ConditionalExpression: `block?.type === "tool_use" &&` => `true`
- L370:43 ConditionalExpression: `(block.name === "Task" || block.name === "Agent") &&` => `false`
- L371:17 ConditionalExpression: `typeof block.id === "string"` => `true`
- L376:35 ConditionalExpression: `subagentType: typeof input.subagent_type === "string" ? input.subagent_type : "",` => `true`
- L377:29 ConditionalExpression: `prompt: typeof input.prompt === "string" ? input.prompt : "",` => `true`
- L382:24 ConditionalExpression: `} else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {` => `true`
- L382:24 ConditionalExpression: `} else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {` => `true`
- L382:24 LogicalOperator: `} else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {` => `block?.type === "tool_result" || typeof block.tool_use_id === "string"`
- L382:57 ConditionalExpression: `} else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {` => `true`
- L384:21 ConditionalExpression: `if (s) {` => `true`

`frontend/app/view/agents/transcriptprojection.ts` `extractTasks` (10 survivors):

- L298:17 BlockStatement: `} catch {` => `{}`
- L301:13 LogicalOperator: `if (rec?.type !== "assistant" || !Array.isArray(rec?.message?.content)) {` => `rec?.type !== "assistant" && !Array.isArray(rec?.message?.content)`
- L301:13 ConditionalExpression: `if (rec?.type !== "assistant" || !Array.isArray(rec?.message?.content)) {` => `false`
- L301:13 ConditionalExpression: `if (rec?.type !== "assistant" || !Array.isArray(rec?.message?.content)) {` => `false`
- L305:17 ConditionalExpression: `if (block?.type === "tool_use" && block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {` => `true`
- L305:17 LogicalOperator: `if (block?.type === "tool_use" && block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {` => `block?.type === "tool_use" && block.name === "TodoWrite" || Array.isArray(block.input?.todos)`
- L305:17 ConditionalExpression: `if (block?.type === "tool_use" && block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {` => `true`
- L305:17 LogicalOperator: `if (block?.type === "tool_use" && block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {` => `block?.type === "tool_use" || block.name === "TodoWrite"`
- L305:17 ConditionalExpression: `if (block?.type === "tool_use" && block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {` => `true`
- L305:47 ConditionalExpression: `if (block?.type === "tool_use" && block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {` => `true`

`frontend/app/view/agents/transcriptprojection.ts` `extractAiTitle` (7 survivors):

- L332:17 BlockStatement: `} catch {` => `{}`
- L335:13 ConditionalExpression: `if (rec?.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim() !== "") {` => `true`
- L335:13 LogicalOperator: `if (rec?.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim() !== "") {` => `rec?.type === "ai-title" || typeof rec.aiTitle === "string"`
- L335:13 ConditionalExpression: `if (rec?.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim() !== "") {` => `true`
- L335:41 ConditionalExpression: `if (rec?.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim() !== "") {` => `true`
- L335:76 ConditionalExpression: `if (rec?.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim() !== "") {` => `true`
- L335:76 MethodExpression: `if (rec?.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim() !== "") {` => `rec.aiTitle`

`frontend/app/view/agents/transcriptusagestore.ts` `loadSessionUsage` (6 survivors):

- L31:9 ConditionalExpression: `if (!transcriptPath) {` => `false`
- L31:26 BlockStatement: `if (!transcriptPath) {` => `{}`
- L39:74 ObjectLiteral: `const rtn = await RpcApi.GetTranscriptUsageCommand(TabRpcClient, { path: transcriptPath });` => `{}`
- L40:13 ConditionalExpression: `if (current.id === id) {` => `true`
- L41:69 LogicalOperator: `globalStore.set(sessionUsageAtom, aggregateSessionUsage(rtn.buckets ?? []));` => `rtn.buckets && []`
- L45:13 ConditionalExpression: `if (current.id === id && !opts?.silent) {` => `true`

### Task 2: Kill the survivors in frontend/app/view/agents (usageattribution.ts to weeklyforecast.ts)

**Depends on:** none
**Files:** `frontend/app/view/agents/usageattribution.test.ts`, `frontend/app/view/agents/usagestats.test.ts`, `frontend/app/view/agents/usagestore.test.ts`, `frontend/app/view/agents/weeklyforecast.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/view/agents/usageattribution.ts` `itemRow` (10 survivors):

- L506:24 ConditionalExpression: `withProject && it.projectLabel !== "" ? [it.projectLabel, KIND_LABEL[it.kind]] : [KIND_LABEL[it.kind]];` => `true`
- L507:9 LogicalOperator: `if (it.kind !== "session" && it.sessions.length > 1) {` => `it.kind !== "session" || it.sessions.length > 1`
- L507:9 ConditionalExpression: `if (it.kind !== "session" && it.sessions.length > 1) {` => `true`
- L507:34 ConditionalExpression: `if (it.kind !== "session" && it.sessions.length > 1) {` => `true`
- L507:34 EqualityOperator: `if (it.kind !== "session" && it.sessions.length > 1) {` => `it.sessions.length >= 1`
- L510:9 ConditionalExpression: `if (attr.harnesses.length > 1) {` => `true`
- L510:9 EqualityOperator: `if (attr.harnesses.length > 1) {` => `attr.harnesses.length >= 1`
- L517:16 ConditionalExpression: `isRun: it.kind !== "session",` => `true`
- L517:16 ConditionalExpression: `isRun: it.kind !== "session",` => `false`
- L517:16 EqualityOperator: `isRun: it.kind !== "session",` => `it.kind === "session"`

`frontend/app/view/agents/usageattribution.ts` `makeItem` (9 survivors):

- L212:22 MethodExpression: `const sessions = members.map((m) => m.session).sort(bySpend);` => `members.map(m => m.session)`
- L216:32 ArrowFunction: `const lead = sessions.find((s) => s.role === "lead") ?? sessions[0];` => `() => undefined`
- L216:39 ConditionalExpression: `const lead = sessions.find((s) => s.role === "lead") ?? sessions[0];` => `true`
- L216:39 ConditionalExpression: `const lead = sessions.find((s) => s.role === "lead") ?? sessions[0];` => `false`
- L216:39 EqualityOperator: `const lead = sessions.find((s) => s.role === "lead") ?? sessions[0];` => `s.role !== "lead"`
- L223:23 ConditionalExpression: `projectLabel: project === "" ? "" : folderName(project),` => `false`
- L227:20 ArrayDeclaration: `harnesses: [...new Set(sessions.map((s) => s.harness))],` => `[]`
- L227:45 ArrowFunction: `harnesses: [...new Set(sessions.map((s) => s.harness))],` => `() => undefined`
- L228:35 ArrowFunction: `buckets: sessions.flatMap((s) => s.buckets),` => `() => undefined`

`frontend/app/view/agents/usageattribution.ts` `buildAttribution` (9 survivors):

- L241:13 ConditionalExpression: `if (held) {` => `false`
- L251:13 ConditionalExpression: `if (amount.tokens === 0 && !amount.reportedCostUsd) {` => `false`
- L262:19 LogicalOperator: `role: meta?.role ?? "",` => `meta?.role && ""`
- L290:33 MethodExpression: `const all: ProjectUsage[] = [...byProject]` => `[...byProject].map(([key, held]) => {
  const amount = sumAmounts(held);
  return {
    key,
    label: folder`
- L297:27 ConditionalExpression: `sharePct: total.spendUsd > 0 ? (amount.spendUsd / total.spendUsd) * 100 : 0,` => `true`
- L297:27 EqualityOperator: `sharePct: total.spendUsd > 0 ? (amount.spendUsd / total.spendUsd) * 100 : 0,` => `total.spendUsd >= 0`
- L303:64 ArithmeticOperator: `const qualifies = (p: ProjectUsage) => p.spendUsd * 100 >= total.spendUsd * PROJECT_MIN_SHARE_PCT;` => `total.spendUsd / PROJECT_MIN_SHARE_PCT`
- L317:20 ArrayDeclaration: `harnesses: [...new Set(items.flatMap((it) => it.harnesses))],` => `[]`
- L317:46 ArrowFunction: `harnesses: [...new Set(items.flatMap((it) => it.harnesses))],` => `() => undefined`

`frontend/app/view/agents/usageattribution.ts` `listPage` (8 survivors):

- L577:17 ConditionalExpression: `const top = shown.length > 0 ? Math.max(shown[0].cost, 0.0001) : 1;` => `true`
- L577:17 ConditionalExpression: `const top = shown.length > 0 ? Math.max(shown[0].cost, 0.0001) : 1;` => `false`
- L577:17 EqualityOperator: `const top = shown.length > 0 ? Math.max(shown[0].cost, 0.0001) : 1;` => `shown.length >= 0`
- L577:17 EqualityOperator: `const top = shown.length > 0 ? Math.max(shown[0].cost, 0.0001) : 1;` => `shown.length <= 0`
- L577:36 MethodExpression: `const top = shown.length > 0 ? Math.max(shown[0].cost, 0.0001) : 1;` => `Math.min(shown[0].cost, 0.0001)`
- L580:46 MethodExpression: `rows: shown.map((r) => ({ ...r, pct: Math.min(100, Math.max(1, Math.round((r.cost / top) * 100))) })),` => `Math.max(100, Math.max(1, Math.round(r.cost / top * 100)))`
- L580:84 ArithmeticOperator: `rows: shown.map((r) => ({ ...r, pct: Math.min(100, Math.max(1, Math.round((r.cost / top) * 100))) })),` => `r.cost * top`
- L581:18 EqualityOperator: `hasMore: total > LIST_COLLAPSED_ROWS,` => `total >= LIST_COLLAPSED_ROWS`

`frontend/app/view/agents/usageattribution.ts` `amountOf` (8 survivors):

- L172:13 ConditionalExpression: `if (priceFor(b.model) != null) {` => `true`
- L172:13 ConditionalExpression: `if (priceFor(b.model) != null) {` => `false`
- L172:13 EqualityOperator: `if (priceFor(b.model) != null) {` => `priceFor(b.model) == null`
- L172:40 BlockStatement: `if (priceFor(b.model) != null) {` => `{}`
- L173:13 AssignmentOperator: `out.pricedTokens += tokens;` => `out.pricedTokens -= tokens`
- L175:13 ConditionalExpression: `if (b.reportedcostusd !== undefined) {` => `true`
- L175:13 ConditionalExpression: `if (b.reportedcostusd !== undefined) {` => `false`
- L175:13 EqualityOperator: `if (b.reportedcostusd !== undefined) {` => `b.reportedcostusd === undefined`

`frontend/app/view/agents/usageattribution.ts` `scopeList` (5 survivors):

- L553:9 ConditionalExpression: `if (kinds.orchestrator.count > 0) {` => `true`
- L553:9 EqualityOperator: `if (kinds.orchestrator.count > 0) {` => `kinds.orchestrator.count >= 0`
- L557:9 ConditionalExpression: `if (kinds.quick.count > 0) {` => `false`
- L560:9 ConditionalExpression: `if (kinds.session.count > 0) {` => `true`
- L560:9 EqualityOperator: `if (kinds.session.count > 0) {` => `kinds.session.count >= 0`

`frontend/app/view/agents/usagestats.ts` `aggregateBuckets` (46 survivors):

- L219:9 AssignmentOperator: `classTok.input += b.input;` => `classTok.input -= b.input`
- L223:9 AssignmentOperator: `classTok.cacheWrite += b.cachecreate;` => `classTok.cacheWrite -= b.cachecreate`
- L226:9 AssignmentOperator: `classSpd.reasoning += sb.reasoning;` => `classSpd.reasoning -= sb.reasoning`
- L227:9 AssignmentOperator: `classSpd.cacheRead += sb.cacheRead;` => `classSpd.cacheRead -= sb.cacheRead`
- L228:9 AssignmentOperator: `classSpd.cacheWrite += sb.cacheWrite;` => `classSpd.cacheWrite -= sb.cacheWrite`
- L234:9 AssignmentOperator: `h.spendUsd += sp;` => `h.spendUsd -= sp`
- L237:31 ConditionalExpression: `if (minDay == null || b.day < minDay) minDay = b.day;` => `false`
- L237:31 EqualityOperator: `if (minDay == null || b.day < minDay) minDay = b.day;` => `b.day <= minDay`
- L238:13 ConditionalExpression: `if (maxDay == null || b.day > maxDay) maxDay = b.day;` => `true`
- L238:13 ConditionalExpression: `if (maxDay == null || b.day > maxDay) maxDay = b.day;` => `false`
- L238:13 LogicalOperator: `if (maxDay == null || b.day > maxDay) maxDay = b.day;` => `maxDay == null && b.day > maxDay`
- L238:13 ConditionalExpression: `if (maxDay == null || b.day > maxDay) maxDay = b.day;` => `false`
- L238:13 EqualityOperator: `if (maxDay == null || b.day > maxDay) maxDay = b.day;` => `maxDay != null`
- L238:31 ConditionalExpression: `if (maxDay == null || b.day > maxDay) maxDay = b.day;` => `false`
- L238:31 EqualityOperator: `if (maxDay == null || b.day > maxDay) maxDay = b.day;` => `b.day >= maxDay`
- L238:31 EqualityOperator: `if (maxDay == null || b.day > maxDay) maxDay = b.day;` => `b.day <= maxDay`
- L257:9 AssignmentOperator: `series.spendUsd += sp;` => `series.spendUsd -= sp`
- L260:24 EqualityOperator: `const inWeek = b.day >= weekStart;` => `b.day > weekStart`
- L263:13 AssignmentOperator: `spendWeekUsd += sp;` => `spendWeekUsd -= sp`
- L264:13 AssignmentOperator: `allTokensWeek += tk;` => `allTokensWeek -= tk`
- L265:17 ConditionalExpression: `if (priceFor(b.model) != null) pricedTokensWeek += tk;` => `true`
- L265:17 ConditionalExpression: `if (priceFor(b.model) != null) pricedTokensWeek += tk;` => `false`
- L265:17 EqualityOperator: `if (priceFor(b.model) != null) pricedTokensWeek += tk;` => `priceFor(b.model) == null`
- L265:44 AssignmentOperator: `if (priceFor(b.model) != null) pricedTokensWeek += tk;` => `pricedTokensWeek -= tk`
- L269:13 AssignmentOperator: `spendTodayUsd += sp;` => `spendTodayUsd -= sp`
- L270:47 ArithmeticOperator: `tokensTodayByHarness[b.harness] = (tokensTodayByHarness[b.harness] ?? 0) + tk;` => `(tokensTodayByHarness[b.harness] ?? 0) - tk`
- L270:48 LogicalOperator: `tokensTodayByHarness[b.harness] = (tokensTodayByHarness[b.harness] ?? 0) + tk;` => `tokensTodayByHarness[b.harness] && 0`
- L281:17 ConditionalExpression: `if (inWeek) {` => `true`
- L281:17 ConditionalExpression: `if (inWeek) {` => `false`
- L281:25 BlockStatement: `if (inWeek) {` => `{}`
- L282:43 BooleanLiteral: `reportedCostWeekPresent = true;` => `false`
- L283:17 AssignmentOperator: `reportedCostWeekUsd += b.reportedcostusd;` => `reportedCostWeekUsd -= b.reportedcostusd`
- L294:13 ConditionalExpression: `if (tokens > 0) {` => `true`
- L294:13 EqualityOperator: `if (tokens > 0) {` => `tokens >= 0`
- L308:24 ConditionalExpression: `const endKey = maxDay != null && maxDay > today ? maxDay : today;` => `true`
- L308:24 ConditionalExpression: `const endKey = maxDay != null && maxDay > today ? maxDay : today;` => `false`
- L308:24 LogicalOperator: `const endKey = maxDay != null && maxDay > today ? maxDay : today;` => `maxDay != null || maxDay > today`
- L308:24 ConditionalExpression: `const endKey = maxDay != null && maxDay > today ? maxDay : today;` => `true`
- L308:24 EqualityOperator: `const endKey = maxDay != null && maxDay > today ? maxDay : today;` => `maxDay == null`
- L308:42 ConditionalExpression: `const endKey = maxDay != null && maxDay > today ? maxDay : today;` => `true`
- L308:42 EqualityOperator: `const endKey = maxDay != null && maxDay > today ? maxDay : today;` => `maxDay >= today`
- L308:42 EqualityOperator: `const endKey = maxDay != null && maxDay > today ? maxDay : today;` => `maxDay <= today`
- L333:40 ArrayDeclaration: `reportedCostWeekHarnesses: [...reportedCostWeekHarnesses],` => `[]`
- L339:37 ConditionalExpression: `pricingCoverageWeekPct: allTokensWeek > 0 ? (pricedTokensWeek / allTokensWeek) * 100 : null,` => `false`
- L339:57 ArithmeticOperator: `pricingCoverageWeekPct: allTokensWeek > 0 ? (pricedTokensWeek / allTokensWeek) * 100 : null,` => `pricedTokensWeek / allTokensWeek / 100`
- L339:58 ArithmeticOperator: `pricingCoverageWeekPct: allTokensWeek > 0 ? (pricedTokensWeek / allTokensWeek) * 100 : null,` => `pricedTokensWeek * allTokensWeek`

`frontend/app/view/agents/usagestats.ts` `usd` (5 survivors):

- L362:9 EqualityOperator: `if (n >= 1000) return "$" + +(n / 1000).toFixed(1) + "K";` => `n > 1000`
- L362:9 ConditionalExpression: `if (n >= 1000) return "$" + +(n / 1000).toFixed(1) + "K";` => `false`
- L362:33 UnaryOperator: `if (n >= 1000) return "$" + +(n / 1000).toFixed(1) + "K";` => `-(n / 1000).toFixed(1)`
- L362:35 ArithmeticOperator: `if (n >= 1000) return "$" + +(n / 1000).toFixed(1) + "K";` => `n * 1000`
- L363:9 EqualityOperator: `if (n >= 100) return "$" + Math.round(n);` => `n > 100`

`frontend/app/view/agents/usagestore.ts` `loadUsage` (5 survivors):

- L88:17 UpdateOperator: `const seq = ++loadSeq;` => `--loadSeq`
- L108:23 ObjectLiteral: `{ windowdays: windowDays },` => `{}`
- L115:62 ArrayDeclaration: `globalStore.set(usageSessionsAtom, reply.sessions ?? []);` => `["Stryker was here"]`
- L118:13 ConditionalExpression: `if (seq !== loadSeq) {` => `false`
- L124:13 ConditionalExpression: `if (seq === loadSeq) {` => `true`

`frontend/app/view/agents/weeklyforecast.ts` `projectWeeklyExhaustion` (19 survivors):

- L71:9 ConditionalExpression: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `false`
- L71:9 LogicalOperator: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `(resetMs <= now || weekpct <= 0 || weekpct >= 100) && now <= windowStartMs`
- L71:9 ConditionalExpression: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `false`
- L71:9 LogicalOperator: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `(resetMs <= now || weekpct <= 0) && weekpct >= 100`
- L71:9 ConditionalExpression: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `false`
- L71:9 LogicalOperator: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `resetMs <= now && weekpct <= 0`
- L71:9 ConditionalExpression: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `false`
- L71:9 EqualityOperator: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `resetMs < now`
- L71:27 ConditionalExpression: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `false`
- L71:27 EqualityOperator: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `weekpct < 0`
- L71:43 ConditionalExpression: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `false`
- L71:43 EqualityOperator: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `weekpct > 100`
- L71:61 ConditionalExpression: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `false`
- L71:61 EqualityOperator: `if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {` => `now < windowStartMs`
- L76:9 ConditionalExpression: `if (elapsedWeight <= 0) {` => `false`
- L76:9 EqualityOperator: `if (elapsedWeight <= 0) {` => `elapsedWeight < 0`
- L83:23 EqualityOperator: `for (let t = now; t < resetMs; t += STEP_MS) {` => `t <= resetMs`
- L84:42 ArithmeticOperator: `const stepMs = Math.min(STEP_MS, resetMs - t);` => `resetMs + t`
- L85:24 ArithmeticOperator: `const weight = shape[new Date(t).getDay()] * (stepMs / STEP_MS);` => `shape[new Date(t).getDay()] / (stepMs / STEP_MS)`

### Task 3: Kill the survivors in frontend/app/view/code, frontend/app/view/jarvis (codefinder.ts to briefingstore.ts)

**Depends on:** none
**Files:** `frontend/app/view/code/codefinder.test.ts`, `frontend/app/view/code/codemutate.test.ts`, `frontend/app/view/code/codepathinput.test.ts`, `frontend/app/view/code/codesidebar.test.ts`, `frontend/app/view/jarvis/briefingmodel.test.ts`, `frontend/app/view/jarvis/briefingstore.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/view/code/codefinder.ts` `scoreTerm` (15 survivors):

- L36:9 ConditionalExpression: `if (baseScore != null) {` => `false`
- L36:28 BlockStatement: `if (baseScore != null) {` => `{}`
- L37:17 ArithmeticOperator: `score = baseScore + BASENAME_BONUS + (base.toLowerCase().startsWith(term) ? PREFIX_BONUS : 0);` => `baseScore - BASENAME_BONUS`
- L37:47 MethodExpression: `score = baseScore + BASENAME_BONUS + (base.toLowerCase().startsWith(term) ? PREFIX_BONUS : 0);` => `base.toLowerCase().endsWith(term)`
- L37:47 MethodExpression: `score = baseScore + BASENAME_BONUS + (base.toLowerCase().startsWith(term) ? PREFIX_BONUS : 0);` => `base.toUpperCase()`
- L39:9 ConditionalExpression: `if (pathScore != null && (score == null || pathScore > score)) {` => `true`
- L39:9 ConditionalExpression: `if (pathScore != null && (score == null || pathScore > score)) {` => `true`
- L39:9 LogicalOperator: `if (pathScore != null && (score == null || pathScore > score)) {` => `pathScore != null || score == null || pathScore > score`
- L39:31 ConditionalExpression: `if (pathScore != null && (score == null || pathScore > score)) {` => `true`
- L39:31 LogicalOperator: `if (pathScore != null && (score == null || pathScore > score)) {` => `score == null && pathScore > score`
- L39:31 ConditionalExpression: `if (pathScore != null && (score == null || pathScore > score)) {` => `false`
- L39:31 EqualityOperator: `if (pathScore != null && (score == null || pathScore > score)) {` => `score != null`
- L39:48 ConditionalExpression: `if (pathScore != null && (score == null || pathScore > score)) {` => `false`
- L39:48 EqualityOperator: `if (pathScore != null && (score == null || pathScore > score)) {` => `pathScore >= score`
- L39:48 EqualityOperator: `if (pathScore != null && (score == null || pathScore > score)) {` => `pathScore <= score`

`frontend/app/view/code/codefinder.ts` `rankPaths` (10 survivors):

- L51:33 ArrayDeclaration: `recent: readonly string[] = []` => `["Stryker was here"]`
- L55:19 MethodExpression: `const terms = query` => `query.trim().toUpperCase()`
- L55:19 MethodExpression: `const terms = query` => `query`
- L58:16 Regex: `.split(/\s+/)` => `/\s/`
- L66:22 ConditionalExpression: `const base = slash === -1 ? path : path.slice(slash + 1);` => `true`
- L66:22 ConditionalExpression: `const base = slash === -1 ? path : path.slice(slash + 1);` => `false`
- L66:22 EqualityOperator: `const base = slash === -1 ? path : path.slice(slash + 1);` => `slash !== -1`
- L66:32 UnaryOperator: `const base = slash === -1 ? path : path.slice(slash + 1);` => `+1`
- L66:44 MethodExpression: `const base = slash === -1 ? path : path.slice(slash + 1);` => `path`
- L66:55 ArithmeticOperator: `const base = slash === -1 ? path : path.slice(slash + 1);` => `slash - 1`

`frontend/app/view/code/codemutate.ts` `nameErrorMessage` (5 survivors):

- L48:9 ConditionalExpression: `case "empty":` => `case "empty":`
- L50:9 ConditionalExpression: `case "separator":` => `case "separator":`
- L52:9 ConditionalExpression: `case "dots":` => `case "dots":`
- L54:9 ConditionalExpression: `case "illegal-char":` => `case "illegal-char":`
- L56:9 ConditionalExpression: `case "reserved":` => `case "reserved":`

`frontend/app/view/code/codepathinput.ts` `cleanPathInput` (7 survivors):

- L15:22 LogicalOperator: `const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');` => `trimmed.length >= 2 && trimmed.startsWith('"') || trimmed.endsWith('"')`
- L15:22 ConditionalExpression: `const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');` => `true`
- L15:22 LogicalOperator: `const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');` => `trimmed.length >= 2 || trimmed.startsWith('"')`
- L15:22 ConditionalExpression: `const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');` => `true`
- L15:45 MethodExpression: `const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');` => `trimmed.endsWith('"')`
- L15:72 MethodExpression: `const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');` => `trimmed.startsWith('"')`
- L16:23 MethodExpression: `return unquoted ? trimmed.slice(1, -1).trim() : trimmed;` => `trimmed.slice(1, -1)`

`frontend/app/view/code/codesidebar.ts` `parseCodeSidebarPrefs` (13 survivors):

- L98:9 ConditionalExpression: `if (raw == null) {` => `false`
- L103:13 ConditionalExpression: `if (value == null || typeof value !== "object" || Array.isArray(value)) {` => `false`
- L103:13 LogicalOperator: `if (value == null || typeof value !== "object" || Array.isArray(value)) {` => `(value == null || typeof value !== "object") && Array.isArray(value)`
- L103:13 ConditionalExpression: `if (value == null || typeof value !== "object" || Array.isArray(value)) {` => `false`
- L103:13 LogicalOperator: `if (value == null || typeof value !== "object" || Array.isArray(value)) {` => `value == null && typeof value !== "object"`
- L103:13 ConditionalExpression: `if (value == null || typeof value !== "object" || Array.isArray(value)) {` => `false`
- L103:30 ConditionalExpression: `if (value == null || typeof value !== "object" || Array.isArray(value)) {` => `false`
- L108:29 ConditionalExpression: `const widthRecord = widths != null && typeof widths === "object" && !Array.isArray(widths) ? widths : {};` => `true`
- L108:29 LogicalOperator: `const widthRecord = widths != null && typeof widths === "object" && !Array.isArray(widths) ? widths : {};` => `widths != null && typeof widths === "object" || !Array.isArray(widths)`
- L108:29 ConditionalExpression: `const widthRecord = widths != null && typeof widths === "object" && !Array.isArray(widths) ? widths : {};` => `true`
- L108:29 LogicalOperator: `const widthRecord = widths != null && typeof widths === "object" && !Array.isArray(widths) ? widths : {};` => `widths != null || typeof widths === "object"`
- L108:29 ConditionalExpression: `const widthRecord = widths != null && typeof widths === "object" && !Array.isArray(widths) ? widths : {};` => `true`
- L108:47 ConditionalExpression: `const widthRecord = widths != null && typeof widths === "object" && !Array.isArray(widths) ? widths : {};` => `true`

`frontend/app/view/jarvis/briefingmodel.ts` `mergeActiveWork` (13 survivors):

- L384:19 MethodExpression: `meta: [r.project, r.status].filter(Boolean).join(" · "),` => `[r.project, r.status]`
- L388:32 LogicalOperator: `: { label: r.status || "running", tone: "running" as const },` => `r.status && "running"`
- L397:19 ConditionalExpression: `chip: b.project == null ? { label: "Unscoped record", tone: "muted" as const } : null,` => `true`
- L405:19 MethodExpression: `meta: [a.runtime, a.project].filter(Boolean).join(" · "),` => `[a.runtime, a.project]`
- L406:43 ConditionalExpression: `chip: { label: a.state, tone: a.state === "asking" ? ("asking" as const) : ("running" as const) },` => `true`
- L413:42 ConditionalExpression: `r.kind === "blocker" || (r.chip != null && (r.chip.tone === "blocked" || r.chip.tone === "asking"))` => `true`
- L422:31 ConditionalExpression: `if (ax != null || ay != null) {` => `false`
- L423:25 LogicalOperator: `return (ax ?? -1) - (ay ?? -1);` => `ax && -1`
- L423:38 LogicalOperator: `return (ax ?? -1) - (ay ?? -1);` => `ay && -1`
- L426:17 ConditionalExpression: `if (t !== 0) {` => `false`
- L426:26 BlockStatement: `if (t !== 0) {` => `{}`
- L429:20 ConditionalExpression: `return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;` => `true`
- L429:20 EqualityOperator: `return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;` => `x.key <= y.key`

`frontend/app/view/jarvis/briefingmodel.ts` `matchesAttention` (10 survivors):

- L468:16 ConditionalExpression: `(a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail` => `true`
- L468:16 LogicalOperator: `(a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail` => `a.kind === "attention" && a.ts === ev.ts && a.title === ev.title || a.detail === ev.detail`
- L468:16 LogicalOperator: `(a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail` => `a.kind === "attention" && a.ts === ev.ts || a.title === ev.title`
- L468:16 ConditionalExpression: `(a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail` => `true`
- L468:16 ConditionalExpression: `(a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail` => `true`
- L468:16 LogicalOperator: `(a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail` => `a.kind === "attention" || a.ts === ev.ts`
- L468:16 ConditionalExpression: `(a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail` => `true`
- L468:42 ConditionalExpression: `(a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail` => `true`
- L468:60 ConditionalExpression: `(a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail` => `true`
- L468:84 ConditionalExpression: `(a) => a.kind === "attention" && a.ts === ev.ts && a.title === ev.title && a.detail === ev.detail` => `true`

`frontend/app/view/jarvis/briefingmodel.ts` `sortBy` (6 survivors):

- L475:13 ConditionalExpression: `if (s !== 0) {` => `true`
- L478:19 ArithmeticOperator: `const t = tsOf(b) - tsOf(a); // timestamp descending` => `tsOf(b) + tsOf(a)`
- L479:13 ConditionalExpression: `if (t !== 0) {` => `true`
- L479:13 ConditionalExpression: `if (t !== 0) {` => `false`
- L479:13 EqualityOperator: `if (t !== 0) {` => `t === 0`
- L479:22 BlockStatement: `if (t !== 0) {` => `{}`

`frontend/app/view/jarvis/briefingstore.ts` `loadBriefingAsync` (15 survivors):

- L95:17 UpdateOperator: `const gen = ++loadGeneration;` => `--loadGeneration`
- L101:9 ConditionalExpression: `if (settled.cursor !== prevCursor || settled.marks.length !== prevMarks.length) {` => `true`
- L101:9 LogicalOperator: `if (settled.cursor !== prevCursor || settled.marks.length !== prevMarks.length) {` => `settled.cursor !== prevCursor && settled.marks.length !== prevMarks.length`
- L101:9 ConditionalExpression: `if (settled.cursor !== prevCursor || settled.marks.length !== prevMarks.length) {` => `false`
- L101:9 EqualityOperator: `if (settled.cursor !== prevCursor || settled.marks.length !== prevMarks.length) {` => `settled.cursor === prevCursor`
- L101:42 ConditionalExpression: `if (settled.cursor !== prevCursor || settled.marks.length !== prevMarks.length) {` => `false`
- L101:42 EqualityOperator: `if (settled.cursor !== prevCursor || settled.marks.length !== prevMarks.length) {` => `settled.marks.length === prevMarks.length`
- L113:24 MethodExpression: `const fetchSince = Math.min(actualCursor, sevenDaysAgo);` => `Math.max(actualCursor, sevenDaysAgo)`
- L114:47 ObjectLiteral: `globalStore.set(fetchedBriefingStateAtom, {` => `{}`
- L116:18 BooleanLiteral: `loading: true,` => `false`
- L125:13 ConditionalExpression: `if (gen !== loadGeneration) {` => `false`
- L125:37 BlockStatement: `if (gen !== loadGeneration) {` => `{}`
- L129:57 ConditionalExpression: `const complete = state.sources.runs === true && state.sources.dossiers === true;` => `true`
- L137:13 ConditionalExpression: `if (gen !== loadGeneration) {` => `false`
- L143:22 BooleanLiteral: `loading: false,` => `true`

`frontend/app/view/jarvis/briefingstore.ts` `validCursor` (8 survivors):

- L91:12 LogicalOperator: `return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;` => `typeof v === "number" && Number.isFinite(v) || v > 0`
- L91:12 ConditionalExpression: `return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;` => `true`
- L91:12 LogicalOperator: `return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;` => `typeof v === "number" || Number.isFinite(v)`
- L91:12 ConditionalExpression: `return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;` => `true`
- L91:59 ConditionalExpression: `return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;` => `true`
- L91:59 EqualityOperator: `return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;` => `v >= 0`
- L91:68 ConditionalExpression: `return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;` => `true`
- L91:68 EqualityOperator: `return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;` => `v < at`

`frontend/app/view/jarvis/briefingstore.ts` `ackBriefingVisit` (6 survivors):

- L162:9 ConditionalExpression: `if (st.snapshot == null || !st.snapshot.complete || st.loading) {` => `false`
- L171:24 MethodExpression: `const latest = Math.max(` => `Math.min(typeof cur === "number" && Number.isFinite(cur) ? cur : 0, ...marks.map(m => m.through))`
- L172:13 ConditionalExpression: `typeof cur === "number" && Number.isFinite(cur) ? cur : 0,` => `true`
- L172:13 LogicalOperator: `typeof cur === "number" && Number.isFinite(cur) ? cur : 0,` => `typeof cur === "number" || Number.isFinite(cur)`
- L172:13 ConditionalExpression: `typeof cur === "number" && Number.isFinite(cur) ? cur : 0,` => `true`
- L175:13 EqualityOperator: `if (through > latest) {` => `through >= latest`

`frontend/app/view/jarvis/briefingstore.ts` `settleSeen` (5 survivors):

- L51:19 MethodExpression: `const valid = (Array.isArray(marks) ? marks : []).filter(` => `Array.isArray(marks) ? marks : []`
- L52:16 ConditionalExpression: `(m) => Number.isFinite(m?.through) && Number.isFinite(m?.at)` => `true`
- L52:16 LogicalOperator: `(m) => Number.isFinite(m?.through) && Number.isFinite(m?.at)` => `Number.isFinite(m?.through) || Number.isFinite(m?.at)`
- L56:58 ConditionalExpression: `const settled = due.reduce<number | null>((c, m) => (c == null || m.through > c ? m.through : c), cursor);` => `false`
- L56:71 EqualityOperator: `const settled = due.reduce<number | null>((c, m) => (c == null || m.through > c ? m.through : c), cursor);` => `m.through >= c`

### Task 4: Kill the survivors in frontend/app/view/jarvis (briefrows.ts to jarvisgraphderive.ts)

**Depends on:** none
**Files:** `frontend/app/view/jarvis/briefrows.test.ts`, `frontend/app/view/jarvis/briefundo.test.ts`, `frontend/app/view/jarvis/effortfeed.test.ts`, `frontend/app/view/jarvis/effortmodel.test.ts`, `frontend/app/view/jarvis/effortstore.test.ts`, `frontend/app/view/jarvis/finalshotsmodel.test.ts`, `frontend/app/view/jarvis/jarvisgraphderive.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

These sources changed after the mutation run, so their line numbers can be off: `frontend/app/view/jarvis/briefrows.ts`. Find each survivor by its source text; one whose line no longer exists goes under Not reached with the reason.

`frontend/app/view/jarvis/briefrows.ts` `projectName` (18 survivors):

- L447:9 ConditionalExpression: `if (path === "") {` => `false`
- L447:22 BlockStatement: `if (path === "") {` => `{}`
- L450:18 ArrowFunction: `const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();` => `() => undefined`
- L450:33 MethodExpression: `const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();` => `p.replace(/\\/g, "/").replace(/\/+$/, "").toUpperCase()`
- L450:63 Regex: `const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();` => `/\/+/`
- L450:63 Regex: `const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();` => `/\/$/`
- L451:32 LogicalOperator: `const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));` => `projects && {}`
- L451:53 ArrowFunction: `const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));` => `() => undefined`
- L451:64 ConditionalExpression: `const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));` => `true`
- L451:64 ConditionalExpression: `const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));` => `false`
- L451:64 LogicalOperator: `const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));` => `v.path != null || norm(v.path) === norm(path)`
- L451:64 ConditionalExpression: `const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));` => `true`
- L451:64 EqualityOperator: `const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));` => `v.path == null`
- L451:82 ConditionalExpression: `const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));` => `true`
- L451:82 EqualityOperator: `const hit = Object.entries(projects ?? {}).find(([, v]) => v.path != null && norm(v.path) === norm(path));` => `norm(v.path) !== norm(path)`
- L452:12 ConditionalExpression: `return hit != null ? hit[0] : (path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? path);` => `false`
- L452:69 Regex: `return hit != null ? hit[0] : (path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? path);` => `/\/+/`
- L452:69 Regex: `return hit != null ? hit[0] : (path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? path);` => `/\/$/`

`frontend/app/view/jarvis/briefrows.ts` `runRowFace` (15 survivors):

- L193:24 ConditionalExpression: `const asking = i.asking || line.state === "asking";` => `false`
- L193:24 LogicalOperator: `const asking = i.asking || line.state === "asking";` => `i.asking && line.state === "asking"`
- L193:36 ConditionalExpression: `const asking = i.asking || line.state === "asking";` => `false`
- L198:40 ConditionalExpression: `state: asking ? "asking" : line.state === "working" ? "running" : line.state,` => `true`
- L203:22 BooleanLiteral: `stopped: false,` => `true`
- L213:11 ConditionalExpression: `: status === "blocked"` => `false`
- L215:13 ConditionalExpression: `: status === "awaiting-review"` => `false`
- L219:17 ConditionalExpression: `: status === "done"` => `false`
- L221:19 ConditionalExpression: `: status === "planning"` => `false`
- L224:22 ConditionalExpression: `const terminal = status === "done" || status === "cancelled";` => `false`
- L226:20 ConditionalExpression: `const linked = ref != null && i.effort != null;` => `true`
- L230:49 LogicalOperator: `meta: orch ? 'lead · ${i.project}' : '${run.runtime || "claude"} · ${i.project}',` => `run.runtime && "claude"`
- L234:48 ConditionalExpression: `dot: i.asking ? "asking" : terminal ? (status === "done" ? "done" : "idle") : "live",` => `false`
- L237:18 ConditionalExpression: `stopped: status === "cancelled",` => `true`
- L240:16 LogicalOperator: `chunk: ref?.chunklabel ?? "",` => `ref?.chunklabel && ""`

`frontend/app/view/jarvis/briefrows.ts` `sessionLine` (8 survivors):

- L141:21 ConditionalExpression: `const running = row.chip?.tone === "running";` => `true`
- L151:38 ConditionalExpression: `stateTone: eyes ? "asking" : !dated && running ? "ok" : "muted",` => `true`
- L151:38 BooleanLiteral: `stateTone: eyes ? "asking" : !dated && running ? "ok" : "muted",` => `dated`
- L151:38 ConditionalExpression: `stateTone: eyes ? "asking" : !dated && running ? "ok" : "muted",` => `false`
- L151:38 LogicalOperator: `stateTone: eyes ? "asking" : !dated && running ? "ok" : "muted",` => `!dated || running`
- L158:17 ConditionalExpression: `runOid: row.kind === "run" ? row.oref.replace(/^run:/, "") : undefined,` => `true`
- L158:55 Regex: `runOid: row.kind === "run" ? row.oref.replace(/^run:/, "") : undefined,` => `/run:/`
- L159:18 ConditionalExpression: `agentId: row.kind === "agent" ? row.key.split(":")[1] : undefined,` => `true`

`frontend/app/view/jarvis/briefrows.ts` `digestLine` (6 survivors):

- L325:25 MethodExpression: `const newestFirst = [...rows].sort((a, b) => b.ts - a.ts);` => `[...rows]`
- L325:40 ArrowFunction: `const newestFirst = [...rows].sort((a, b) => b.ts - a.ts);` => `() => undefined`
- L325:50 ArithmeticOperator: `const newestFirst = [...rows].sort((a, b) => b.ts - a.ts);` => `b.ts + a.ts`
- L326:19 MethodExpression: `const notes = newestFirst` => `newestFirst.filter(r => r.kind !== "chunk-added" && CHUNK_EVENTS.has(r.kind)).map(r => ({
  ts: r.ts,
  text: `
- L327:24 ConditionalExpression: `.filter((r) => r.kind !== "chunk-added" && CHUNK_EVENTS.has(r.kind))` => `true`
- L329:24 ConditionalExpression: `.filter((n) => n.text !== "");` => `true`

`frontend/app/view/jarvis/briefrows.ts` `deltaLine` (6 survivors):

- L378:17 ConditionalExpression: `target: row.oref != null ? { oref: row.oref } : null,` => `true`
- L378:17 EqualityOperator: `target: row.oref != null ? { oref: row.oref } : null,` => `row.oref == null`
- L378:17 ConditionalExpression: `target: row.oref != null ? { oref: row.oref } : null,` => `false`
- L378:36 ObjectLiteral: `target: row.oref != null ? { oref: row.oref } : null,` => `{}`
- L382:13 LogicalOperator: `row.kind === "dossier" && detail.startsWith("status: ")` => `row.kind === "dossier" || detail.startsWith("status: ")`
- L382:13 ConditionalExpression: `row.kind === "dossier" && detail.startsWith("status: ")` => `true`

`frontend/app/view/jarvis/briefundo.ts` `createUndoQueue` (7 survivors):

- L24:22 LogicalOperator: `const windowMs = io.windowMs ?? UNDO_WINDOW_MS;` => `io.windowMs && UNDO_WINDOW_MS`
- L37:20 UpdateOperator: `const id = ++toastId;` => `--toastId`
- L41:17 ConditionalExpression: `if (toastId === id) {` => `true`
- L50:13 ConditionalExpression: `if (p == null) {` => `false`
- L66:24 UpdateOperator: `const id = nextId++;` => `nextId--`
- L74:25 ConditionalExpression: `if (p != null) {` => `true`
- L87:21 ConditionalExpression: `undo == null` => `false`

`frontend/app/view/jarvis/effortfeed.ts` `paragraphs` (8 survivors):

- L187:12 MethodExpression: `return body` => `body.split(/\n+/).flatMap(para => para.split(/\s(?=\((?:\d+|[a-h])\)\s)/)).map(text => text.trim())`
- L188:16 Regex: `.split(/\n+/)` => `/\n/`
- L189:39 Regex: `.flatMap((para) => para.split(/\s(?=\((?:\d+|[a-h])\)\s)/))` => `/\s(?=\((?:\d|[a-h])\)\s)/`
- L190:24 MethodExpression: `.map((text) => text.trim())` => `text`
- L191:27 ConditionalExpression: `.filter((text) => text !== "")` => `true`
- L193:20 Regex: `level: /^\(\d+\)\s/.test(text) ? 1 : /^\([a-h]\)\s/.test(text) ? 2 : 0,` => `/\(\d+\)\s/`
- L193:20 Regex: `level: /^\(\d+\)\s/.test(text) ? 1 : /^\([a-h]\)\s/.test(text) ? 2 : 0,` => `/^\(\d\)\s/`
- L193:50 Regex: `level: /^\(\d+\)\s/.test(text) ? 1 : /^\([a-h]\)\s/.test(text) ? 2 : 0,` => `/\([a-h]\)\s/`

`frontend/app/view/jarvis/effortfeed.ts` `headline` (6 survivors):

- L155:26 Regex: `const m = body.match(/^[\s\S]*?[.;](?=\s|$)/);` => `/[\s\S]*?[.;](?=\s|$)/`
- L155:26 Regex: `const m = body.match(/^[\s\S]*?[.;](?=\s|$)/);` => `/^[\s\S]*?[.;](?=\s)/`
- L156:18 MethodExpression: `const head = (m != null ? m[0] : body).trim();` => `m != null ? m[0] : body`
- L157:9 EqualityOperator: `if (head.length <= HEADLINE_MAX) {` => `head.length < HEADLINE_MAX`
- L161:26 ConditionalExpression: `return head.slice(0, cut > 0 ? cut : HEADLINE_MAX) + "…";` => `true`
- L161:26 EqualityOperator: `return head.slice(0, cut > 0 ? cut : HEADLINE_MAX) + "…";` => `cut >= 0`

`frontend/app/view/jarvis/effortfeed.ts` `codeSegments` (6 survivors):

- L171:13 ConditionalExpression: `if (at > last) {` => `true`
- L171:13 EqualityOperator: `if (at > last) {` => `at >= last`
- L174:40 Regex: `segs.push({ text: m[0].replace(/^'|'$/g, ""), code: true });` => `/'|'$/g`
- L174:40 Regex: `segs.push({ text: m[0].replace(/^'|'$/g, ""), code: true });` => `/^'|'/g`
- L177:9 ConditionalExpression: `if (last < text.length) {` => `true`
- L177:9 EqualityOperator: `if (last < text.length) {` => `last <= text.length`

`frontend/app/view/jarvis/effortmodel.ts` `buildEffortCard` (9 survivors):

- L49:9 ConditionalExpression: `if (e.total > 0 && skipped === e.total) {` => `true`
- L49:9 EqualityOperator: `if (e.total > 0 && skipped === e.total) {` => `e.total >= 0`
- L56:40 ConditionalExpression: `const pct = skipped === e.total && e.total > 0 ? 100 : Math.round((e.done / denominator) * 100);` => `true`
- L56:40 EqualityOperator: `const pct = skipped === e.total && e.total > 0 ? 100 : Math.round((e.done / denominator) * 100);` => `e.total >= 0`
- L74:13 ConditionalExpression: `e.activechunk != null ? chunkTone(chunks.find((c) => c.label === e.activechunk)?.status ?? "") : undefined,` => `true`
- L78:18 MethodExpression: `shortId: e.oref.replace(/^effort:/, "").slice(0, 8),` => `e.oref.replace(/^effort:/, "")`
- L78:33 Regex: `shortId: e.oref.replace(/^effort:/, "").slice(0, 8),` => `/effort:/`
- L79:59 ArrayDeclaration: `chunkStages: Object.fromEntries(chunks.map((c) => [c.label, c.stage ?? ""])),` => `[]`
- L79:69 LogicalOperator: `chunkStages: Object.fromEntries(chunks.map((c) => [c.label, c.stage ?? ""])),` => `c.stage && ""`

`frontend/app/view/jarvis/effortmodel.ts` `effortFacts` (5 survivors):

- L166:9 LogicalOperator: `if (effort.ticket != null && effort.ticket !== "") {` => `effort.ticket != null || effort.ticket !== ""`
- L166:9 ConditionalExpression: `if (effort.ticket != null && effort.ticket !== "") {` => `true`
- L166:9 ConditionalExpression: `if (effort.ticket != null && effort.ticket !== "") {` => `true`
- L166:34 ConditionalExpression: `if (effort.ticket != null && effort.ticket !== "") {` => `true`
- L169:55 ConditionalExpression: `const parent = effort.parentoid ? all.find((e) => e.oref === "effort:" + effort.parentoid) : undefined;` => `true`

`frontend/app/view/jarvis/effortstore.ts` `detailOps` (8 survivors):

- L150:9 MethodExpression: `if (next.title.trim() !== cur.title.trim()) {` => `next.title`
- L150:31 MethodExpression: `if (next.title.trim() !== cur.title.trim()) {` => `cur.title`
- L153:9 MethodExpression: `if (next.project.trim() !== cur.project.trim()) {` => `next.project`
- L153:33 MethodExpression: `if (next.project.trim() !== cur.project.trim()) {` => `cur.project`
- L154:47 MethodExpression: `ops.push({ op: "setProject", project: next.project.trim() });` => `next.project`
- L156:9 ConditionalExpression: `if (next.ticket.trim() !== cur.ticket.trim()) {` => `false`
- L156:9 MethodExpression: `if (next.ticket.trim() !== cur.ticket.trim()) {` => `next.ticket`
- L156:32 MethodExpression: `if (next.ticket.trim() !== cur.ticket.trim()) {` => `cur.ticket`

`frontend/app/view/jarvis/effortstore.ts` `effortChunkRows` (5 survivors):

- L35:20 LogicalOperator: `stage: c.stage ?? "",` => `c.stage && ""`
- L37:25 ConditionalExpression: `latestNote: trail.length > 0 ? trail[trail.length - 1].text : undefined,` => `true`
- L37:25 EqualityOperator: `latestNote: trail.length > 0 ? trail[trail.length - 1].text : undefined,` => `trail.length >= 0`
- L40:23 LogicalOperator: `workrefs: c.workrefs ?? [],` => `c.workrefs && []`
- L40:37 ArrayDeclaration: `workrefs: c.workrefs ?? [],` => `["Stryker was here"]`

`frontend/app/view/jarvis/finalshotsmodel.ts` `finalCheckEntry` (6 survivors):

- L182:21 ConditionalExpression: `const pending = group.final != null && !FINISHED_STATES.has(group.final.state);` => `true`
- L183:27 MethodExpression: `const earlierFailed = rounds` => `rounds.slice(0, -1)`
- L186:22 ConditionalExpression: `.find((r) => r.state === "failed");` => `true`
- L194:16 MethodExpression: `strip: latest.scenarios` => `latest.scenarios`
- L195:28 ConditionalExpression: `.filter((s) => s.files.length > 0)` => `true`
- L195:28 EqualityOperator: `.filter((s) => s.files.length > 0)` => `s.files.length >= 0`

`frontend/app/view/jarvis/jarvisgraphderive.ts` `attributionStyle` (8 survivors):

- L64:19 ConditionalExpression: `semantic: l.provenance === "semantic",` => `true`
- L65:44 ConditionalExpression: `opacity: bucket === "strong" ? 1 : bucket === "medium" ? 0.6 : 0.35,` => `false`
- L66:16 ConditionalExpression: `width: bucket === "strong" ? 1.4 : bucket === "medium" ? 1.0 : 0.7,` => `true`
- L66:16 ConditionalExpression: `width: bucket === "strong" ? 1.4 : bucket === "medium" ? 1.0 : 0.7,` => `false`
- L66:16 EqualityOperator: `width: bucket === "strong" ? 1.4 : bucket === "medium" ? 1.0 : 0.7,` => `bucket !== "strong"`
- L66:44 ConditionalExpression: `width: bucket === "strong" ? 1.4 : bucket === "medium" ? 1.0 : 0.7,` => `true`
- L66:44 ConditionalExpression: `width: bucket === "strong" ? 1.4 : bucket === "medium" ? 1.0 : 0.7,` => `false`
- L66:44 EqualityOperator: `width: bucket === "strong" ? 1.4 : bucket === "medium" ? 1.0 : 0.7,` => `bucket !== "medium"`
