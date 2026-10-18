# Mutation survivors, wave 2 of 5: fix the tests that miss behaviour

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

### Task 1: Kill the survivors in frontend/app/store/wos.ts and 5 more (wos.ts to agentcwd.ts)

**Depends on:** none
**Files:** `frontend/app/store/wos.test.ts`, `frontend/app/store/wps.test.ts`, `frontend/app/store/ws.test.ts`, `frontend/app/store/wshclient.test.ts`, `frontend/app/store/wshrpcutil-base.test.ts`, `frontend/app/view/agents/agentcwd.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/store/wos.ts` `createWaveValueObject` (12 survivors):

- L174:17 ObjectLiteral: `const wov = { pendingPromise: null, dataAtom: null };` => `{}`
- L175:25 ObjectLiteral: `wov.dataAtom = atom({ value: null, loading: true, error: false });` => `{}`
- L175:49 BooleanLiteral: `wov.dataAtom = atom({ value: null, loading: true, error: false });` => `false`
- L175:62 BooleanLiteral: `wov.dataAtom = atom({ value: null, loading: true, error: false });` => `true`
- L176:9 ConditionalExpression: `if (!shouldFetch) {` => `false`
- L187:17 ConditionalExpression: `if (val != null) {` => `true`
- L187:17 ConditionalExpression: `if (val != null) {` => `false`
- L187:17 EqualityOperator: `if (val != null) {` => `val == null`
- L187:30 BlockStatement: `if (val != null) {` => `{}`
- L188:21 ConditionalExpression: `if (val["otype"] != otype) {` => `false`
- L191:21 ConditionalExpression: `if (val["oid"] != oid) {` => `false`
- L202:17 ConditionalExpression: `if (wov.pendingPromise != localPromise) {` => `false`

`frontend/app/store/wos.ts` `callBackendService` (11 survivors):

- L108:9 ConditionalExpression: `if (!noUIContext && globalThis.window != null) {` => `false`
- L108:9 LogicalOperator: `if (!noUIContext && globalThis.window != null) {` => `!noUIContext || globalThis.window != null`
- L108:9 BooleanLiteral: `if (!noUIContext && globalThis.window != null) {` => `noUIContext`
- L111:35 ObjectLiteral: `const waveCall: WebCallType = {` => `{}`
- L123:9 ConditionalExpression: `if (webEndpoint == null) throw new Error('cannot call ${methodName}: no web endpoint');` => `false`
- L125:37 ObjectLiteral: `const fetchPromise = fetch(url, {` => `{}`
- L131:17 ConditionalExpression: `if (!resp.ok) {` => `false`
- L137:17 ConditionalExpression: `if (respData == null) {` => `false`
- L140:17 ConditionalExpression: `if (respData.updates != null) {` => `false`
- L143:17 ConditionalExpression: `if (respData.error != null) {` => `false`
- L146:33 ArithmeticOperator: `const durationStr = Date.now() - startTs + "ms";` => `Date.now() + startTs`

`frontend/app/store/wos.ts` `updateWaveObject` (7 survivors):

- L292:9 ConditionalExpression: `if (update == null) {` => `false`
- L302:63 BooleanLiteral: `globalStore.set(wov.dataAtom, { value: null, loading: false, error: false });` => `true`
- L302:77 BooleanLiteral: `globalStore.set(wov.dataAtom, { value: null, loading: false, error: false });` => `true`
- L304:13 ConditionalExpression: `if (!isValidWaveObj(update.obj)) {` => `false`
- L309:13 ConditionalExpression: `if (curValue.value != null && curValue.value.version >= update.obj.version) {` => `false`
- L314:69 BooleanLiteral: `globalStore.set(wov.dataAtom, { value: update.obj, loading: false, error: false });` => `true`
- L314:83 BooleanLiteral: `globalStore.set(wov.dataAtom, { value: update.obj, loading: false, error: false });` => `true`

`frontend/app/store/wos.ts` `isBlankNum` (7 survivors):

- L41:43 BlockStatement: `function isBlankNum(num: number): boolean {` => `{}`
- L42:12 ConditionalExpression: `return num == null || isNaN(num) || num == 0;` => `false`
- L42:12 LogicalOperator: `return num == null || isNaN(num) || num == 0;` => `(num == null || isNaN(num)) && num == 0`
- L42:12 ConditionalExpression: `return num == null || isNaN(num) || num == 0;` => `false`
- L42:12 LogicalOperator: `return num == null || isNaN(num) || num == 0;` => `num == null && isNaN(num)`
- L42:12 ConditionalExpression: `return num == null || isNaN(num) || num == 0;` => `false`
- L42:41 ConditionalExpression: `return num == null || isNaN(num) || num == 0;` => `false`

`frontend/app/store/wos.ts` `isBlank` (5 survivors):

- L37:40 BlockStatement: `function isBlank(str: string): boolean {` => `{}`
- L38:12 LogicalOperator: `return str == null || str == "";` => `str == null && str == ""`
- L38:12 ConditionalExpression: `return str == null || str == "";` => `false`
- L38:12 ConditionalExpression: `return str == null || str == "";` => `false`
- L38:27 ConditionalExpression: `return str == null || str == "";` => `false`

`frontend/app/store/wos.ts` `isValidWaveObj` (5 survivors):

- L46:9 ConditionalExpression: `if (val == null) {` => `false`
- L49:9 ConditionalExpression: `if (isBlank(val.otype) || isBlank(val.oid) || isBlankNum(val.version)) {` => `false`
- L49:9 LogicalOperator: `if (isBlank(val.otype) || isBlank(val.oid) || isBlankNum(val.version)) {` => `(isBlank(val.otype) || isBlank(val.oid)) && isBlankNum(val.version)`
- L49:9 ConditionalExpression: `if (isBlank(val.otype) || isBlank(val.oid) || isBlankNum(val.version)) {` => `false`
- L49:9 LogicalOperator: `if (isBlank(val.otype) || isBlank(val.oid) || isBlankNum(val.version)) {` => `isBlank(val.otype) && isBlank(val.oid)`

`frontend/app/store/wps.ts` `updateWaveEventSub` (15 survivors):

- L47:9 ConditionalExpression: `if (isPreviewWindow()) {` => `false`
- L51:9 ConditionalExpression: `if (subjects == null) {` => `true`
- L52:59 ObjectLiteral: `RpcApi.EventUnsubCommand(WpsRpcClient, eventType, { noresponse: true });` => `{}`
- L52:73 BooleanLiteral: `RpcApi.EventUnsubCommand(WpsRpcClient, eventType, { noresponse: true });` => `false`
- L55:41 ObjectLiteral: `const subreq: SubscriptionRequest = { event: eventType, scopes: [], allscopes: false };` => `{}`
- L55:69 ArrayDeclaration: `const subreq: SubscriptionRequest = { event: eventType, scopes: [], allscopes: false };` => `["Stryker was here"]`
- L55:84 BooleanLiteral: `const subreq: SubscriptionRequest = { event: eventType, scopes: [], allscopes: false };` => `true`
- L56:35 BlockStatement: `for (const scont of subjects) {` => `{}`
- L57:13 ConditionalExpression: `if (isBlank(scont.scope)) {` => `true`
- L57:13 ConditionalExpression: `if (isBlank(scont.scope)) {` => `false`
- L57:35 BlockStatement: `if (isBlank(scont.scope)) {` => `{}`
- L58:32 BooleanLiteral: `subreq.allscopes = true;` => `false`
- L59:29 ArrayDeclaration: `subreq.scopes = [];` => `["Stryker was here"]`
- L64:50 ObjectLiteral: `RpcApi.EventSubCommand(WpsRpcClient, subreq, { noresponse: true });` => `{}`
- L64:64 BooleanLiteral: `RpcApi.EventSubCommand(WpsRpcClient, subreq, { noresponse: true });` => `false`

`frontend/app/store/wps.ts` `waveEventUnsubscribe` (8 survivors):

- L92:13 ConditionalExpression: `if (subjects == null) {` => `false`
- L95:47 ConditionalExpression: `const idx = subjects.findIndex((s) => s.id === unsubscribe.id);` => `true`
- L95:47 EqualityOperator: `const idx = subjects.findIndex((s) => s.id === unsubscribe.id);` => `s.id !== unsubscribe.id`
- L96:13 ConditionalExpression: `if (idx === -1) {` => `false`
- L96:13 EqualityOperator: `if (idx === -1) {` => `idx !== -1`
- L96:21 UnaryOperator: `if (idx === -1) {` => `+1`
- L96:25 BlockStatement: `if (idx === -1) {` => `{}`
- L100:13 ConditionalExpression: `if (subjects.length === 0) {` => `true`

`frontend/app/store/ws.ts` `onclose` (12 survivors):

- L127:13 ConditionalExpression: `if (this.onOpenTimeoutId) {` => `true`
- L127:13 ConditionalExpression: `if (this.onOpenTimeoutId) {` => `false`
- L127:35 BlockStatement: `if (this.onOpenTimeoutId) {` => `{}`
- L130:13 ConditionalExpression: `if (event.wasClean) {` => `true`
- L130:13 ConditionalExpression: `if (event.wasClean) {` => `false`
- L132:16 BlockStatement: `} else {` => `{}`
- L137:13 ConditionalExpression: `if (this.open || this.opening) {` => `true`
- L137:13 ConditionalExpression: `if (this.open || this.opening) {` => `false`
- L137:13 LogicalOperator: `if (this.open || this.opening) {` => `this.open && this.opening`
- L137:40 BlockStatement: `if (this.open || this.opening) {` => `{}`
- L138:25 BooleanLiteral: `this.open = false;` => `true`
- L139:28 BooleanLiteral: `this.opening = false;` => `true`

`frontend/app/store/ws.ts` `pushMessage` (11 survivors):

- L234:13 ConditionalExpression: `if (!this.open) {` => `true`
- L235:17 ConditionalExpression: `if (data.wscommand === "rpc" && data.message) {` => `true`
- L235:17 ConditionalExpression: `if (data.wscommand === "rpc" && data.message) {` => `false`
- L235:17 ConditionalExpression: `if (data.wscommand === "rpc" && data.message) {` => `true`
- L235:17 LogicalOperator: `if (data.wscommand === "rpc" && data.message) {` => `data.wscommand === "rpc" || data.message`
- L235:17 EqualityOperator: `if (data.wscommand === "rpc" && data.message) {` => `data.wscommand !== "rpc"`
- L235:59 BlockStatement: `if (data.wscommand === "rpc" && data.message) {` => `{}`
- L237:21 ConditionalExpression: `if (cmd === "routeannounce" || cmd === "routeunannounce") {` => `false`
- L237:21 LogicalOperator: `if (cmd === "routeannounce" || cmd === "routeunannounce") {` => `cmd === "routeannounce" && cmd === "routeunannounce"`
- L237:21 ConditionalExpression: `if (cmd === "routeannounce" || cmd === "routeunannounce") {` => `false`
- L237:48 ConditionalExpression: `if (cmd === "routeannounce" || cmd === "routeunannounce") {` => `false`

`frontend/app/store/ws.ts` `sendMessage` (8 survivors):

- L218:13 ConditionalExpression: `if (!this.open) {` => `false`
- L222:35 ArrayDeclaration: `const byteSize = new Blob([msg]).size;` => `[]`
- L223:13 ConditionalExpression: `if (byteSize > MaxWebSocketSendSize) {` => `false`
- L223:13 EqualityOperator: `if (byteSize > MaxWebSocketSendSize) {` => `byteSize >= MaxWebSocketSendSize`
- L227:13 ConditionalExpression: `if (byteSize > WarnWebSocketSendSize) {` => `false`
- L227:13 ConditionalExpression: `if (byteSize > WarnWebSocketSendSize) {` => `true`
- L227:13 EqualityOperator: `if (byteSize > WarnWebSocketSendSize) {` => `byteSize >= WarnWebSocketSendSize`
- L227:13 EqualityOperator: `if (byteSize > WarnWebSocketSendSize) {` => `byteSize <= WarnWebSocketSendSize`

`frontend/app/store/wshclient.ts` `handleIncomingCommand` (12 survivors):

- L111:70 BlockStatement: `const timeoutPromise = new Promise((_resolve, reject) => {` => `{}`
- L113:21 ArrowFunction: `() => reject(new Error('rpc handler for command "${msg.command}" timed out')),` => `() => undefined`
- L121:17 ConditionalExpression: `if (!helper.done) {` => `true`
- L125:17 ConditionalExpression: `if (!helper.done) {` => `true`
- L130:19 BlockStatement: `} finally {` => `{}`
- L131:17 ConditionalExpression: `if (timeoutId != null) {` => `true`
- L131:17 ConditionalExpression: `if (timeoutId != null) {` => `false`
- L131:17 EqualityOperator: `if (timeoutId != null) {` => `timeoutId == null`
- L131:36 BlockStatement: `if (timeoutId != null) {` => `{}`
- L134:17 BooleanLiteral: `if (!helper.done) {` => `helper.done`
- L134:17 ConditionalExpression: `if (!helper.done) {` => `true`
- L134:17 ConditionalExpression: `if (!helper.done) {` => `false`

`frontend/app/store/wshclient.ts` `recvRpcMessage` (10 survivors):

- L142:27 LogicalOperator: `const isRequest = msg.command != null || msg.reqid != null;` => `msg.command != null && msg.reqid != null`
- L142:27 ConditionalExpression: `const isRequest = msg.command != null || msg.reqid != null;` => `false`
- L142:50 ConditionalExpression: `const isRequest = msg.command != null || msg.reqid != null;` => `false`
- L147:13 ConditionalExpression: `if (msg.resid == null) {` => `false`
- L147:32 BlockStatement: `if (msg.resid == null) {` => `{}`
- L153:17 BooleanLiteral: `if (!notFoundLogMap.has(msg.resid)) {` => `notFoundLogMap.has(msg.resid)`
- L153:17 ConditionalExpression: `if (!notFoundLogMap.has(msg.resid)) {` => `true`
- L153:17 ConditionalExpression: `if (!notFoundLogMap.has(msg.resid)) {` => `false`
- L153:49 BlockStatement: `if (!notFoundLogMap.has(msg.resid)) {` => `{}`
- L154:47 BooleanLiteral: `notFoundLogMap.set(msg.resid, true);` => `false`

`frontend/app/store/wshrpcutil-base.ts` `rpcResponseGenerator` (9 survivors):

- L23:9 EqualityOperator: `if (timeout > 0) {` => `timeout >= 0`
- L33:43 ArrowFunction: `signalPromise = new Promise<void>((resolve) => (signalFn = resolve));` => `() => undefined`
- L49:21 ConditionalExpression: `if (!msg.cont && msg.data == null) {` => `false`
- L49:21 BooleanLiteral: `if (!msg.cont && msg.data == null) {` => `msg.cont`
- L57:21 ConditionalExpression: `if (!msg.cont) {` => `true`
- L65:13 ConditionalExpression: `if (timeoutId != null) {` => `true`
- L65:13 ConditionalExpression: `if (timeoutId != null) {` => `false`
- L65:13 EqualityOperator: `if (timeoutId != null) {` => `timeoutId == null`
- L65:32 BlockStatement: `if (timeoutId != null) {` => `{}`

`frontend/app/view/agents/agentcwd.ts` `agentCwd` (9 survivors):

- L12:19 MethodExpression: `const t = line.trim();` => `line`
- L13:13 ConditionalExpression: `if (!t) {` => `false`
- L13:17 BlockStatement: `if (!t) {` => `{}`
- L19:17 BlockStatement: `} catch {` => `{}`
- L22:13 LogicalOperator: `if (typeof obj?.cwd === "string" && obj.cwd) {` => `typeof obj?.cwd === "string" || obj.cwd`
- L22:13 ConditionalExpression: `if (typeof obj?.cwd === "string" && obj.cwd) {` => `true`
- L25:13 LogicalOperator: `if (obj?.type === "session_meta" && typeof obj?.payload?.cwd === "string" && obj.payload.cwd) {` => `obj?.type === "session_meta" || typeof obj?.payload?.cwd === "string"`
- L25:13 ConditionalExpression: `if (obj?.type === "session_meta" && typeof obj?.payload?.cwd === "string" && obj.payload.cwd) {` => `true`
- L25:45 ConditionalExpression: `if (obj?.type === "session_meta" && typeof obj?.payload?.cwd === "string" && obj.payload.cwd) {` => `true`

### Task 2: Kill the survivors in frontend/app/view/agents (agentcwdresolve.ts to cardgridlayout.ts)

**Depends on:** none
**Files:** `frontend/app/view/agents/agentcwdresolve.test.ts`, `frontend/app/view/agents/agentsessionstart.test.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/agents/agenttreemodel.test.ts`, `frontend/app/view/agents/ambient.test.ts`, `frontend/app/view/agents/ambientstore.test.ts`, `frontend/app/view/agents/answerbarpreview.test.ts`, `frontend/app/view/agents/cachestatusstore.test.ts`, `frontend/app/view/agents/canvasmodel.test.ts`, `frontend/app/view/agents/canvaspoller.test.ts`, `frontend/app/view/agents/canvasstore.test.ts`, `frontend/app/view/agents/cardgridlayout.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

These sources changed after the mutation run, so their line numbers can be off: `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/canvasmodel.ts`, `frontend/app/view/agents/canvasstore.ts`. Find each survivor by its source text; one whose line no longer exists goes under Not reached with the reason.

`frontend/app/view/agents/agentcwdresolve.ts` `blockCwd` (5 survivors):

- L23:9 ConditionalExpression: `if (!blockId) {` => `false`
- L23:19 BlockStatement: `if (!blockId) {` => `{}`
- L29:16 ConditionalExpression: `return typeof cwd === "string" && cwd ? cwd : null;` => `true`
- L29:16 LogicalOperator: `return typeof cwd === "string" && cwd ? cwd : null;` => `typeof cwd === "string" || cwd`
- L29:16 ConditionalExpression: `return typeof cwd === "string" && cwd ? cwd : null;` => `true`

`frontend/app/view/agents/agentsessionstart.ts` `sessionStartTs` (6 survivors):

- L9:19 MethodExpression: `const t = line.trim();` => `line`
- L10:13 ConditionalExpression: `if (!t) {` => `false`
- L10:17 BlockStatement: `if (!t) {` => `{}`
- L16:17 BlockStatement: `} catch {` => `{}`
- L19:13 ConditionalExpression: `if (typeof obj?.timestamp === "string") {` => `true`
- L21:17 ConditionalExpression: `if (!Number.isNaN(ms)) {` => `true`

`frontend/app/view/agents/agentsviewmodel.ts` `isAskStale` (8 survivors):

- L833:9 ConditionalExpression: `if (askTs == null || statusTs == null) {` => `false`
- L833:9 LogicalOperator: `if (askTs == null || statusTs == null) {` => `askTs == null && statusTs == null`
- L833:9 ConditionalExpression: `if (askTs == null || statusTs == null) {` => `false`
- L833:26 ConditionalExpression: `if (askTs == null || statusTs == null) {` => `false`
- L833:44 BlockStatement: `if (askTs == null || statusTs == null) {` => `{}`
- L836:9 ConditionalExpression: `if (statusState !== "working") {` => `false`
- L836:36 BlockStatement: `if (statusState !== "working") {` => `{}`
- L839:12 EqualityOperator: `return statusTs - askTs > ASK_STALE_GRACE_MS;` => `statusTs - askTs >= ASK_STALE_GRACE_MS`

`frontend/app/view/agents/agentsviewmodel.ts` `groupTimeline` (8 survivors):

- L260:20 UnaryOperator: `let runStart = -1;` => `+1`
- L263:13 ConditionalExpression: `if (run.length === 0) {` => `false`
- L263:31 BlockStatement: `if (run.length === 0) {` => `{}`
- L266:40 MethodExpression: `if (run.length >= threshold && run.every((a) => isEditAction(a))) {` => `run.some(a => isEditAction(a))`
- L271:84 ArithmeticOperator: `run.forEach((action, k) => items.push({ kind: "action", action, index: runStart + k }));` => `runStart - k`
- L274:20 UnaryOperator: `runStart = -1;` => `+1`
- L287:20 ConditionalExpression: `} else if (e.kind === "user") {` => `false`
- L302:20 ConditionalExpression: `} else if (e.kind === "interrupted") {` => `true`

`frontend/app/view/agents/agentsviewmodel.ts` `answerHint` (7 survivors):

- L745:9 ConditionalExpression: `if (questions.length === 0) {` => `false`
- L745:33 BlockStatement: `if (questions.length === 0) {` => `{}`
- L749:22 MethodExpression: `const hasTyped = questions.some((_, qi) => (texts[qi] ?? "").trim() !== "");` => `questions.every((_, qi) => (texts[qi] ?? "").trim() !== "")`
- L749:48 MethodExpression: `const hasTyped = questions.some((_, qi) => (texts[qi] ?? "").trim() !== "");` => `texts[qi] ?? ""`
- L757:24 EqualityOperator: `(_, qi) => (selections[qi]?.size ?? 0) > 0 || (texts[qi] ?? "").trim() !== ""` => `(selections[qi]?.size ?? 0) <= 0`
- L757:59 ConditionalExpression: `(_, qi) => (selections[qi]?.size ?? 0) > 0 || (texts[qi] ?? "").trim() !== ""` => `false`
- L757:59 MethodExpression: `(_, qi) => (selections[qi]?.size ?? 0) > 0 || (texts[qi] ?? "").trim() !== ""` => `texts[qi] ?? ""`

`frontend/app/view/agents/agentsviewmodel.ts` `isEditAction` (6 survivors):

- L254:12 LogicalOperator: `return e.kind === "action" && (e.verb === "edited" || e.verb === "wrote") && e.detail?.kind === "edit";` => `e.kind === "action" || e.verb === "edited" || e.verb === "wrote"`
- L254:12 ConditionalExpression: `return e.kind === "action" && (e.verb === "edited" || e.verb === "wrote") && e.detail?.kind === "edit";` => `true`
- L254:12 ConditionalExpression: `return e.kind === "action" && (e.verb === "edited" || e.verb === "wrote") && e.detail?.kind === "edit";` => `true`
- L254:36 ConditionalExpression: `return e.kind === "action" && (e.verb === "edited" || e.verb === "wrote") && e.detail?.kind === "edit";` => `true`
- L254:59 EqualityOperator: `return e.kind === "action" && (e.verb === "edited" || e.verb === "wrote") && e.detail?.kind === "edit";` => `e.verb !== "wrote"`
- L254:59 ConditionalExpression: `return e.kind === "action" && (e.verb === "edited" || e.verb === "wrote") && e.detail?.kind === "edit";` => `false`

`frontend/app/view/agents/agentsviewmodel.ts` `moveCursor` (5 survivors):

- L635:9 ConditionalExpression: `if (ids.length === 0) {` => `false`
- L635:27 BlockStatement: `if (ids.length === 0) {` => `{}`
- L638:17 ConditionalExpression: `const idx = current != null ? ids.indexOf(current) : -1;` => `true`
- L639:9 ConditionalExpression: `if (idx === -1) {` => `false`
- L639:21 BlockStatement: `if (idx === -1) {` => `{}`

`frontend/app/view/agents/agenttreemodel.ts` `buildAgentTree` (10 survivors):

- L264:20 LogicalOperator: `(a, b) => (rank.get(a.id) ?? Number.POSITIVE_INFINITY) - (rank.get(b.id) ?? Number.POSITIVE_INFINITY)` => `rank.get(a.id) && Number.POSITIVE_INFINITY`
- L288:44 BlockStatement: `for (const [runId, byTask] of workers) {` => `{}`
- L290:46 BlockStatement: `for (const [taskId, list] of byTask) {` => `{}`
- L291:13 MethodExpression: `list.sort((a, b) => Number(holdsTask(run, taskId, b)) - Number(holdsTask(run, taskId, a)));` => `list`
- L291:23 ArrowFunction: `list.sort((a, b) => Number(holdsTask(run, taskId, b)) - Number(holdsTask(run, taskId, a)));` => `() => undefined`
- L291:33 ArithmeticOperator: `list.sort((a, b) => Number(holdsTask(run, taskId, b)) - Number(holdsTask(run, taskId, a)));` => `Number(holdsTask(run, taskId, b)) + Number(holdsTask(run, taskId, a))`
- L309:38 ConditionalExpression: `if (role?.kind === "lead" && leads.get(role.runId) === a) {` => `true`
- L339:47 ArrayDeclaration: `stages.get(item.run.runId) ?? [],` => `["Stryker was here"]`
- L345:21 ArithmeticOperator: `attn += r.attn + (item.kind === "lead" && item.agent.state === "asking" ? 1 : 0);` => `r.attn - (item.kind === "lead" && item.agent.state === "asking" ? 1 : 0)`
- L345:31 ConditionalExpression: `attn += r.attn + (item.kind === "lead" && item.agent.state === "asking" ? 1 : 0);` => `false`

`frontend/app/view/agents/agenttreemodel.ts` `runRows` (9 survivors):

- L167:43 ArrayDeclaration: `const final = finalStageView(run.dag, [], 0);` => `["Stryker was here"]`
- L170:30 ConditionalExpression: `? stages.find((s) => verifierRunId != null && s.agent.runId === verifierRunId)?.agent` => `true`
- L175:26 ConditionalExpression: `const finalRunning = finalRow != null && final.tone === "run";` => `true`
- L176:25 ConditionalExpression: `const finalPassed = finalRow != null && final.tone === "pass";` => `true`
- L183:17 ConditionalExpression: `s.stageRole === "plan-reviewer" ? planReviewerOf(run.dag?.planreview, s.agent.runId)?.lens : undefined,` => `true`
- L199:13 ConditionalExpression: `extras.length > 0 &&` => `true`
- L199:13 EqualityOperator: `extras.length > 0 &&` => `extras.length >= 0`
- L200:71 MethodExpression: `(folds.extrasOpen.has(taskFoldKey(run.runId, task.id)) || extras.some((a) => a.state === "asking"));` => `extras.every(a => a.state === "asking")`
- L218:78 ArrayDeclaration: `(finalPassed && finalRowFocusId(run, verifier ? [verifier] : []) === focusId);` => `["Stryker was here"]`

`frontend/app/view/agents/agenttreemodel.ts` `stageOutcome` (5 survivors):

- L123:9 LogicalOperator: `if (cur == null || agentRunId == null) {` => `cur == null && agentRunId == null`
- L123:9 ConditionalExpression: `if (cur == null || agentRunId == null) {` => `false`
- L123:24 ConditionalExpression: `if (cur == null || agentRunId == null) {` => `false`
- L126:9 ConditionalExpression: `if (stageRole === "plan-reviewer") {` => `true`
- L131:16 ConditionalExpression: `} else if (run.dag.final.verifierrunid === agentRunId) {` => `false`

`frontend/app/view/agents/ambient.ts` `makeAmbientProvider` (8 survivors):

- L65:25 ArrowFunction: `now: () => number = () => Date.now()` => `() => undefined`
- L68:36 ArrayDeclaration: `for (const t of data?.tasks ?? []) {` => `["Stryker was here"]`
- L72:36 ArrayDeclaration: `for (const e of data?.edges ?? []) {` => `["Stryker was here"]`
- L81:40 ArrayDeclaration: `for (const d of data?.decisions ?? []) {` => `["Stryker was here"]`
- L96:17 ConditionalExpression: `if (seen.has(e.dossierid)) continue;` => `false`
- L105:41 ArrayDeclaration: `for (const link of ref.links ?? []) {` => `["Stryker was here"]`
- L122:25 ConditionalExpression: `if (seen.has(d.id)) continue;` => `false`
- L127:20 MethodExpression: `return out.slice(0, MAX_DECISIONS);` => `out`

`frontend/app/view/agents/ambientstore.ts` `ensureAmbient` (7 survivors):

- L31:9 ConditionalExpression: `if (loaded || inflight != null) {` => `false`
- L31:9 LogicalOperator: `if (loaded || inflight != null) {` => `loaded && inflight != null`
- L31:19 ConditionalExpression: `if (loaded || inflight != null) {` => `false`
- L36:74 ObjectLiteral: `const rtn = await RpcApi.ResolveAmbientCommand(TabRpcClient, { timeout: AMBIENT_TIMEOUT_MS });` => `{}`
- L37:46 LogicalOperator: `globalStore.set(ambientDataAtom, rtn ?? null);` => `rtn && null`
- L38:22 BooleanLiteral: `loaded = true;` => `false`
- L41:19 BlockStatement: `} finally {` => `{}`

`frontend/app/view/agents/answerbarpreview.ts` `previewBody` (6 survivors):

- L32:51 MethodExpression: `const fences = lines.filter((l) => FENCE.test(l.trim())).length;` => `l`
- L34:9 EqualityOperator: `lines.length >= 2 && fences === 2 && FENCE.test(lines[0].trim()) && lines[lines.length - 1].trim() === "'''";` => `lines.length > 2`
- L34:9 ConditionalExpression: `lines.length >= 2 && fences === 2 && FENCE.test(lines[0].trim()) && lines[lines.length - 1].trim() === "'''";` => `true`
- L34:57 MethodExpression: `lines.length >= 2 && fences === 2 && FENCE.test(lines[0].trim()) && lines[lines.length - 1].trim() === "'''";` => `lines[0]`
- L34:77 ConditionalExpression: `lines.length >= 2 && fences === 2 && FENCE.test(lines[0].trim()) && lines[lines.length - 1].trim() === "'''";` => `true`
- L34:77 MethodExpression: `lines.length >= 2 && fences === 2 && FENCE.test(lines[0].trim()) && lines[lines.length - 1].trim() === "'''";` => `lines[lines.length - 1]`

`frontend/app/view/agents/cachestatusstore.ts` `loadCacheStatusForAgent` (7 survivors):

- L33:9 ConditionalExpression: `if (!transcriptPath) {` => `false`
- L37:70 ObjectLiteral: `const rtn = await RpcApi.GetCacheStatusCommand(TabRpcClient, { path: transcriptPath });` => `{}`
- L38:13 ConditionalExpression: `if (current.id !== id) {` => `false`
- L42:13 BlockStatement: `} catch {` => `{}`
- L43:13 ConditionalExpression: `if (current.id === id && !opts?.silent) {` => `false`
- L43:13 ConditionalExpression: `if (current.id === id && !opts?.silent) {` => `true`
- L43:13 EqualityOperator: `if (current.id === id && !opts?.silent) {` => `current.id !== id`

`frontend/app/view/agents/canvasmodel.ts` `placeBoards` (12 survivors):

- L45:23 ConditionalExpression: `const title = isRecord(entry) && typeof entry.title === "string" && entry.title ? entry.title : undefined;` => `true`
- L45:23 LogicalOperator: `const title = isRecord(entry) && typeof entry.title === "string" && entry.title ? entry.title : undefined;` => `isRecord(entry) && typeof entry.title === "string" || entry.title`
- L45:23 ConditionalExpression: `const title = isRecord(entry) && typeof entry.title === "string" && entry.title ? entry.title : undefined;` => `true`
- L45:23 LogicalOperator: `const title = isRecord(entry) && typeof entry.title === "string" && entry.title ? entry.title : undefined;` => `isRecord(entry) || typeof entry.title === "string"`
- L45:42 ConditionalExpression: `const title = isRecord(entry) && typeof entry.title === "string" && entry.title ? entry.title : undefined;` => `true`
- L48:16 ConditionalExpression: `x: x != null && y != null ? x : right,` => `false`
- L48:16 ConditionalExpression: `x: x != null && y != null ? x : right,` => `true`
- L48:16 EqualityOperator: `x: x != null && y != null ? x : right,` => `x == null`
- L49:16 ConditionalExpression: `y: x != null && y != null ? y : 0,` => `false`
- L49:16 ConditionalExpression: `y: x != null && y != null ? y : 0,` => `true`
- L49:16 EqualityOperator: `y: x != null && y != null ? y : 0,` => `x == null`
- L52:17 ConditionalExpression: `...(title != null ? { title } : {}),` => `true`

`frontend/app/view/agents/canvasmodel.ts` `boardsFromCanvasJson` (8 survivors):

- L66:48 ConditionalExpression: `const known = (n: unknown): n is string => typeof n === "string" && n.endsWith(BOARD_EXT) && n in boards;` => `true`
- L66:48 LogicalOperator: `const known = (n: unknown): n is string => typeof n === "string" && n.endsWith(BOARD_EXT) && n in boards;` => `typeof n === "string" || n.endsWith(BOARD_EXT)`
- L66:48 ConditionalExpression: `const known = (n: unknown): n is string => typeof n === "string" && n.endsWith(BOARD_EXT) && n in boards;` => `true`
- L68:9 ConditionalExpression: `if (names.length === 0) {` => `true`
- L69:17 MethodExpression: `names = Object.keys(boards).filter(known);` => `Object.keys(boards)`
- L70:37 ConditionalExpression: `names.sort((a, b) => Number(b === MAIN_BOARD) - Number(a === MAIN_BOARD));` => `false`
- L70:64 ConditionalExpression: `names.sort((a, b) => Number(b === MAIN_BOARD) - Number(a === MAIN_BOARD));` => `true`
- L72:9 ConditionalExpression: `if (names.length === 0) {` => `false`

`frontend/app/view/agents/canvaspoller.ts` `readServer` (7 survivors):

- L47:9 ConditionalExpression: `if (res.status === "error") {` => `false`
- L47:33 BlockStatement: `if (res.status === "error") {` => `{}`
- L50:41 ConditionalExpression: `const boards = boardsFromCanvasJson(res.status === HTTP_OK ? res.json : undefined);` => `true`
- L52:9 ConditionalExpression: `if (heads.some((h) => h.status === "error")) {` => `false`
- L52:9 MethodExpression: `if (heads.some((h) => h.status === "error")) {` => `heads.every(h => h.status === "error")`
- L52:20 ArrowFunction: `if (heads.some((h) => h.status === "error")) {` => `() => undefined`
- L52:27 ConditionalExpression: `if (heads.some((h) => h.status === "error")) {` => `false`

`frontend/app/view/agents/canvasstore.ts` `attachCanvas` (5 survivors):

- L63:22 LogicalOperator: `const keep = board === prev.board && all === prev.all;` => `board === prev.board || all === prev.all`
- L63:22 ConditionalExpression: `const keep = board === prev.board && all === prev.all;` => `true`
- L63:22 ConditionalExpression: `const keep = board === prev.board && all === prev.all;` => `true`
- L63:46 ConditionalExpression: `const keep = board === prev.board && all === prev.all;` => `true`
- L66:110 ArrayDeclaration: `next = { ...prev, dir: a.dir, projectDir: a.projectDir, board, all, base, marks: keep ? prev.marks : [] };` => `["Stryker was here"]`

`frontend/app/view/agents/cardgridlayout.ts` `resolveCursor` (6 survivors):

- L167:9 ConditionalExpression: `if (nav.length === 0) {` => `false`
- L167:27 BlockStatement: `if (nav.length === 0) {` => `{}`
- L170:9 ConditionalExpression: `if (cur != null && nav.includes(cur)) {` => `true`
- L173:21 ConditionalExpression: `const aliased = cur != null ? alias[cur] : undefined;` => `true`
- L174:12 ConditionalExpression: `return aliased != null && nav.includes(aliased) ? aliased : nav[0];` => `true`
- L174:12 LogicalOperator: `return aliased != null && nav.includes(aliased) ? aliased : nav[0];` => `aliased != null || nav.includes(aliased)`

### Task 3: Kill the survivors in frontend/app/view/agents (channelsstore.ts to filesstore.ts)

**Depends on:** none
**Files:** `frontend/app/view/agents/channelsstore.test.ts`, `frontend/app/view/agents/codextranscriptprojection.test.ts`, `frontend/app/view/agents/comparestore.test.ts`, `frontend/app/view/agents/diffcontentstore.test.ts`, `frontend/app/view/agents/diffoptions.test.ts`, `frontend/app/view/agents/docreview.test.ts`, `frontend/app/view/agents/docreviewnotes.test.ts`, `frontend/app/view/agents/filesstore.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/view/agents/channelsstore.ts` `refreshActiveChannelStreams` (13 survivors):

- L48:78 BlockStatement: `async function refreshActiveChannelStreams(channelId: string): Promise<void> {` => `{}`
- L49:18 ConditionalExpression: `const held = runsChannelId === channelId ? globalStore.get(activeChannelRunsAtom) : [];` => `true`
- L49:18 ConditionalExpression: `const held = runsChannelId === channelId ? globalStore.get(activeChannelRunsAtom) : [];` => `false`
- L49:18 EqualityOperator: `const held = runsChannelId === channelId ? globalStore.get(activeChannelRunsAtom) : [];` => `runsChannelId !== channelId`
- L49:89 ArrayDeclaration: `const held = runsChannelId === channelId ? globalStore.get(activeChannelRunsAtom) : [];` => `["Stryker was here"]`
- L51:58 ObjectLiteral: `RpcApi.GetChannelRunChangesCommand(TabRpcClient, { channelid: channelId, known: knownRunVersions(held) }),` => `{}`
- L52:56 ObjectLiteral: `RpcApi.GetChannelMessagesCommand(TabRpcClient, { channelid: channelId }),` => `{}`
- L55:9 ConditionalExpression: `if (globalStore.get(activeChannelIdAtom) !== channelId) {` => `false`
- L55:9 ConditionalExpression: `if (globalStore.get(activeChannelIdAtom) !== channelId) {` => `true`
- L55:9 EqualityOperator: `if (globalStore.get(activeChannelIdAtom) !== channelId) {` => `globalStore.get(activeChannelIdAtom) === channelId`
- L59:66 LogicalOperator: `globalStore.set(activeChannelRunsAtom, mergeRunChanges(held, runsRtn.runids ?? [], runsRtn.runs ?? []));` => `runsRtn.runids && []`
- L59:88 LogicalOperator: `globalStore.set(activeChannelRunsAtom, mergeRunChanges(held, runsRtn.runids ?? [], runsRtn.runs ?? []));` => `runsRtn.runs && []`
- L60:48 LogicalOperator: `globalStore.set(activeChannelMessagesAtom, msgsRtn.messages ?? []);` => `msgsRtn.messages && []`

`frontend/app/view/agents/codextranscriptprojection.ts` `extractCodexTasks` (10 survivors):

- L191:13 ConditionalExpression: `if (rec?.type !== "response_item") {` => `false`
- L195:13 ConditionalExpression: `if (p?.type !== "function_call" || p.name !== "update_plan" || typeof p.arguments !== "string") {` => `false`
- L195:13 LogicalOperator: `if (p?.type !== "function_call" || p.name !== "update_plan" || typeof p.arguments !== "string") {` => `(p?.type !== "function_call" || p.name !== "update_plan") && typeof p.arguments !== "string"`
- L195:13 LogicalOperator: `if (p?.type !== "function_call" || p.name !== "update_plan" || typeof p.arguments !== "string") {` => `p?.type !== "function_call" && p.name !== "update_plan"`
- L195:13 ConditionalExpression: `if (p?.type !== "function_call" || p.name !== "update_plan" || typeof p.arguments !== "string") {` => `false`
- L195:13 ConditionalExpression: `if (p?.type !== "function_call" || p.name !== "update_plan" || typeof p.arguments !== "string") {` => `false`
- L195:44 ConditionalExpression: `if (p?.type !== "function_call" || p.name !== "update_plan" || typeof p.arguments !== "string") {` => `false`
- L195:72 ConditionalExpression: `if (p?.type !== "function_call" || p.name !== "update_plan" || typeof p.arguments !== "string") {` => `false`
- L195:105 BlockStatement: `if (p?.type !== "function_call" || p.name !== "update_plan" || typeof p.arguments !== "string") {` => `{}`
- L200:17 ConditionalExpression: `if (Array.isArray(a?.plan)) {` => `true`

`frontend/app/view/agents/codextranscriptprojection.ts` `outputIsError` (9 survivors):

- L79:9 ConditionalExpression: `if (typeof output !== "string") {` => `false`
- L82:28 Regex: `const m = output.match(/Exit code:\s*(\d+)/);` => `/Exit code:\s(\d+)/`
- L82:28 Regex: `const m = output.match(/Exit code:\s*(\d+)/);` => `/Exit code:\s*(\d)/`
- L86:9 BlockStatement: `try {` => `{}`
- L88:13 ConditionalExpression: `if (typeof parsed?.metadata?.exit_code === "number") {` => `true`
- L88:13 ConditionalExpression: `if (typeof parsed?.metadata?.exit_code === "number") {` => `false`
- L88:13 EqualityOperator: `if (typeof parsed?.metadata?.exit_code === "number") {` => `typeof parsed?.metadata?.exit_code !== "number"`
- L88:62 BlockStatement: `if (typeof parsed?.metadata?.exit_code === "number") {` => `{}`
- L89:20 ConditionalExpression: `return parsed.metadata.exit_code !== 0;` => `false`

`frontend/app/view/agents/comparestore.ts` `setCompareRefs` (13 survivors):

- L135:9 ConditionalExpression: `if (scope?.range.kind === "compare") {` => `true`
- L135:9 ConditionalExpression: `if (scope?.range.kind === "compare") {` => `false`
- L135:9 EqualityOperator: `if (scope?.range.kind === "compare") {` => `scope?.range.kind !== "compare"`
- L135:42 BlockStatement: `if (scope?.range.kind === "compare") {` => `{}`
- L147:9 ConditionalExpression: `if (!base || !head) {` => `false`
- L147:9 LogicalOperator: `if (!base || !head) {` => `!base && !head`
- L158:13 ConditionalExpression: `if (current.token !== token) {` => `false`
- L161:13 ConditionalExpression: `if (!div.isrepo || !agg.isrepo) {` => `false`
- L161:13 LogicalOperator: `if (!div.isrepo || !agg.isrepo) {` => `!div.isrepo && !agg.isrepo`
- L166:20 LogicalOperator: `ahead: div.ahead ?? [],` => `div.ahead && []`
- L167:21 LogicalOperator: `behind: div.behind ?? [],` => `div.behind && []`
- L174:13 ConditionalExpression: `if (first) {` => `true`
- L174:13 ConditionalExpression: `if (first) {` => `false`

`frontend/app/view/agents/comparestore.ts` `runFetch` (5 survivors):

- L236:24 ObjectLiteral: `setFetchState(cwd, { running: true, failure: null });` => `{}`
- L236:35 BooleanLiteral: `setFetchState(cwd, { running: true, failure: null });` => `false`
- L238:62 ObjectLiteral: `const r = await RpcApi.GitFetchCommand(TabRpcClient, { cwd }, { timeout: 60000 });` => `{}`
- L238:71 ObjectLiteral: `const r = await RpcApi.GitFetchCommand(TabRpcClient, { cwd }, { timeout: 60000 });` => `{}`
- L249:13 ConditionalExpression: `if (refs != null) {` => `true`

`frontend/app/view/agents/diffcontentstore.ts` `readSide` (6 survivors):

- L55:69 ObjectLiteral: `const data = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: joinRepoPath(cwd, path) } });` => `{}`
- L55:77 ObjectLiteral: `const data = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: joinRepoPath(cwd, path) } });` => `{}`
- L69:45 BooleanLiteral: `return { text: r.content ?? "", binary: !!r.binary, tooLarge: !!r.toolarge, size: r.size ?? 0 };` => `!r.binary`
- L69:46 BooleanLiteral: `return { text: r.content ?? "", binary: !!r.binary, tooLarge: !!r.toolarge, size: r.size ?? 0 };` => `r.binary`
- L69:67 BooleanLiteral: `return { text: r.content ?? "", binary: !!r.binary, tooLarge: !!r.toolarge, size: r.size ?? 0 };` => `!r.toolarge`
- L69:68 BooleanLiteral: `return { text: r.content ?? "", binary: !!r.binary, tooLarge: !!r.toolarge, size: r.size ?? 0 };` => `r.toolarge`

`frontend/app/view/agents/diffoptions.ts` `paneOptions` (6 survivors):

- L38:31 BooleanLiteral: `scrollBeyondLastLine: false,` => `true`
- L39:18 ObjectLiteral: `minimap: { enabled: false },` => `{}`
- L39:29 BooleanLiteral: `minimap: { enabled: false },` => `true`
- L42:26 BooleanLiteral: `smoothScrolling: true,` => `false`
- L43:20 ObjectLiteral: `scrollbar: { useShadows: false, verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },` => `{}`
- L43:34 BooleanLiteral: `scrollbar: { useShadows: false, verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },` => `true`

`frontend/app/view/agents/docreview.ts` `parseDocReview` (9 survivors):

- L46:34 ArrayDeclaration: `const qs = ask?.questions ?? [];` => `["Stryker was here"]`
- L54:19 MethodExpression: `const lines = qs[0].question` => `qs[0].question.split(/\r?\n/).map(l => l.trim())`
- L56:21 MethodExpression: `.map((l) => l.trim())` => `l`
- L58:43 Regex: `const path = (lines[0] ?? "").replace(/^'|'$/g, "");` => `/'|'$/g`
- L58:43 Regex: `const path = (lines[0] ?? "").replace(/^'|'$/g, "");` => `/^'|'/g`
- L65:24 ConditionalExpression: `const introLines = firstItem < 0 ? rest : rest.slice(0, firstItem);` => `false`
- L66:76 MethodExpression: `const items = rest.filter((l) => l.startsWith(ITEM_PREFIX)).map((l) => l.slice(ITEM_PREFIX.length).trim());` => `l.slice(ITEM_PREFIX.length)`
- L67:53 MethodExpression: `const labels = (qs[0].options ?? []).map((o) => o.label.replace(RECOMMENDED, " ").trim().toLowerCase());` => `o.label.replace(RECOMMENDED, " ")`
- L68:50 MethodExpression: `const requestIndex = labels.findIndex((l) => l.startsWith(REQUEST_LABEL));` => `l.endsWith(REQUEST_LABEL)`

`frontend/app/view/agents/docreviewnotes.ts` `isPaintable` (11 survivors):

- L63:9 ConditionalExpression: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `false`
- L63:9 LogicalOperator: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `(note.start < 0 || note.end > docText.length) && note.start >= note.end`
- L63:9 ConditionalExpression: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `false`
- L63:9 LogicalOperator: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `note.start < 0 && note.end > docText.length`
- L63:9 ConditionalExpression: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `false`
- L63:9 EqualityOperator: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `note.start <= 0`
- L63:27 ConditionalExpression: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `false`
- L63:27 EqualityOperator: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `note.end >= docText.length`
- L63:56 EqualityOperator: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `note.start > note.end`
- L63:56 ConditionalExpression: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `false`
- L63:80 BlockStatement: `if (note.start < 0 || note.end > docText.length || note.start >= note.end) {` => `{}`

`frontend/app/view/agents/filesstore.ts` `loadChangesForCwd` (9 survivors):

- L62:15 BlockStatement: `if (!cwd) {` => `{}`
- L63:13 ConditionalExpression: `if (current.token === token) {` => `false`
- L63:13 EqualityOperator: `if (current.token === token) {` => `current.token !== token`
- L63:13 ConditionalExpression: `if (current.token === token) {` => `true`
- L63:38 BlockStatement: `if (current.token === token) {` => `{}`
- L74:13 ConditionalExpression: `if (current.token !== token) {` => `false`
- L81:106 LogicalOperator: `globalStore.set(filesStateAtom, { cwd, branch: ch.branch, isRepo: ch.isrepo, changes, ref, head: ch.head ?? ""` => `ch.head && ""`
- L82:41 BooleanLiteral: `globalStore.set(filesErrorAtom, false);` => `true`
- L88:17 ConditionalExpression: `if (first) {` => `true`

### Task 4: Kill the survivors in frontend/app/view/agents (finalstage.ts to historyrows.ts)

**Depends on:** none
**Files:** `frontend/app/view/agents/finalstage.test.ts`, `frontend/app/view/agents/gitgraph.test.ts`, `frontend/app/view/agents/gitgraphgeom.test.ts`, `frontend/app/view/agents/githistorystore.test.ts`, `frontend/app/view/agents/gitstatus.test.ts`, `frontend/app/view/agents/historyrows.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`frontend/app/view/agents/finalstage.ts` `finalStageView` (20 survivors):

- L333:35 ArrayDeclaration: `const tasks = group?.tasks ?? [];` => `["Stryker was here"]`
- L334:9 ConditionalExpression: `if (group == null || tasks.length === 0) {` => `false`
- L354:47 EqualityOperator: `const startedTs = stage?.verifierrunid && steps.length > 1 ? undefined : stage?.startedts;` => `steps.length >= 1`
- L354:47 ConditionalExpression: `const startedTs = stage?.verifierrunid && steps.length > 1 ? undefined : stage?.startedts;` => `true`
- L360:42 ArrayDeclaration: `const reasons = stage?.unverified ?? [];` => `["Stryker was here"]`
- L372:22 ConditionalExpression: `const time = running.ms == null ? undefined : fmtDuration(running.ms);` => `false`
- L375:28 ArrayDeclaration: `headline = joinDot([roundText, "verifier reviewing", time]);` => `[]`
- L376:16 ConditionalExpression: `} else if (isRunning) {` => `false`
- L376:27 BlockStatement: `} else if (isRunning) {` => `{}`
- L379:39 ArrayDeclaration: `nodeMeta = headline = joinDot([roundText, "starting"]);` => `[]`
- L384:42 ConditionalExpression: `subline = joinDot(["unverified", reasons.length > 0 ? plural(reasons.length, "reason") : undefined]);` => `true`
- L384:42 EqualityOperator: `subline = joinDot(["unverified", reasons.length > 0 ? plural(reasons.length, "reason") : undefined]);` => `reasons.length >= 0`
- L391:19 ConditionalExpression: `subline = waitsOn.length > 0 ? '${roundText} after ${plural(waitsOn.length, "fix task")}' : roundText;` => `true`
- L391:19 EqualityOperator: `subline = waitsOn.length > 0 ? '${roundText} after ${plural(waitsOn.length, "fix task")}' : roundText;` => `waitsOn.length >= 0`
- L392:31 ConditionalExpression: `nodeMeta = headline = waitsOn.length > 0 ? '${roundText} waits on ${waitsOn.join(", ")}' : roundText;` => `true`
- L392:31 EqualityOperator: `nodeMeta = headline = waitsOn.length > 0 ? '${roundText} waits on ${waitsOn.join(", ")}' : roundText;` => `waitsOn.length >= 0`
- L393:16 ConditionalExpression: `} else if (waitsOn.length > 0) {` => `true`
- L393:16 EqualityOperator: `} else if (waitsOn.length > 0) {` => `waitsOn.length >= 0`
- L396:12 BlockStatement: `} else {` => `{}`
- L398:39 ArrayDeclaration: `nodeMeta = headline = joinDot([roundText, "starting"]);` => `[]`

`frontend/app/view/agents/finalstage.ts` `endedAt` (12 survivors):

- L167:9 ConditionalExpression: `if (stage.state === "unverified") {` => `false`
- L167:39 BlockStatement: `if (stage.state === "unverified") {` => `{}`
- L168:16 ConditionalExpression: `return evs.get("tree")?.ok === false ? commands.indexOf("tree") : -1;` => `true`
- L168:75 UnaryOperator: `return evs.get("tree")?.ok === false ? commands.indexOf("tree") : -1;` => `+1`
- L173:9 ConditionalExpression: `if (detail !== "") {` => `true`
- L174:23 Regex: `const named = /^(Check|Verify|Final) '/.exec(detail)?.[1];` => `/(Check|Verify|Final) '/`
- L177:17 MethodExpression: `const ran = commands.filter((k) => evs.has(k));` => `commands`
- L177:33 ArrowFunction: `const ran = commands.filter((k) => evs.has(k));` => `() => undefined`
- L178:22 ArithmeticOperator: `const last = ran[ran.length - 1];` => `ran.length + 1`
- L179:12 ConditionalExpression: `return last != null && evs.get(last).ok === false ? commands.indexOf(last) : -1;` => `true`
- L179:12 ConditionalExpression: `return last != null && evs.get(last).ok === false ? commands.indexOf(last) : -1;` => `false`
- L179:82 UnaryOperator: `return last != null && evs.get(last).ok === false ? commands.indexOf(last) : -1;` => `+1`

`frontend/app/view/agents/finalstage.ts` `buildSteps` (8 survivors):

- L246:23 ConditionalExpression: `: state !== "waiting" && state !== "notrun"` => `true`
- L246:23 LogicalOperator: `: state !== "waiting" && state !== "notrun"` => `state !== "waiting" || state !== "notrun"`
- L246:23 ConditionalExpression: `: state !== "waiting" && state !== "notrun"` => `true`
- L246:46 ConditionalExpression: `: state !== "waiting" && state !== "notrun"` => `true`
- L251:20 ConditionalExpression: `} else if (state !== "waiting" && state !== "notrun") {` => `true`
- L251:20 LogicalOperator: `} else if (state !== "waiting" && state !== "notrun") {` => `state !== "waiting" || state !== "notrun"`
- L251:20 ConditionalExpression: `} else if (state !== "waiting" && state !== "notrun") {` => `true`
- L251:43 ConditionalExpression: `} else if (state !== "waiting" && state !== "notrun") {` => `true`

`frontend/app/view/agents/finalstage.ts` `finalStageActivity` (7 survivors):

- L447:9 ConditionalExpression: `if (final?.state === "verifying") {` => `false`
- L450:9 ConditionalExpression: `if (final?.state !== "checking" && final?.state !== "final") {` => `false`
- L450:40 ConditionalExpression: `if (final?.state !== "checking" && final?.state !== "final") {` => `true`
- L450:40 EqualityOperator: `if (final?.state !== "checking" && final?.state !== "final") {` => `final?.state === "final"`
- L454:12 ConditionalExpression: `return final.state === "checking" && final.verifierrunid ? '${step} · verifier alongside' : step;` => `false`
- L454:12 ConditionalExpression: `return final.state === "checking" && final.verifierrunid ? '${step} · verifier alongside' : step;` => `true`
- L454:12 EqualityOperator: `return final.state === "checking" && final.verifierrunid ? '${step} · verifier alongside' : step;` => `final.state !== "checking"`

`frontend/app/view/agents/finalstage.ts` `stepStates` (6 survivors):

- L201:40 ConditionalExpression: `const verifier = reviewing || (state === "checking" && !!stage.verifierrunid) ? "running" : "waiting";` => `true`
- L204:45 ConditionalExpression: `if (reviewing || i < at || (at < 0 && evs.has(k))) {` => `false`
- L204:45 LogicalOperator: `if (reviewing || i < at || (at < 0 && evs.has(k))) {` => `at < 0 || evs.has(k)`
- L204:45 ConditionalExpression: `if (reviewing || i < at || (at < 0 && evs.has(k))) {` => `true`
- L204:45 EqualityOperator: `if (reviewing || i < at || (at < 0 && evs.has(k))) {` => `at <= 0`
- L204:45 EqualityOperator: `if (reviewing || i < at || (at < 0 && evs.has(k))) {` => `at >= 0`

`frontend/app/view/agents/gitgraph.ts` `assignLanes` (16 survivors):

- L51:20 ConditionalExpression: `lane = free !== -1 ? free : slots.length;` => `false`
- L55:22 ArithmeticOperator: `for (let i = lane + 1; i < slots.length; i++) {` => `lane - 1`
- L55:32 EqualityOperator: `for (let i = lane + 1; i < slots.length; i++) {` => `i <= slots.length`
- L55:32 ConditionalExpression: `for (let i = lane + 1; i < slots.length; i++) {` => `false`
- L55:55 BlockStatement: `for (let i = lane + 1; i < slots.length; i++) {` => `{}`
- L56:17 ConditionalExpression: `if (slots[i] === commit.hash) {` => `false`
- L56:17 ConditionalExpression: `if (slots[i] === commit.hash) {` => `true`
- L56:17 EqualityOperator: `if (slots[i] === commit.hash) {` => `slots[i] !== commit.hash`
- L56:43 BlockStatement: `if (slots[i] === commit.hash) {` => `{}`
- L66:29 ConditionalExpression: `for (let i = 1; i < commit.parents.length; i++) {` => `false`
- L66:61 BlockStatement: `for (let i = 1; i < commit.parents.length; i++) {` => `{}`
- L70:16 ConditionalExpression: `while (slots.length > 0 && slots[slots.length - 1] === null) {` => `false`
- L70:16 ConditionalExpression: `while (slots.length > 0 && slots[slots.length - 1] === null) {` => `true`
- L70:16 EqualityOperator: `while (slots.length > 0 && slots[slots.length - 1] === null) {` => `slots.length >= 0`
- L70:16 EqualityOperator: `while (slots.length > 0 && slots[slots.length - 1] === null) {` => `slots.length <= 0`
- L70:42 ArithmeticOperator: `while (slots.length > 0 && slots[slots.length - 1] === null) {` => `slots.length + 1`

`frontend/app/view/agents/gitgraphgeom.ts` `graphGeometry` (11 survivors):

- L75:13 ConditionalExpression: `if (r.hash) {` => `true`
- L88:24 EqualityOperator: `const folded = row.lane > lastLane;` => `row.lane <= lastLane`
- L102:23 MethodExpression: `lane: Math.min(row.lane, par.lane),` => `Math.max(row.lane, par.lane)`
- L103:25 ConditionalExpression: `folded: folded || par.lane > lastLane,` => `true`
- L103:25 ConditionalExpression: `folded: folded || par.lane > lastLane,` => `false`
- L103:25 LogicalOperator: `folded: folded || par.lane > lastLane,` => `folded && par.lane > lastLane`
- L103:35 ConditionalExpression: `folded: folded || par.lane > lastLane,` => `false`
- L103:35 EqualityOperator: `folded: folded || par.lane > lastLane,` => `par.lane >= lastLane`
- L103:35 EqualityOperator: `folded: folded || par.lane > lastLane,` => `par.lane <= lastLane`
- L121:17 ConditionalExpression: `height: rows.length === 0 ? 0 : acc + BOTTOM_PAD,` => `false`
- L121:41 ArithmeticOperator: `height: rows.length === 0 ? 0 : acc + BOTTOM_PAD,` => `acc - BOTTOM_PAD`

`frontend/app/view/agents/gitgraphgeom.ts` `edgePath` (8 survivors):

- L57:17 ConditionalExpression: `const dir = x2 > x1 ? 1 : -1;` => `true`
- L57:17 ConditionalExpression: `const dir = x2 > x1 ? 1 : -1;` => `false`
- L57:17 EqualityOperator: `const dir = x2 > x1 ? 1 : -1;` => `x2 >= x1`
- L57:17 EqualityOperator: `const dir = x2 > x1 ? 1 : -1;` => `x2 <= x1`
- L57:31 UnaryOperator: `const dir = x2 > x1 ? 1 : -1;` => `+1`
- L58:35 ArithmeticOperator: `return 'M${x1} ${y1} L${x1} ${y2 - CURVE} Q${x1} ${y2} ${x1 + dir * CURVE} ${y2} L${x2} ${y2}';` => `y2 + CURVE`
- L58:62 ArithmeticOperator: `return 'M${x1} ${y1} L${x1} ${y2 - CURVE} Q${x1} ${y2} ${x1 + dir * CURVE} ${y2} L${x2} ${y2}';` => `x1 - dir * CURVE`
- L58:67 ArithmeticOperator: `return 'M${x1} ${y1} L${x1} ${y2 - CURVE} Q${x1} ${y2} ${x1 + dir * CURVE} ${y2} L${x2} ${y2}';` => `dir / CURVE`

`frontend/app/view/agents/githistorystore.ts` `loadMoreHistory` (11 survivors):

- L277:9 ConditionalExpression: `!cwd ||` => `false`
- L277:9 LogicalOperator: `!cwd ||` => `(!cwd || commits == null || !globalStore.get(historyHasMoreAtom)) && globalStore.get(historyAppendAtom) === "l`
- L277:9 ConditionalExpression: `!cwd ||` => `false`
- L277:9 LogicalOperator: `!cwd ||` => `(!cwd || commits == null) && !globalStore.get(historyHasMoreAtom)`
- L277:9 ConditionalExpression: `!cwd ||` => `false`
- L277:9 LogicalOperator: `!cwd ||` => `!cwd && commits == null`
- L278:9 ConditionalExpression: `commits == null ||` => `false`
- L280:9 ConditionalExpression: `globalStore.get(historyAppendAtom) === "loading"` => `false`
- L287:64 ObjectLiteral: `const h = await RpcApi.GitHistoryCommand(TabRpcClient, {` => `{}`
- L293:13 ConditionalExpression: `if (current.token !== token) {` => `false`
- L296:13 ConditionalExpression: `if (h.failure) {` => `false`

`frontend/app/view/agents/githistorystore.ts` `selectCommit` (10 survivors):

- L388:9 ConditionalExpression: `if (hash === WORKING_TREE) {` => `true`
- L392:13 ConditionalExpression: `if (first) {` => `true`
- L399:9 BlockStatement: `try {` => `{}`
- L400:71 ObjectLiteral: `const ch = await RpcApi.GitCommitChangesCommand(TabRpcClient, { cwd, hash });` => `{}`
- L401:13 ConditionalExpression: `if (globalStore.get(selectedCommitAtom) !== hash) {` => `true`
- L401:13 ConditionalExpression: `if (globalStore.get(selectedCommitAtom) !== hash) {` => `false`
- L401:13 EqualityOperator: `if (globalStore.get(selectedCommitAtom) !== hash) {` => `globalStore.get(selectedCommitAtom) === hash`
- L407:13 ConditionalExpression: `if (first) {` => `true`
- L407:13 ConditionalExpression: `if (first) {` => `false`
- L407:20 BlockStatement: `if (first) {` => `{}`

`frontend/app/view/agents/githistorystore.ts` `settleSelection` (8 survivors):

- L223:70 ArrayDeclaration: `const files = globalStore.get(filesStateAtom)?.changes?.files ?? [];` => `["Stryker was here"]`
- L232:9 ConditionalExpression: `if (pick == null) {` => `false`
- L237:9 ConditionalExpression: `if (pick !== prev || globalStore.get(selectedFileAtom) == null) {` => `true`
- L237:9 LogicalOperator: `if (pick !== prev || globalStore.get(selectedFileAtom) == null) {` => `pick !== prev && globalStore.get(selectedFileAtom) == null`
- L237:9 ConditionalExpression: `if (pick !== prev || globalStore.get(selectedFileAtom) == null) {` => `false`
- L237:9 EqualityOperator: `if (pick !== prev || globalStore.get(selectedFileAtom) == null) {` => `pick === prev`
- L237:26 EqualityOperator: `if (pick !== prev || globalStore.get(selectedFileAtom) == null) {` => `globalStore.get(selectedFileAtom) != null`
- L237:26 ConditionalExpression: `if (pick !== prev || globalStore.get(selectedFileAtom) == null) {` => `false`

`frontend/app/view/agents/githistorystore.ts` `loadHistory` (8 survivors):

- L152:9 ConditionalExpression: `if (!cwd) {` => `false`
- L171:9 ConditionalExpression: `if (globalStore.get(historyCommitsAtom) == null) {` => `true`
- L182:13 ConditionalExpression: `if (current.token !== token) {` => `false`
- L186:13 ConditionalExpression: `if (!h.isrepo) {` => `false`
- L191:13 ConditionalExpression: `if (h.failure) {` => `false`
- L205:13 ConditionalExpression: `if (current.token === token) {` => `true`
- L208:49 ArrayDeclaration: `globalStore.set(historyCommitsAtom, []);` => `["Stryker was here"]`
- L209:49 BooleanLiteral: `globalStore.set(historyHasMoreAtom, false);` => `true`

`frontend/app/view/agents/gitstatus.ts` `parseNumstat` (6 survivors):

- L54:13 ConditionalExpression: `if (!line.trim()) {` => `false`
- L54:14 MethodExpression: `if (!line.trim()) {` => `line`
- L54:27 BlockStatement: `if (!line.trim()) {` => `{}`
- L61:13 ConditionalExpression: `if (!path) {` => `false`
- L65:19 ConditionalExpression: `adds: a === "-" ? 0 : parseInt(a, 10) || 0,` => `false`
- L66:19 ConditionalExpression: `dels: d === "-" ? 0 : parseInt(d, 10) || 0,` => `false`

`frontend/app/view/agents/historyrows.ts` `buildRows` (8 survivors):

- L127:88 UnaryOperator: `const anchorIdx = opts.anchor ? commits.findIndex((c) => c.hash === opts.anchor) : -1;` => `+1`
- L130:18 LogicalOperator: `divider: anchorIdx >= 0 && i === anchorIdx ? opts.anchorLabel : undefined,` => `anchorIdx >= 0 || i === anchorIdx`
- L130:18 ConditionalExpression: `divider: anchorIdx >= 0 && i === anchorIdx ? opts.anchorLabel : undefined,` => `true`
- L130:18 EqualityOperator: `divider: anchorIdx >= 0 && i === anchorIdx ? opts.anchorLabel : undefined,` => `anchorIdx > 0`
- L130:36 ConditionalExpression: `divider: anchorIdx >= 0 && i === anchorIdx ? opts.anchorLabel : undefined,` => `true`
- L131:17 EqualityOperator: `before: anchorIdx >= 0 && i > anchorIdx,` => `anchorIdx > 0`
- L146:15 ArrayDeclaration: `refs: [],` => `["Stryker was here"]`
- L147:17 BooleanLiteral: `before: false,` => `true`
