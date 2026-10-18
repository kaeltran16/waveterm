# Mutation survivor pilot: fix the tests that miss behaviour

A mutation run over the repo (Stryker for `frontend/` and `claude/`, a custom overlay mutator for Go) changed one
operator, condition or call at a time and ran the tests. Each change listed below **survived**: the code was altered
and every test still passed. The lists were produced on commit `c5f1c39c3`; none of these source files has changed
since, so the line and column numbers hold on this base.

This run is a pilot. It answers two questions before the rest of the list (271 functions) is worked: what share of
survivors are real gaps in the tests, and how many functions one task gets through.

**Verify:** `node scripts/verify.mjs ./pkg/agentsessions ./pkg/agentobserve ./pkg/jarvisbackfill ./pkg/wshrpc/wshserver`

## How every task works a survivor

For each survivor in the task's list, in order:

1. Read the line and decide whether the change alters behaviour a caller can observe through the function's
   exported result (return value, emitted events, state the function writes).
   - **Equivalent:** it cannot be observed (the guard is redundant with an earlier one, the value is overwritten,
     the branch is unreachable from any input). Record it with a one-line reason. Do not write a test for it.
   - **Real gap:** some input makes the mutated code return something different. Go on to step 2.
2. Write or fix a test that feeds that input and asserts the exact correct output. Put it in the function's existing
   test file, beside the tests for the same behaviour, in that file's style. Test behaviour through the public
   function, not internals. A strong assertion on the specific value, never `toBeTruthy`, `toBeDefined`,
   `not.toBeNull`, a length-only check, or a Go `!= nil`/`len(x) > 0` alone.
   One test can kill several survivors that share a cause (for example every mutant of one `&&` chain); group them.
3. **Prove it:** apply the mutation to the source by hand, run that one test, and see it fail. Then restore the
   source. `git diff` must show no change to any non-test file when the task ends.
4. If a survivor shows the code itself is wrong (the test would have to assert buggy behaviour), do not change the
   code and do not encode the bug in a test. Record it under **Bugs found** with the input and both outputs.

Change only test files. Run a function's whole test file after its tests are written.

## Report

End the task's report with this table and lists, so the pilot can be measured:

| Function | Survivors | Real gap, now killed | Equivalent | Bug found | Not reached |
|---|---|---|---|---|---|

- **Equivalent:** each as `L<line>:<col>`: one-line reason.
- **Bugs found:** each with the input, the expected output and the actual one.
- **Not reached:** survivors left unworked, if any.

### Task 1: Kill the survivors in the agent transcript projections

**Depends on:** none
**Files:** `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/pitranscriptprojection.test.ts`, `frontend/app/view/agents/codextranscriptprojection.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. If a test file named here does not exist, create it beside the source in the style of that package's other tests.

`frontend/app/view/agents/transcriptprojection.ts` `projectTranscript` (72 survivors):

- L122:17 ConditionalExpression: `if (!Array.isArray(content)) {` => `false`
- L126:21 LogicalOperator: `if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {` => `block?.type === "text" || typeof block.text === "string"`
- L126:21 ConditionalExpression: `if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L126:47 ConditionalExpression: `if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L126:81 ConditionalExpression: `if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L126:81 MethodExpression: `if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {` => `block.text`
- L130:21 LogicalOperator: `if (block?.type === "tool_use" && typeof block.name === "string") {` => `block?.type === "tool_use" || typeof block.name === "string"`
- L130:21 ConditionalExpression: `if (block?.type === "tool_use" && typeof block.name === "string") {` => `true`
- L130:51 ConditionalExpression: `if (block?.type === "tool_use" && typeof block.name === "string") {` => `true`
- L131:25 ConditionalExpression: `if (block.name === "Skill" && block?.caller?.type === "direct" && typeof block.input?.skill === "string") {` => `true`
- L131:87 ConditionalExpression: `if (block.name === "Skill" && block?.caller?.type === "direct" && typeof block.input?.skill === "string") {` => `true`
- L132:77 MethodExpression: `const args = typeof block.input.args === "string" ? block.input.args.trim() : "";` => `block.input.args`
- L142:25 ConditionalExpression: `if (block.name === "Edit" && block.input && typeof block.input.old_string === "string") {` => `true`
- L142:25 LogicalOperator: `if (block.name === "Edit" && block.input && typeof block.input.old_string === "string") {` => `block.name === "Edit" || block.input`
- L142:25 ConditionalExpression: `if (block.name === "Edit" && block.input && typeof block.input.old_string === "string") {` => `true`
- L147:32 ConditionalExpression: `} else if (block.name === "Write" && block.input && typeof block.input.content === "string") {` => `false`
- L147:32 LogicalOperator: `} else if (block.name === "Write" && block.input && typeof block.input.content === "string") {` => `block.name === "Write" && block.input || typeof block.input.content === "string"`
- L147:32 ConditionalExpression: `} else if (block.name === "Write" && block.input && typeof block.input.content === "string") {` => `true`
- L147:32 LogicalOperator: `} else if (block.name === "Write" && block.input && typeof block.input.content === "string") {` => `block.name === "Write" || block.input`
- L147:32 ConditionalExpression: `} else if (block.name === "Write" && block.input && typeof block.input.content === "string") {` => `true`
- L147:32 EqualityOperator: `} else if (block.name === "Write" && block.input && typeof block.input.content === "string") {` => `block.name !== "Write"`
- L152:32 LogicalOperator: `} else if (block.name === "Skill" && block.input && typeof block.input.skill === "string") {` => `block.name === "Skill" && block.input || typeof block.input.skill === "string"`
- L152:32 ConditionalExpression: `} else if (block.name === "Skill" && block.input && typeof block.input.skill === "string") {` => `true`
- L152:32 LogicalOperator: `} else if (block.name === "Skill" && block.input && typeof block.input.skill === "string") {` => `block.name === "Skill" || block.input`
- L152:32 ConditionalExpression: `} else if (block.name === "Skill" && block.input && typeof block.input.skill === "string") {` => `true`
- L152:73 ConditionalExpression: `} else if (block.name === "Skill" && block.input && typeof block.input.skill === "string") {` => `true`
- L153:77 MethodExpression: `const args = typeof block.input.args === "string" ? block.input.args.trim() : "";` => `block.input.args`
- L155:32 LogicalOperator: `} else if (block.name === "AskUserQuestion" && Array.isArray(block.input?.questions)) {` => `block.name === "AskUserQuestion" || Array.isArray(block.input?.questions)`
- L155:32 ConditionalExpression: `} else if (block.name === "AskUserQuestion" && Array.isArray(block.input?.questions)) {` => `true`
- L160:46 ConditionalExpression: `(action as any)._useTs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;` => `true`
- L162:25 ConditionalExpression: `if (block.name === "Bash" && typeof block.input?.command === "string") {` => `true`
- L162:25 LogicalOperator: `if (block.name === "Bash" && typeof block.input?.command === "string") {` => `block.name === "Bash" || typeof block.input?.command === "string"`
- L162:25 ConditionalExpression: `if (block.name === "Bash" && typeof block.input?.command === "string") {` => `true`
- L162:50 ConditionalExpression: `if (block.name === "Bash" && typeof block.input?.command === "string") {` => `true`
- L166:25 ConditionalExpression: `if (typeof block.id === "string") {` => `true`
- L182:21 ConditionalExpression: `typeof raw === "string"` => `true`
- L190:42 ConditionalExpression: `mergeCompaction(entries, summary.trim() !== "" ? { summary } : {});` => `true`
- L190:42 MethodExpression: `mergeCompaction(entries, summary.trim() !== "" ? { summary } : {});` => `summary`
- L207:32 ConditionalExpression: `} else if (content.trim() !== "") {` => `true`
- L207:32 MethodExpression: `} else if (content.trim() !== "") {` => `content`
- L213:17 ConditionalExpression: `if (!Array.isArray(content)) {` => `false`
- L217:21 LogicalOperator: `if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {` => `block?.type === "text" || typeof block.text === "string"`
- L217:21 ConditionalExpression: `if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L217:47 ConditionalExpression: `if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L217:81 ConditionalExpression: `if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L217:81 MethodExpression: `if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {` => `block.text`
- L221:21 ConditionalExpression: `if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {` => `false`
- L221:21 LogicalOperator: `if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {` => `block?.type !== "tool_result" && typeof block.tool_use_id !== "string"`
- L221:21 ConditionalExpression: `if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {` => `false`
- L221:54 ConditionalExpression: `if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {` => `false`
- L230:21 ConditionalExpression: `if (tool === "Grep" && body) {` => `false`
- L234:28 ConditionalExpression: `} else if ((tool === "Read" || tool === "Glob") && body) {` => `false`
- L234:29 LogicalOperator: `} else if ((tool === "Read" || tool === "Glob") && body) {` => `tool === "Read" && tool === "Glob"`
- L234:29 ConditionalExpression: `} else if ((tool === "Read" || tool === "Glob") && body) {` => `false`
- L234:48 ConditionalExpression: `} else if ((tool === "Read" || tool === "Glob") && body) {` => `false`
- L243:31 ConditionalExpression: `exit: block.is_error === true ? 1 : 0,` => `false`
- L245:28 LogicalOperator: `} else if (action.detail?.kind === "ask" && typeof rec.toolUseResult?.answers === "object") {` => `action.detail?.kind === "ask" || typeof rec.toolUseResult?.answers === "object"`
- L245:28 ConditionalExpression: `} else if (action.detail?.kind === "ask" && typeof rec.toolUseResult?.answers === "object") {` => `true`
- L245:61 ConditionalExpression: `} else if (action.detail?.kind === "ask" && typeof rec.toolUseResult?.answers === "object") {` => `true`
- L249:31 ConditionalExpression: `const resTs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;` => `true`
- L251:21 ConditionalExpression: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `true`
- L251:21 LogicalOperator: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `Number.isFinite(resTs) && Number.isFinite(useTs) || resTs >= useTs`
- L251:21 LogicalOperator: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `Number.isFinite(resTs) || Number.isFinite(useTs)`
- L251:73 ConditionalExpression: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `true`
- L251:73 EqualityOperator: `if (Number.isFinite(resTs) && Number.isFinite(useTs) && resTs >= useTs) {` => `resTs > useTs`
- L262:13 LogicalOperator: `if (rec.type === "system" && rec.subtype === "compact_boundary") {` => `rec.type === "system" || rec.subtype === "compact_boundary"`
- L262:13 ConditionalExpression: `if (rec.type === "system" && rec.subtype === "compact_boundary") {` => `true`
- L262:38 ConditionalExpression: `if (rec.type === "system" && rec.subtype === "compact_boundary") {` => `true`
- L265:17 ConditionalExpression: `if (typeof m.trigger === "string") {` => `true`
- L268:17 ConditionalExpression: `if (typeof m.preTokens === "number") {` => `true`
- L271:17 ConditionalExpression: `if (typeof m.postTokens === "number") {` => `true`
- L280:13 ConditionalExpression: `if (e.kind === "action") {` => `true`

`frontend/app/view/agents/pitranscriptprojection.ts` `extractPiTasks` (33 survivors):

- L426:13 LogicalOperator: `if (rec?.type !== "message" || rec.message == null) {` => `rec?.type !== "message" && rec.message == null`
- L426:13 ConditionalExpression: `if (rec?.type !== "message" || rec.message == null) {` => `false`
- L426:40 ConditionalExpression: `if (rec?.type !== "message" || rec.message == null) {` => `false`
- L432:48 MethodExpression: `const m = TASK_CREATED_RE.exec(toolResultText(msg.content).trim());` => `toolResultText(msg.content)`
- L433:21 ConditionalExpression: `if (m != null && !byId.has(m[1])) {` => `true`
- L433:21 LogicalOperator: `if (m != null && !byId.has(m[1])) {` => `m != null || !byId.has(m[1])`
- L433:21 ConditionalExpression: `if (m != null && !byId.has(m[1])) {` => `true`
- L434:44 MethodExpression: `byId.set(m[1], { text: m[2].trim(), done: false });` => `m[2]`
- L439:17 ConditionalExpression: `if (msg.toolName === "TaskList") {` => `true`
- L441:31 BooleanLiteral: `let updated = false;` => `true`
- L443:49 MethodExpression: `const m = TASK_LIST_RE.exec(l.trim());` => `l`
- L448:25 ConditionalExpression: `if (!byId.has(id)) {` => `true`
- L454:31 BooleanLiteral: `updated = true;` => `false`
- L456:21 ConditionalExpression: `if (updated) {` => `true`
- L456:21 ConditionalExpression: `if (updated) {` => `false`
- L456:30 BlockStatement: `if (updated) {` => `{}`
- L462:13 ConditionalExpression: `if (msg.role === "assistant" && Array.isArray(msg.content)) {` => `true`
- L462:13 ConditionalExpression: `if (msg.role === "assistant" && Array.isArray(msg.content)) {` => `true`
- L462:13 LogicalOperator: `if (msg.role === "assistant" && Array.isArray(msg.content)) {` => `msg.role === "assistant" || Array.isArray(msg.content)`
- L464:21 ConditionalExpression: `if ((b?.type !== "toolCall" && b?.type !== "tool_use") || b.name !== "TaskUpdate") {` => `false`
- L464:21 LogicalOperator: `if ((b?.type !== "toolCall" && b?.type !== "tool_use") || b.name !== "TaskUpdate") {` => `b?.type !== "toolCall" && b?.type !== "tool_use" && b.name !== "TaskUpdate"`
- L464:22 ConditionalExpression: `if ((b?.type !== "toolCall" && b?.type !== "tool_use") || b.name !== "TaskUpdate") {` => `false`
- L464:75 ConditionalExpression: `if ((b?.type !== "toolCall" && b?.type !== "tool_use") || b.name !== "TaskUpdate") {` => `false`
- L464:100 BlockStatement: `if ((b?.type !== "toolCall" && b?.type !== "tool_use") || b.name !== "TaskUpdate") {` => `{}`
- L468:21 ConditionalExpression: `if (a == null || typeof a !== "object") {` => `false`
- L468:21 ConditionalExpression: `if (a == null || typeof a !== "object") {` => `false`
- L468:21 LogicalOperator: `if (a == null || typeof a !== "object") {` => `a == null && typeof a !== "object"`
- L468:34 ConditionalExpression: `if (a == null || typeof a !== "object") {` => `false`
- L473:21 ConditionalExpression: `if (task != null && typeof a.status === "string") {` => `true`
- L473:21 LogicalOperator: `if (task != null && typeof a.status === "string") {` => `task != null || typeof a.status === "string"`
- L473:21 ConditionalExpression: `if (task != null && typeof a.status === "string") {` => `true`
- L473:37 ConditionalExpression: `if (task != null && typeof a.status === "string") {` => `true`
- L474:33 ConditionalExpression: `task.done = a.status === "completed";` => `true`

`frontend/app/view/agents/pitranscriptprojection.ts` `mapAssistantContent` (24 survivors):

- L167:9 ConditionalExpression: `if (!Array.isArray(content)) {` => `false`
- L167:34 BlockStatement: `if (!Array.isArray(content)) {` => `{}`
- L173:13 LogicalOperator: `if (b == null || (b.type !== "toolCall" && b.type !== "tool_use") || typeof b.name !== "string" || b.name === ` => `(b == null || b.type !== "toolCall" && b.type !== "tool_use") && typeof b.name !== "string"`
- L173:13 ConditionalExpression: `if (b == null || (b.type !== "toolCall" && b.type !== "tool_use") || typeof b.name !== "string" || b.name === ` => `false`
- L173:13 LogicalOperator: `if (b == null || (b.type !== "toolCall" && b.type !== "tool_use") || typeof b.name !== "string" || b.name === ` => `b == null && b.type !== "toolCall" && b.type !== "tool_use"`
- L173:13 ConditionalExpression: `if (b == null || (b.type !== "toolCall" && b.type !== "tool_use") || typeof b.name !== "string" || b.name === ` => `false`
- L173:27 ConditionalExpression: `if (b == null || (b.type !== "toolCall" && b.type !== "tool_use") || typeof b.name !== "string" || b.name === ` => `false`
- L173:52 ConditionalExpression: `if (b == null || (b.type !== "toolCall" && b.type !== "tool_use") || typeof b.name !== "string" || b.name === ` => `true`
- L173:52 EqualityOperator: `if (b == null || (b.type !== "toolCall" && b.type !== "tool_use") || typeof b.name !== "string" || b.name === ` => `b.type === "tool_use"`
- L173:78 ConditionalExpression: `if (b == null || (b.type !== "toolCall" && b.type !== "tool_use") || typeof b.name !== "string" || b.name === ` => `false`
- L173:108 ConditionalExpression: `if (b == null || (b.type !== "toolCall" && b.type !== "tool_use") || typeof b.name !== "string" || b.name === ` => `false`
- L179:13 ConditionalExpression: `if (detail) {` => `true`
- L186:34 ConditionalExpression: `(action as any)._useTs = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;` => `true`
- L187:13 ConditionalExpression: `if (b.name === "bash" && args != null && typeof args === "object") {` => `true`
- L187:13 LogicalOperator: `if (b.name === "bash" && args != null && typeof args === "object") {` => `b.name === "bash" && args != null || typeof args === "object"`
- L187:13 ConditionalExpression: `if (b.name === "bash" && args != null && typeof args === "object") {` => `true`
- L187:13 LogicalOperator: `if (b.name === "bash" && args != null && typeof args === "object") {` => `b.name === "bash" || args != null`
- L187:13 ConditionalExpression: `if (b.name === "bash" && args != null && typeof args === "object") {` => `true`
- L187:34 ConditionalExpression: `if (b.name === "bash" && args != null && typeof args === "object") {` => `true`
- L187:50 ConditionalExpression: `if (b.name === "bash" && args != null && typeof args === "object") {` => `true`
- L189:17 ConditionalExpression: `if (typeof command === "string") {` => `true`
- L194:24 ConditionalExpression: `const callId = typeof b.toolCallId === "string" && b.toolCallId !== "" ? b.toolCallId : typeof b.id === "strin` => `false`
- L194:97 ConditionalExpression: `const callId = typeof b.toolCallId === "string" && b.toolCallId !== "" ? b.toolCallId : typeof b.id === "strin` => `true`
- L195:13 ConditionalExpression: `if (callId !== "") {` => `true`

`frontend/app/view/agents/codextranscriptprojection.ts` `projectCodexTranscript` (25 survivors):

- L110:17 BlockStatement: `} catch {` => `{}`
- L113:13 ConditionalExpression: `if (rec?.type !== "response_item") {` => `false`
- L113:44 BlockStatement: `if (rec?.type !== "response_item") {` => `{}`
- L117:13 ConditionalExpression: `if (p == null) {` => `false`
- L124:25 ConditionalExpression: `if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L124:25 ConditionalExpression: `if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L124:25 LogicalOperator: `if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim() !== "") {` => `block?.type === "output_text" && typeof block.text === "string" || block.text.trim() !== ""`
- L124:25 LogicalOperator: `if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim() !== "") {` => `block?.type === "output_text" || typeof block.text === "string"`
- L124:25 ConditionalExpression: `if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L124:58 ConditionalExpression: `if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L124:92 ConditionalExpression: `if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim() !== "") {` => `true`
- L124:92 MethodExpression: `if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim() !== "") {` => `block.text`
- L132:25 ConditionalExpression: `if (block?.type !== "input_text" || typeof block.text !== "string") {` => `false`
- L132:25 LogicalOperator: `if (block?.type !== "input_text" || typeof block.text !== "string") {` => `block?.type !== "input_text" && typeof block.text !== "string"`
- L132:25 ConditionalExpression: `if (block?.type !== "input_text" || typeof block.text !== "string") {` => `false`
- L132:57 ConditionalExpression: `if (block?.type !== "input_text" || typeof block.text !== "string") {` => `false`
- L135:25 ConditionalExpression: `if (block.text.trim() === "" || isInjectedContext(block.text)) {` => `false`
- L135:25 MethodExpression: `if (block.text.trim() === "" || isInjectedContext(block.text)) {` => `block.text`
- L144:17 ConditionalExpression: `if (typeof p.name !== "string") {` => `false`
- L155:17 ConditionalExpression: `if (typeof p.call_id === "string") {` => `true`
- L160:13 ConditionalExpression: `if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {` => `true`
- L160:50 EqualityOperator: `if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {` => `p.type !== "custom_tool_call_output"`
- L160:50 ConditionalExpression: `if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {` => `false`
- L161:17 ConditionalExpression: `if (typeof p.call_id !== "string") {` => `false`
- L165:17 ConditionalExpression: `if (action == null) {` => `false`

### Task 2: Kill the survivors in the jarvis run sheet, briefing and effort feed models

**Depends on:** none
**Files:** `frontend/app/view/jarvis/runsheetmodel.test.ts`, `frontend/app/view/jarvis/briefingmodel.test.ts`, `frontend/app/view/jarvis/effortfeed.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. If a test file named here does not exist, create it beside the source in the style of that package's other tests.

`frontend/app/view/jarvis/runsheetmodel.ts` `daggedStatus` (50 survivors):

- L260:32 LogicalOperator: `text: '${formatElapsed(digest?.durations?.elapsedms || Math.max(0, nowMs - run.createdts))} elapsed',` => `digest?.durations?.elapsedms && Math.max(0, nowMs - run.createdts)`
- L260:64 MethodExpression: `text: '${formatElapsed(digest?.durations?.elapsedms || Math.max(0, nowMs - run.createdts))} elapsed',` => `Math.min(0, nowMs - run.createdts)`
- L260:76 ArithmeticOperator: `text: '${formatElapsed(digest?.durations?.elapsedms || Math.max(0, nowMs - run.createdts))} elapsed',` => `nowMs + run.createdts`
- L263:41 ConditionalExpression: `if (dag.groupRead === "loading" || (dag.groupRead === "ready" && digest == null && state.loading)) {` => `false`
- L263:41 ConditionalExpression: `if (dag.groupRead === "loading" || (dag.groupRead === "ready" && digest == null && state.loading)) {` => `true`
- L263:41 EqualityOperator: `if (dag.groupRead === "loading" || (dag.groupRead === "ready" && digest == null && state.loading)) {` => `dag.groupRead !== "ready"`
- L268:20 BooleanLiteral: `pulse: true,` => `false`
- L270:19 ArrayDeclaration: `meta: [elapsed],` => `[]`
- L272:20 BooleanLiteral: `retry: false,` => `true`
- L275:9 ConditionalExpression: `if (dag.groupRead !== "ready" || dag.group == null || digest == null) {` => `false`
- L275:9 LogicalOperator: `if (dag.groupRead !== "ready" || dag.group == null || digest == null) {` => `dag.groupRead !== "ready" && dag.group == null`
- L275:9 ConditionalExpression: `if (dag.groupRead !== "ready" || dag.group == null || digest == null) {` => `false`
- L275:38 ConditionalExpression: `if (dag.groupRead !== "ready" || dag.group == null || digest == null) {` => `false`
- L280:20 BooleanLiteral: `pulse: false,` => `true`
- L285:20 ConditionalExpression: `retry: dag.groupRead === "ready" && dag.group != null,` => `true`
- L285:20 LogicalOperator: `retry: dag.groupRead === "ready" && dag.group != null,` => `dag.groupRead === "ready" || dag.group != null`
- L285:49 ConditionalExpression: `retry: dag.groupRead === "ready" && dag.group != null,` => `true`
- L289:9 LogicalOperator: `if (state.stale && state.error != null && !state.loading) {` => `state.stale || state.error != null`
- L289:24 ConditionalExpression: `if (state.stale && state.error != null && !state.loading) {` => `true`
- L290:21 ConditionalExpression: `const age = state.lastUpdatedTs != null ? since(nowMs, state.lastUpdatedTs) : null;` => `true`
- L291:35 ConditionalExpression: `const meta: SheetMeta[] = age != null ? [{ text: 'as of ${age} ago', tone: "warning" }] : [];` => `true`
- L291:35 ConditionalExpression: `const meta: SheetMeta[] = age != null ? [{ text: 'as of ${age} ago', tone: "warning" }] : [];` => `false`
- L291:35 EqualityOperator: `const meta: SheetMeta[] = age != null ? [{ text: 'as of ${age} ago', tone: "warning" }] : [];` => `age == null`
- L291:49 ArrayDeclaration: `const meta: SheetMeta[] = age != null ? [{ text: 'as of ${age} ago', tone: "warning" }] : [];` => `[]`
- L291:50 ObjectLiteral: `const meta: SheetMeta[] = age != null ? [{ text: 'as of ${age} ago', tone: "warning" }] : [];` => `{}`
- L292:19 ObjectLiteral: `meta.push({ text: "refresh failed", tone: "warning" });` => `{}`
- L296:17 ConditionalExpression: `age != null` => `true`
- L300:20 BooleanLiteral: `pulse: false,` => `true`
- L314:39 ConditionalExpression: `meta.push({ text: chip, tone: chip === "unverified" ? "warning" : "muted" });` => `true`
- L314:39 ConditionalExpression: `meta.push({ text: chip, tone: chip === "unverified" ? "warning" : "muted" });` => `false`
- L314:39 EqualityOperator: `meta.push({ text: chip, tone: chip === "unverified" ? "warning" : "muted" });` => `chip !== "unverified"`
- L324:9 ConditionalExpression: `if (updated != null) {` => `true`
- L336:20 BooleanLiteral: `pulse: true,` => `false`
- L340:20 BooleanLiteral: `retry: false,` => `true`
- L343:9 LogicalOperator: `if (digest.next.kind === "terminal" && digest.next.terminalstatus === "done") {` => `digest.next.kind === "terminal" || digest.next.terminalstatus === "done"`
- L343:9 ConditionalExpression: `if (digest.next.kind === "terminal" && digest.next.terminalstatus === "done") {` => `true`
- L343:44 ConditionalExpression: `if (digest.next.kind === "terminal" && digest.next.terminalstatus === "done") {` => `true`
- L348:20 BooleanLiteral: `pulse: true,` => `false`
- L352:20 BooleanLiteral: `retry: false,` => `true`
- L356:22 MethodExpression: `const left = (digest.tasks ?? []).filter((td) => td.humanactions?.[0] === "retry-cleanup").length;` => `digest.tasks ?? []`
- L356:58 ConditionalExpression: `const left = (digest.tasks ?? []).filter((td) => td.humanactions?.[0] === "retry-cleanup").length;` => `true`
- L361:20 BooleanLiteral: `pulse: false,` => `true`
- L365:20 BooleanLiteral: `retry: false,` => `true`
- L369:25 LogicalOperator: `const needing = digest.counts.attention || (digest.next.taskids?.length ?? 0);` => `digest.counts.attention && (digest.next.taskids?.length ?? 0)`
- L375:20 BooleanLiteral: `pulse: true,` => `false`
- L379:20 BooleanLiteral: `retry: false,` => `true`
- L385:63 ConditionalExpression: `'${finished} of ${plural(total, "task")} done' + (running > 0 ? ', ${plural(running, "worker")} live' : ""),` => `true`
- L385:63 EqualityOperator: `'${finished} of ${plural(total, "task")} done' + (running > 0 ? ', ${plural(running, "worker")} live' : ""),` => `running >= 0`
- L387:16 BooleanLiteral: `pulse: true,` => `false`
- L391:16 BooleanLiteral: `retry: false,` => `true`

`frontend/app/view/jarvis/briefingmodel.ts` `projectBriefing` (50 survivors):

- L492:28 MethodExpression: `const attentionItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "attention");` => `projects.flatMap(p => p.active ?? [])`
- L492:82 ConditionalExpression: `const attentionItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "attention");` => `true`
- L499:19 LogicalOperator: `oid: (a.navtarget ?? "").replace(/^run:/, ""),` => `a.navtarget && ""`
- L499:46 Regex: `oid: (a.navtarget ?? "").replace(/^run:/, ""),` => `/run:/`
- L503:17 ConditionalExpression: `a.detail != null && a.detail.startsWith("status: ")` => `true`
- L503:17 LogicalOperator: `a.detail != null && a.detail.startsWith("status: ")` => `a.detail != null || a.detail.startsWith("status: ")`
- L503:17 ConditionalExpression: `a.detail != null && a.detail.startsWith("status: ")` => `true`
- L506:43 ArrayDeclaration: `workerOrefs: a.workerorefs ?? [],` => `["Stryker was here"]`
- L507:19 LogicalOperator: `mode: a.mode ?? "",` => `a.mode && ""`
- L511:9 ArrowFunction: `(r) => r.ts,` => `() => undefined`
- L512:9 ArrowFunction: `(r) => r.oref` => `() => undefined`
- L515:26 MethodExpression: `const blockerItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "blocker");` => `projects.flatMap(p => p.active ?? [])`
- L515:80 ConditionalExpression: `const blockerItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "blocker");` => `true`
- L520:23 LogicalOperator: `blockers: a.detail ?? "",` => `a.detail && ""`
- L521:22 ConditionalExpression: `project: (a.project ?? "") === "" ? null : a.project,` => `true`
- L521:23 LogicalOperator: `project: (a.project ?? "") === "" ? null : a.project,` => `a.project && ""`
- L524:9 ArrowFunction: `() => 0,` => `() => undefined`
- L525:9 ArrowFunction: `(b) => b.ts,` => `() => undefined`
- L526:9 ArrowFunction: `(b) => b.oref` => `() => undefined`
- L545:19 LogicalOperator: `task: a.task ?? a.name,` => `a.task && a.name`
- L546:22 LogicalOperator: `runtime: a.agent ?? "",` => `a.agent && ""`
- L547:22 LogicalOperator: `project: a.project ?? null,` => `a.project && null`
- L549:24 ArithmeticOperator: `startedTs: queryStartedAt - (a.state === "asking" ? (a.blockedMs ?? 0) : (a.activeMs ?? 0)),` => `queryStartedAt + (a.state === "asking" ? a.blockedMs ?? 0 : a.activeMs ?? 0)`
- L549:42 ConditionalExpression: `startedTs: queryStartedAt - (a.state === "asking" ? (a.blockedMs ?? 0) : (a.activeMs ?? 0)),` => `true`
- L549:42 EqualityOperator: `startedTs: queryStartedAt - (a.state === "asking" ? (a.blockedMs ?? 0) : (a.activeMs ?? 0)),` => `a.state !== "asking"`
- L549:42 ConditionalExpression: `startedTs: queryStartedAt - (a.state === "asking" ? (a.blockedMs ?? 0) : (a.activeMs ?? 0)),` => `false`
- L549:66 LogicalOperator: `startedTs: queryStartedAt - (a.state === "asking" ? (a.blockedMs ?? 0) : (a.activeMs ?? 0)),` => `a.blockedMs && 0`
- L549:87 LogicalOperator: `startedTs: queryStartedAt - (a.state === "asking" ? (a.blockedMs ?? 0) : (a.activeMs ?? 0)),` => `a.activeMs && 0`
- L551:59 ConditionalExpression: `.sort((x, y) => (x.state === "asking" ? 0 : 1) - (y.state === "asking" ? 0 : 1));` => `false`
- L558:24 EqualityOperator: `.filter((s) => s.completedts >= input.sevenDaysAgo)` => `s.completedts > input.sevenDaysAgo`
- L565:25 EqualityOperator: `.filter((ev) => ev.ts >= actualCursor && ev.kind !== "session" && !matchesAttention(ev, attentionItems));` => `ev.ts > actualCursor`
- L568:25 ConditionalExpression: `.filter((ev) => ev.kind !== "run-done" || !promotedOrefs.has(ev.navtarget ?? ""))` => `false`
- L577:25 LogicalOperator: `detail: ev.detail ?? null,` => `ev.detail && null`
- L586:18 LogicalOperator: `summary: s.summary ?? "",` => `s.summary && ""`
- L588:38 ConditionalExpression: `fresh: rawDelta.some((ev) => ev.kind === "run-done" && ev.navtarget === "run:" + s.runoid),` => `true`
- L588:38 LogicalOperator: `fresh: rawDelta.some((ev) => ev.kind === "run-done" && ev.navtarget === "run:" + s.runoid),` => `ev.kind === "run-done" || ev.navtarget === "run:" + s.runoid`
- L588:38 ConditionalExpression: `fresh: rawDelta.some((ev) => ev.kind === "run-done" && ev.navtarget === "run:" + s.runoid),` => `true`
- L588:64 ConditionalExpression: `fresh: rawDelta.some((ev) => ev.kind === "run-done" && ev.navtarget === "run:" + s.runoid),` => `true`
- L588:64 EqualityOperator: `fresh: rawDelta.some((ev) => ev.kind === "run-done" && ev.navtarget === "run:" + s.runoid),` => `ev.navtarget !== "run:" + s.runoid`
- L589:20 ConditionalExpression: `hasReport: s.hasreport === true,` => `true`
- L589:20 ConditionalExpression: `hasReport: s.hasreport === true,` => `false`
- L589:20 EqualityOperator: `hasReport: s.hasreport === true,` => `s.hasreport !== true`
- L589:36 BooleanLiteral: `hasReport: s.hasreport === true,` => `false`
- L590:20 LogicalOperator: `effortOid: s.effortoid ?? "",` => `s.effortoid && ""`
- L591:21 LogicalOperator: `chunkLabel: s.chunklabel ?? "",` => `s.chunklabel && ""`
- L592:15 LogicalOperator: `mode: s.mode ?? "",` => `s.mode && ""`
- L599:9 ConditionalExpression: `if (state.sources.dossiers !== true) {` => `false`
- L605:25 MethodExpression: `const effortCards = (state.efforts ?? [])` => `(state.efforts ?? []).filter(e => e.status !== "archived")`
- L607:15 ArrowFunction: `.sort((a, b) => b.updatedts - a.updatedts)` => `() => undefined`
- L607:25 ArithmeticOperator: `.sort((a, b) => b.updatedts - a.updatedts)` => `b.updatedts + a.updatedts`

`frontend/app/view/jarvis/briefingmodel.ts` `buildAttentionQueue` (27 survivors):

- L208:75 Regex: `const effortTitles = new Map(input.efforts.map((e) => [e.oref.replace(/^effort:/, ""), e.title]));` => `/effort:/`
- L216:56 ConditionalExpression: `const radarORef = a.kind === "radar-triage" && a.oref != null && a.oref !== "" ? a.oref : null;` => `true`
- L216:74 ConditionalExpression: `const radarORef = a.kind === "radar-triage" && a.oref != null && a.oref !== "" ? a.oref : null;` => `true`
- L222:32 LogicalOperator: `detail: [a.source, channelId !== "" && a.channelname ? "#" + a.channelname : null]` => `channelId !== "" || a.channelname`
- L222:32 ConditionalExpression: `detail: [a.source, channelId !== "" && a.channelname ? "#" + a.channelname : null]` => `true`
- L223:45 ConditionalExpression: `.filter((s) => s != null && s !== "")` => `true`
- L228:21 ConditionalExpression: `action: channelId !== "" || radarORef != null ? a.action : null,` => `false`
- L233:62 ConditionalExpression: `? { kind: "channel", channelId, runId: a.runid != null && a.runid !== "" ? a.runid : null }` => `true`
- L237:17 ConditionalExpression: `a.effortoid != null && a.effortoid !== ""` => `true`
- L237:17 LogicalOperator: `a.effortoid != null && a.effortoid !== ""` => `a.effortoid != null || a.effortoid !== ""`
- L237:17 ConditionalExpression: `a.effortoid != null && a.effortoid !== ""` => `true`
- L237:40 ConditionalExpression: `a.effortoid != null && a.effortoid !== ""` => `true`
- L244:20 ConditionalExpression: `runId: a.runid || null,` => `true`
- L244:20 ConditionalExpression: `runId: a.runid || null,` => `false`
- L244:20 LogicalOperator: `runId: a.runid || null,` => `a.runid && null`
- L245:21 LogicalOperator: `taskId: a.taskid ?? "",` => `a.taskid && ""`
- L246:20 ConditionalExpression: `retry: a.retry === true,` => `true`
- L246:20 ConditionalExpression: `retry: a.retry === true,` => `false`
- L246:20 EqualityOperator: `retry: a.retry === true,` => `a.retry !== true`
- L246:32 BooleanLiteral: `retry: a.retry === true,` => `false`
- L267:24 ArrayDeclaration: `cites: [],` => `["Stryker was here"]`
- L272:24 BooleanLiteral: `retry: false,` => `true`
- L284:21 LogicalOperator: `source: b.project ?? "",` => `b.project && ""`
- L285:21 LogicalOperator: `detail: b.project ?? "",` => `b.project && ""`
- L288:18 ConditionalExpression: `nav: b.oref !== "" ? { kind: "record", oref: b.oref } : null,` => `true`
- L292:20 ArrayDeclaration: `cites: [],` => `["Stryker was here"]`
- L296:20 BooleanLiteral: `retry: false,` => `true`

`frontend/app/view/jarvis/effortfeed.ts` `effortFeed` (33 survivors):

- L50:25 ArrayDeclaration: `(chunk.notes ?? []).map((n, i) => ({ ...n, chunk, at: i + 1 }))` => `["Stryker was here"]`
- L53:20 ArrowFunction: `const suffix = (n: LocatedNote) => STATUS_NOTE.exec(n.text)?.[2] ?? "";` => `() => undefined`
- L53:40 LogicalOperator: `const suffix = (n: LocatedNote) => STATUS_NOTE.exec(n.text)?.[2] ?? "";` => `STATUS_NOTE.exec(n.text)?.[2] && ""`
- L59:20 LogicalOperator: `(n) => !used.has(n) && n.ts === ev.ts && (status ? STATUS_NOTE.test(n.text) : n.text === text)` => `!used.has(n) && n.ts === ev.ts || (status ? STATUS_NOTE.test(n.text) : n.text === text)`
- L59:20 ConditionalExpression: `(n) => !used.has(n) && n.ts === ev.ts && (status ? STATUS_NOTE.test(n.text) : n.text === text)` => `true`
- L59:20 LogicalOperator: `(n) => !used.has(n) && n.ts === ev.ts && (status ? STATUS_NOTE.test(n.text) : n.text === text)` => `!used.has(n) || n.ts === ev.ts`
- L59:36 ConditionalExpression: `(n) => !used.has(n) && n.ts === ev.ts && (status ? STATUS_NOTE.test(n.text) : n.text === text)` => `true`
- L59:91 ConditionalExpression: `(n) => !used.has(n) && n.ts === ev.ts && (status ? STATUS_NOTE.test(n.text) : n.text === text)` => `true`
- L61:22 ArrowFunction: `const pick = (cands: LocatedNote[]) => (status ? cands.find((n) => suffix(n) === text) : cands[0]);` => `() => undefined`
- L61:69 ArrowFunction: `const pick = (cands: LocatedNote[]) => (status ? cands.find((n) => suffix(n) === text) : cands[0]);` => `() => undefined`
- L61:76 ConditionalExpression: `const pick = (cands: LocatedNote[]) => (status ? cands.find((n) => suffix(n) === text) : cands[0]);` => `true`
- L61:76 ConditionalExpression: `const pick = (cands: LocatedNote[]) => (status ? cands.find((n) => suffix(n) === text) : cands[0]);` => `false`
- L61:76 EqualityOperator: `const pick = (cands: LocatedNote[]) => (status ? cands.find((n) => suffix(n) === text) : cands[0]);` => `suffix(n) !== text`
- L68:14 ConditionalExpression: `(hits.length === 1 ? hits[0] : undefined)` => `true`
- L72:21 ArrowFunction: `chunks.find((c) => c.label === label) ??` => `() => undefined`
- L72:28 ConditionalExpression: `chunks.find((c) => c.label === label) ??` => `false`
- L73:40 ArrayDeclaration: `chunks.find((c) => (c.notes ?? []).some((n) => n.text === "renamed from " + label));` => `["Stryker was here"]`
- L73:56 ConditionalExpression: `chunks.find((c) => (c.notes ?? []).some((n) => n.text === "renamed from " + label));` => `true`
- L80:22 ConditionalExpression: `const note = ev.kind === "chunk-added" ? undefined : locate(ev);` => `false`
- L81:13 ConditionalExpression: `if (note != null) {` => `true`
- L81:13 ConditionalExpression: `if (note != null) {` => `false`
- L81:13 EqualityOperator: `if (note != null) {` => `note == null`
- L81:27 BlockStatement: `if (note != null) {` => `{}`
- L85:35 ConditionalExpression: `const m = note != null && ev.kind !== "effort-note" ? STATUS_NOTE.exec(note.text) : null;` => `true`
- L91:41 Regex: `chunk: chunk?.label ?? (/^\d+$/.test(label) ? "removed chunk" : label),` => `/\d+$/`
- L91:41 Regex: `chunk: chunk?.label ?? (/^\d+$/.test(label) ? "removed chunk" : label),` => `/^\d+/`
- L91:41 Regex: `chunk: chunk?.label ?? (/^\d+$/.test(label) ? "removed chunk" : label),` => `/^\d$/`
- L96:27 ConditionalExpression: `: m != null` => `false`
- L98:29 ConditionalExpression: `: ev.kind === "chunk-done"` => `false`
- L100:31 ConditionalExpression: `: ev.kind === "chunk-status"` => `false`
- L113:12 MethodExpression: `return entries.reverse().sort((a, b) => b.ts - a.ts);` => `entries.reverse()`
- L113:35 ArrowFunction: `return entries.reverse().sort((a, b) => b.ts - a.ts);` => `() => undefined`
- L113:45 ArithmeticOperator: `return entries.reverse().sort((a, b) => b.ts - a.ts);` => `b.ts + a.ts`

### Task 3: Kill the survivors in four Go functions

**Depends on:** none
**Files:** `pkg/agentsessions/*_test.go`, `pkg/agentobserve/*_test.go`, `pkg/jarvisbackfill/*_test.go`, `pkg/wshrpc/wshserver/*_test.go`

Follow "How every task works a survivor" above. Run one test with `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/x -run '^TestName$'`; the sqlite-backed packages fail without CGO. If a test file named here does not exist, create it beside the source in the style of that package's other tests.

`pkg/agentsessions/agentsessions.go` `extractCodexEvents` (15 survivors):

- L424:39 op: `if ts := parseTs(rec.Timestamp); ts > 0 {` => `> -> >=`
- L447:15 op: `if p.Role == "assistant" && b.Type == "output_text" && strings.TrimSpace(b.Text) != "" {` => `== -> !=`
- L447:30 op: `if p.Role == "assistant" && b.Type == "output_text" && strings.TrimSpace(b.Text) != "" {` => `&& -> ||`
- L447:40 op: `if p.Role == "assistant" && b.Type == "output_text" && strings.TrimSpace(b.Text) != "" {` => `== -> !=`
- L447:57 op: `if p.Role == "assistant" && b.Type == "output_text" && strings.TrimSpace(b.Text) != "" {` => `&& -> ||`
- L447:86 op: `if p.Role == "assistant" && b.Type == "output_text" && strings.TrimSpace(b.Text) != "" {` => `!= -> ==`
- L450:25 op: `if p.Role == "user" && b.Type == "input_text" && firstUser == "" && strings.TrimSpace(b.Text) != "" &&` => `&& -> ||`
- L450:51 op: `if p.Role == "user" && b.Type == "input_text" && firstUser == "" && strings.TrimSpace(b.Text) != "" &&` => `&& -> ||`
- L450:70 op: `if p.Role == "user" && b.Type == "input_text" && firstUser == "" && strings.TrimSpace(b.Text) != "" &&` => `&& -> ||`
- L450:105 op: `if p.Role == "user" && b.Type == "input_text" && firstUser == "" && strings.TrimSpace(b.Text) != "" &&` => `&& -> ||`
- L451:57 op: `!strings.HasPrefix(b.Text, "<environment_context") && !strings.HasPrefix(b.Text, "<skill>") {` => `&& -> ||`
- L464:14 op: `if p.Name == "shell_command" && commitRe.MatchString(cmd) {` => `== -> !=`
- L464:33 op: `if p.Name == "shell_command" && commitRe.MatchString(cmd) {` => `&& -> ||`
- L468:22 op: `if p.CallID != "" && codexOutputIsError(p.Output) {` => `&& -> ||`
- L485:19 op: `if lastAssistant != "" {` => `!= -> ==`

`pkg/agentobserve/analyze.go` `AnalyzeShadowLog` (13 survivors):

- L78:11 incdec: `s.Sweeps++` => `++ -> --`
- L87:23 op: `if rec.RosterState != "" {` => `!= -> ==`
- L91:21 op: `if rec.MatchCount > s.MaxMatchCount {` => `> -> >=`
- L94:40 op: `if rec.ResolveMethod == "createtime" && rec.MatchCount > 1 {` => `&& -> ||`
- L94:58 op: `if rec.ResolveMethod == "createtime" && rec.MatchCount > 1 {` => `> -> >=`
- L98:16 incdec: `s.Comparable++` => `++ -> --`
- L99:25 op: `if rec.ObserverState != rec.HookState {` => `!= -> ==`
- L109:6 drop-not: `if !s.HookFired {` => `(! removed)`
- L110:56 op: `if hs, ok := hooks[NormalizeBlockID(s.BlockID)]; ok && hs.Count > 0 {` => `&& -> ||`
- L110:68 op: `if hs, ok := hooks[NormalizeBlockID(s.BlockID)]; ok && hs.Count > 0 {` => `> -> >=`
- L110:68 op: `if hs, ok := hooks[NormalizeBlockID(s.BlockID)]; ok && hs.Count > 0 {` => `> -> <=`
- L124:7 drop-not: `if !s.RosterShown {` => `(! removed)`
- L134:22 op: `if s.MaxMatchCount > rep.MaxMatchCount {` => `> -> >=`

`pkg/jarvisbackfill/plan.go` `BuildPlan` (10 survivors):

- L170:27 op: `return g[i].CreatedTs < g[j].CreatedTs` => `< -> <=`
- L179:19 op: `if r.CreatedTs < created {` => `< -> <=`
- L182:25 op: `if e := runEnd(r); e > updated {` => `> -> >=`
- L200:2 drop-call: `sort.SliceStable(p.Dossiers, func(i, j int) bool {` => `(call removed)`
- L201:34 op: `if p.Dossiers[i].Facts.Created != p.Dossiers[j].Facts.Created {` => `!= -> ==`
- L202:39 op: `return p.Dossiers[i].Facts.Created < p.Dossiers[j].Facts.Created` => `< -> <=`
- L202:39 op: `return p.Dossiers[i].Facts.Created < p.Dossiers[j].Facts.Created` => `< -> >=`
- L242:2 drop-call: `sort.SliceStable(p.Decisions, func(i, j int) bool {` => `(call removed)`
- L243:39 op: `return p.Decisions[i].Facts.Summary < p.Decisions[j].Facts.Summary` => `< -> <=`
- L243:39 op: `return p.Decisions[i].Facts.Summary < p.Decisions[j].Facts.Summary` => `< -> >=`

`pkg/wshrpc/wshserver/wshserver_runs.go` `advanceRun` (7 survivors):

- L705:26 op: `if data.ChannelId == "" || data.RunId == "" {` => `|| -> &&`
- L746:11 flip-bool: `return false, fmt.Errorf("run %s would not land: wave/%s conflicts with %s in %s. Merge %s into this tree, res` => `false -> true`
- L774:14 op: `if preRun == nil || i >= len(preRun.Phases) || preRun.Phases[i].State != jarvis.PhaseState_Running {` => `== -> !=`
- L782:78 op: `if run, gerr := wstore.GetRun(ctx, data.ChannelId, data.RunId); gerr == nil && run.Status == jarvis.RunStatus_` => `&& -> ||`
- L821:82 op: `if postRun, gerr := wstore.GetRun(ctx, data.ChannelId, data.RunId); gerr == nil &&` => `&& -> ||`
- L863:81 op: `if freshRun, err := wstore.GetRun(ctx, data.ChannelId, data.RunId); err == nil && freshRun.DagORef != "" && (f` => `&& -> ||`
- L863:107 op: `if freshRun, err := wstore.GetRun(ctx, data.ChannelId, data.RunId); err == nil && freshRun.DagORef != "" && (f` => `&& -> ||`
