# Mutation survivors, wave 1 of 5: fix the tests that miss behaviour

A mutation run over the repo (Stryker for `frontend/` and `claude/`, a custom overlay mutator for Go) changed one
operator, condition or call at a time and ran the tests. Each change listed below **survived**: the code was altered
and every test still passed. The lists were made on commit `c5f1c39c3`; a task names any of its sources that changed
since. The pilot (run 31c29f30, commit `4b178a0`) found 90% of survivors were real gaps in the tests and no code bugs.
This wave works the next part of the list, for the initiative 23e51be3.

**Verify:** `node scripts/verify.mjs ./pkg/agentask ./pkg/agentobserve ./pkg/agentsessions ./pkg/agentsync ./pkg/consult ./pkg/filestore ./pkg/gitinfo ./pkg/jarvis ./pkg/jarvisattrib ./pkg/jarviscontinuity ./pkg/jarvisstate ./pkg/memhygiene ./pkg/memroots ./pkg/reporadar ./pkg/secretstore ./pkg/storagereport ./pkg/streamclient ./pkg/usagestats ./pkg/wavevault ./pkg/wconfig ./pkg/wshutil`

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

### Task 1: Kill the survivors in pkg/agentask and 15 more (agentask to storagereport)

**Depends on:** none
**Files:** `pkg/agentask/*_test.go`, `pkg/agentobserve/*_test.go`, `pkg/agentsessions/*_test.go`, `pkg/agentsync/*_test.go`, `pkg/consult/*_test.go`, `pkg/filestore/*_test.go`, `pkg/gitinfo/*_test.go`, `pkg/jarvis/*_test.go`, `pkg/jarvisattrib/*_test.go`, `pkg/jarviscontinuity/*_test.go`, `pkg/jarvisstate/*_test.go`, `pkg/memhygiene/*_test.go`, `pkg/memroots/*_test.go`, `pkg/reporadar/*_test.go`, `pkg/secretstore/*_test.go`, `pkg/storagereport/*_test.go`

Follow "How every task works a survivor" above. Run one test with `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/x -run '^TestName$'`; the sqlite-backed packages fail without CGO. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`pkg/agentask/deliver.go` `injectAnswer` (5 survivors):

- L91:34 op: `typedForTask := typedText != "" && pending.DagOID != "" && pending.TaskId != ""` => `&& -> ||`
- L91:58 op: `typedForTask := typedText != "" && pending.DagOID != "" && pending.TaskId != ""` => `&& -> ||`
- L96:8 op: `if i > 0 {` => `> -> >=`
- L96:8 op: `if i > 0 {` => `> -> <=`
- L97:4 drop-call: `time.Sleep(KeystrokeDelay)` => `(call removed)`

`pkg/agentobserve/discover.go` `transcriptHead` (11 survivors):

- L97:2 drop-call: `sc.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024) // transcript lines can be large` => `(call removed)`
- L97:32 op: `sc.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024) // transcript lines can be large` => `* -> /`
- L97:41 op: `sc.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024) // transcript lines can be large` => `* -> /`
- L97:46 op: `sc.Buffer(make([]byte, 0, 1024*1024), 8*1024*1024) // transcript lines can be large` => `* -> /`
- L110:16 op: `if cwd == "" && rec.Cwd != "" {` => `&& -> ||`
- L113:14 op: `if startMs == 0 && rec.Timestamp != "" {` => `== -> !=`
- L113:19 op: `if startMs == 0 && rec.Timestamp != "" {` => `&& -> ||`
- L113:36 op: `if startMs == 0 && rec.Timestamp != "" {` => `!= -> ==`
- L118:10 op: `if cwd != "" && startMs != 0 {` => `!= -> ==`
- L118:16 op: `if cwd != "" && startMs != 0 {` => `&& -> ||`
- L118:27 op: `if cwd != "" && startMs != 0 {` => `!= -> ==`

`pkg/agentobserve/slug.go` `SlugifyCwd` (6 survivors):

- L27:2 drop-call: `b.Grow(len(cwd))` => `(call removed)`
- L29:21 op: `if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {` => `<= -> <`
- L29:35 op: `if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {` => `>= -> >`
- L29:47 op: `if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {` => `<= -> <`
- L29:61 op: `if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {` => `>= -> >`
- L29:73 op: `if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {` => `<= -> <`

`pkg/agentobserve/hooklog.go` `ParseHookLog` (5 survivors):

- L50:17 op: `if line == "" || !strings.Contains(line, "published") {` => `|| -> &&`
- L68:17 op: `if hs.FirstMs == 0 || ms < hs.FirstMs {` => `== -> !=`
- L68:22 op: `if hs.FirstMs == 0 || ms < hs.FirstMs {` => `|| -> &&`
- L68:28 op: `if hs.FirstMs == 0 || ms < hs.FirstMs {` => `< -> <=`
- L71:9 op: `if ms >= hs.LastMs {` => `>= -> >`

`pkg/agentsessions/agentsessions.go` `claudeEventsFrom` (9 survivors):

- L231:39 op: `if ts := parseTs(rec.Timestamp); ts > 0 {` => `> -> >=`
- L247:35 op: `if strings.TrimSpace(b.Text) != "" {` => `!= -> ==`
- L261:33 op: `} else if b.Name == "Bash" && commitRe.MatchString(cmd) {` => `&& -> ||`
- L279:15 op: `if b.Type == "text" && firstUser == "" {` => `== -> !=`
- L279:25 op: `if b.Type == "text" && firstUser == "" {` => `&& -> ||`
- L279:38 op: `if b.Type == "text" && firstUser == "" {` => `== -> !=`
- L282:32 op: `if b.Type == "tool_result" && b.IsError && b.ToolUseID != "" {` => `&& -> ||`
- L282:45 op: `if b.Type == "tool_result" && b.IsError && b.ToolUseID != "" {` => `&& -> ||`
- L297:19 op: `if lastAssistant != "" {` => `!= -> ==`

`pkg/agentsessions/agentsessions.go` `assembleEvents` (8 survivors):

- L579:11 op: `if e.Ts > 0 {` => `> -> >=`
- L583:2 drop-call: `sort.SliceStable(real, func(i, j int) bool { return real[i].Ts < real[j].Ts })` => `(call removed)`
- L583:65 op: `sort.SliceStable(real, func(i, j int) bool { return real[i].Ts < real[j].Ts })` => `< -> <=`
- L593:13 op: `if firstTs > 0 {` => `> -> >=`
- L597:32 op: `if status == "done" && lastTs > 0 {` => `> -> >=`
- L603:13 op: `if firstTs > 0 && lastTs > firstTs {` => `> -> >=`
- L603:17 op: `if firstTs > 0 && lastTs > firstTs {` => `&& -> ||`
- L603:27 op: `if firstTs > 0 && lastTs > firstTs {` => `> -> >=`

`pkg/agentsync/skills.go` `parseFrontmatterEntries` (6 survivors):

- L79:29 op: `topLevel := trimmed != "" && !strings.HasPrefix(trimmed, " ") && !strings.HasPrefix(trimmed, "\t") &&` => `&& -> ||`
- L79:65 op: `topLevel := trimmed != "" && !strings.HasPrefix(trimmed, " ") && !strings.HasPrefix(trimmed, "\t") &&` => `&& -> ||`
- L79:102 op: `topLevel := trimmed != "" && !strings.HasPrefix(trimmed, " ") && !strings.HasPrefix(trimmed, "\t") &&` => `&& -> ||`
- L80:37 op: `!strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "-")` => `&& -> ||`
- L81:15 op: `if topLevel && hasColon && key != "" {` => `&& -> ||`
- L85:15 op: `if len(out) > 0 {` => `> -> >=`

`pkg/consult/exec.go` `runPipe` (7 survivors):

- L77:13 op: `if stderr != nil {` => `!= -> ==`
- L78:4 drop-call: `stderr.Close()` => `(call removed)`
- L79:4 drop-call: `os.Remove(stderr.Name())` => `(call removed)`
- L99:4 drop-call: `stdout.Close()` => `(call removed)`
- L111:17 op: `if len(line) > 0 {` => `> -> >=`
- L113:22 op: `if ev.Err != nil && parseErr == nil {` => `&& -> ||`
- L129:9 op: `if n > 0 {` => `> -> >=`

`pkg/filestore/blockstore_cache.go` `CacheEntry.readAt` (7 survivors):

- L203:20 op: `size = file.Size - offset` => `- -> +`
- L205:17 op: `if offset+size > file.Size {` => `> -> >=`
- L206:20 op: `size = file.Size - offset` => `- -> +`
- L210:16 op: `if file.Size > file.Opts.MaxSize {` => `> -> >=`
- L213:13 op: `if offset < realDataOffset {` => `< -> <=`
- L214:34 op: `truncateAmt := realDataOffset - offset` => `- -> +`
- L218:11 op: `if size <= 0 {` => `<= -> <`

`pkg/gitinfo/gitinfo.go` `HistoryLog` (6 survivors):

- L637:16 op: `if err != nil || strings.TrimSpace(inside) != "true" {` => `|| -> &&`
- L652:15 op: `if opts.Skip > 0 {` => `> -> >=`
- L658:15 op: `if opts.Grep != "" {` => `!= -> ==`
- L676:81 op: `if _, verr := run(ctx, cwd, "rev-parse", "--verify", "--quiet", "HEAD"); verr != nil && exitCodeOf(verr) == 1 ` => `!= -> ==`
- L676:88 op: `if _, verr := run(ctx, cwd, "rev-parse", "--verify", "--quiet", "HEAD"); verr != nil && exitCodeOf(verr) == 1 ` => `&& -> ||`
- L676:108 op: `if _, verr := run(ctx, cwd, "rev-parse", "--verify", "--quiet", "HEAD"); verr != nil && exitCodeOf(verr) == 1 ` => `== -> !=`

`pkg/jarvis/effortops.go` `ApplyEffortOpsAs` (6 survivors):

- L177:45 op: `if op.At != nil && (*op.At < 1 || *op.At > len(e.Chunks)+1) {` => `> -> >=`
- L206:21 op: `if op.At == nil || *op.At < 1 || *op.At > len(e.Chunks) {` => `|| -> &&`
- L309:4 drop-call: `effortEvent(e, "chunk-added", op.Label, "", now)` => `(call removed)`
- L322:50 op: `e.Chunks = append(e.Chunks[:idx], e.Chunks[idx+1:]...)` => `+ -> -`
- L330:12 op: `if note != "" {` => `!= -> ==`
- L424:6 drop-call: `chunkNote(e, idx, "detached: "+op.ORef, now, by)` => `(call removed)`

`pkg/jarvis/evidence.go` `observedRunModel` (5 survivors):

- L788:15 op: `if p.State == PhaseState_Skipped {` => `== -> !=`
- L793:8 drop-not: `if !strings.HasPrefix(oref, "tab:") {` => `(! removed)`
- L796:76 op: `if path = TranscriptPathForTab(strings.TrimPrefix(oref, "tab:")); path != "" {` => `!= -> ==`
- L805:10 op: `if path == "" {` => `== -> !=`
- L809:9 op: `if err != nil || sess == nil {` => `!= -> ==`

`pkg/jarvisattrib/lifecycle.go` `gatherLookups` (9 survivors):

- L207:11 op: `if oid == "" {` => `== -> !=`
- L214:64 op: `if ch, err := wstore.DBGet[*waveobj.Channel](ctx, oid); err == nil && ch != nil {` => `== -> !=`
- L214:71 op: `if ch, err := wstore.DBGet[*waveobj.Channel](ctx, oid); err == nil && ch != nil {` => `&& -> ||`
- L214:77 op: `if ch, err := wstore.DBGet[*waveobj.Channel](ctx, oid); err == nil && ch != nil {` => `!= -> ==`
- L221:21 op: `if r.ProjectPath == "" || r.BaseCommit == "" || r.EndCommit == "" {` => `== -> !=`
- L221:27 op: `if r.ProjectPath == "" || r.BaseCommit == "" || r.EndCommit == "" {` => `|| -> &&`
- L221:43 op: `if r.ProjectPath == "" || r.BaseCommit == "" || r.EndCommit == "" {` => `== -> !=`
- L221:49 op: `if r.ProjectPath == "" || r.BaseCommit == "" || r.EndCommit == "" {` => `|| -> &&`
- L221:64 op: `if r.ProjectPath == "" || r.BaseCommit == "" || r.EndCommit == "" {` => `== -> !=`

`pkg/jarviscontinuity/summary.go` `buildSummaryPrompt` (9 survivors):

- L52:2 drop-call: `b.WriteString("You are Jarvis, summarizing where a development task stands so it can be resumed later.\n")` => `(call removed)`
- L53:2 drop-call: `b.WriteString("Write one short paragraph describing where the work stands and what remains, using only the fac` => `(call removed)`
- L56:2 drop-call: `b.WriteString("State: " + f.RestReason + "\n")` => `(call removed)`
- L57:15 op: `if f.RunGoal != "" {` => `!= -> ==`
- L58:3 drop-call: `b.WriteString("Latest run: " + f.RunGoal + " (status: " + f.RunStatus + ")\n")` => `(call removed)`
- L60:21 op: `if len(f.Blockers) > 0 {` => `> -> >=`
- L61:3 drop-call: `b.WriteString("Blockers:\n")` => `(call removed)`
- L66:22 op: `if len(f.Decisions) > 0 {` => `> -> >=`
- L67:3 drop-call: `b.WriteString("Decisions recorded:\n")` => `(call removed)`

`pkg/jarvisstate/fetch.go` `FetchWorkState` (5 survivors):

- L87:81 op: `if s, serr := defaultSeams.scanSessions(sessionWindowDays, sessionLimit); serr == nil {` => `== -> !=`
- L118:61 op: `if d, derr := defaultSeams.loadDecision(r, n.ID); derr == nil {` => `== -> !=`
- L131:52 op: `if es, eerr := defaultSeams.getEfforts(ctx); eerr == nil {` => `== -> !=`
- L146:10 op: `if key == "" {` => `== -> !=`
- L156:46 op: `return projectFilter == "" || projectOf(p) == projectOf(projectFilter)` => `== -> !=`

`pkg/memhygiene/judge.go` `JudgePrompt` (5 survivors):

- L94:2 drop-call: `b.WriteString("## The whole index (MEMORY.md)\n\n")` => `(call removed)`
- L101:24 op: `if len(inv.DeadLinks) > 0 {` => `> -> >=`
- L104:2 drop-call: `b.WriteString("\n## Memories to review\n")` => `(call removed)`
- L107:18 op: `if m.IndexLine == "" {` => `== -> !=`
- L122:31 drop-not: `if _, ok := docs[docTarget]; !ok {` => `(! removed)`

`pkg/memroots/migrate.go` `migrateRoot` (5 survivors):

- L53:32 op: `if err := os.Remove(src); err != nil && !os.IsNotExist(err) {` => `!= -> ==`
- L53:39 op: `if err := os.Remove(src); err != nil && !os.IsNotExist(err) {` => `&& -> ||`
- L53:42 drop-not: `if err := os.Remove(src); err != nil && !os.IsNotExist(err) {` => `(! removed)`
- L56:11 op: `if moved > 0 {` => `> -> >=`
- L56:11 op: `if moved > 0 {` => `> -> <=`

`pkg/reporadar/fixcommits.go` `clip` (5 survivors):

- L106:12 op: `if len(s) <= n {` => `<= -> <`
- L110:10 op: `for cut > 0 && !utf8.RuneStart(s[cut]) {` => `> -> >=`
- L110:10 op: `for cut > 0 && !utf8.RuneStart(s[cut]) {` => `> -> <=`
- L110:14 op: `for cut > 0 && !utf8.RuneStart(s[cut]) {` => `&& -> ||`
- L110:17 drop-not: `for cut > 0 && !utf8.RuneStart(s[cut]) {` => `(! removed)`

`pkg/secretstore/secretstore.go` `initSecretStore` (5 survivors):

- L69:5 drop-not: `if !lastInitTryTime.IsZero() && now.Sub(lastInitTryTime) < InitRetryMs*time.Millisecond {` => `(! removed)`
- L69:31 op: `if !lastInitTryTime.IsZero() && now.Sub(lastInitTryTime) < InitRetryMs*time.Millisecond {` => `&& -> ||`
- L69:59 op: `if !lastInitTryTime.IsZero() && now.Sub(lastInitTryTime) < InitRetryMs*time.Millisecond {` => `< -> <=`
- L69:59 op: `if !lastInitTryTime.IsZero() && now.Sub(lastInitTryTime) < InitRetryMs*time.Millisecond {` => `< -> >=`
- L69:72 op: `if !lastInitTryTime.IsZero() && now.Sub(lastInitTryTime) < InitRetryMs*time.Millisecond {` => `* -> /`

`pkg/storagereport/scan.go` `probe` (6 survivors):

- L578:37 op: `if rf := s.runFor(runID); rf.run != nil && rf.run.ProjectPath != "" {` => `!= -> ==`
- L578:44 op: `if rf := s.runFor(runID); rf.run != nil && rf.run.ProjectPath != "" {` => `&& -> ||`
- L578:66 op: `if rf := s.runFor(runID); rf.run != nil && rf.run.ProjectPath != "" {` => `!= -> ==`
- L583:84 op: `if _, err := os.Lstat(item.Path); errors.Is(err, fs.ErrNotExist) && fresh.Branch == "" {` => `== -> !=`
- L599:18 op: `if proj == nil || proj.err != nil {` => `|| -> &&`
- L625:16 op: `if item.Kind == wshrpc.StorageKind_FinalShots {` => `== -> !=`

### Task 2: Kill the survivors in pkg/streamclient and 4 more (streamclient to wshutil)

**Depends on:** none
**Files:** `pkg/streamclient/*_test.go`, `pkg/usagestats/*_test.go`, `pkg/wavevault/*_test.go`, `pkg/wconfig/*_test.go`, `pkg/wshutil/*_test.go`

Follow "How every task works a survivor" above. Run one test with `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/x -run '^TestName$'`; the sqlite-backed packages fail without CGO. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`pkg/streamclient/streamreader.go` `Reader.Read` (10 survivors):

- L168:7 op: `if n > 0 {` => `> -> >=`
- L169:31 op: `currentRwnd := r.readWindow - int64(len(r.buffer))` => `- -> +`
- L170:18 op: `if currentRwnd < 0 {` => `< -> <=`
- L170:18 op: `if currentRwnd < 0 {` => `< -> >=`
- L174:29 op: `threshold := r.readWindow / 5` => `/ -> *`
- L175:27 op: `rwndDiff := currentRwnd - r.lastRwndSent` => `- -> +`
- L177:20 op: `if len(r.buffer) == 0 || rwndDiff >= threshold {` => `== -> !=`
- L177:25 op: `if len(r.buffer) == 0 || rwndDiff >= threshold {` => `|| -> &&`
- L177:37 op: `if len(r.buffer) == 0 || rwndDiff >= threshold {` => `>= -> >`
- L177:37 op: `if len(r.buffer) == 0 || rwndDiff >= threshold {` => `>= -> <`

`pkg/streamclient/streamwriter.go` `Writer.RecvAck` (8 survivors):

- L69:6 drop-not: `if !w.closed {` => `(! removed)`
- L71:4 drop-call: `w.cond.Broadcast()` => `(call removed)`
- L77:30 op: `if ackedSeq < w.maxAckedSeq || (ackedSeq == w.maxAckedSeq && rwnd <= w.maxAckedRwnd) {` => `|| -> &&`
- L77:68 op: `if ackedSeq < w.maxAckedSeq || (ackedSeq == w.maxAckedSeq && rwnd <= w.maxAckedRwnd) {` => `<= -> <`
- L86:15 op: `if ackedSeq > (w.nextSeq - w.sentNotAcked) {` => `> -> >=`
- L87:27 op: `ackedBytes := ackedSeq - (w.nextSeq - w.sentNotAcked)` => `- -> +`
- L89:22 op: `if w.sentNotAcked < 0 {` => `< -> <=`
- L89:22 op: `if w.sentNotAcked < 0 {` => `< -> >=`

`pkg/streamclient/streamwriter.go` `Writer.trySendDataLocked` (5 survivors):

- L143:30 op: `availWindow := w.readWindow - w.sentNotAcked` => `- -> +`
- L144:17 op: `if availWindow <= 0 {` => `<= -> <`
- L149:19 op: `if int64(toSend) > availWindow {` => `> -> >=`
- L167:16 op: `return toSend > 0` => `> -> >=`
- L167:16 op: `return toSend > 0` => `> -> <=`

`pkg/usagestats/usagestats.go` `extractCodex` (5 survivors):

- L156:30 op: `if rec.Type != "event_msg" || rec.Payload.Type != "token_count" {` => `|| -> &&`
- L168:12 op: `if total == 0 {` => `== -> !=`
- L171:11 op: `if best == nil || total > bestTotal {` => `== -> !=`
- L171:27 op: `if best == nil || total > bestTotal {` => `> -> >=`
- L173:13 op: `if input < 0 {` => `< -> <=`

`pkg/wavevault/read.go` `Retriever.load` (5 survivors):

- L92:11 op: `if coll == CollMemory {` => `== -> !=`
- L94:47 op: `if s := frontmatterScope(n.Frontmatter); s != "" {` => `!= -> ==`
- L100:41 op: `if info, statErr := d.Info(); statErr == nil {` => `== -> !=`
- L116:18 op: `if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {` => `|| -> &&`
- L116:31 op: `if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {` => `|| -> &&`

`pkg/wconfig/settingsconfig.go` `GetConfigSubdirs` (8 survivors):

- L433:30 op: `for fieldIdx := 0; fieldIdx < configRType.NumField(); fieldIdx++ {` => `< -> >=`
- L435:20 op: `if field.PkgPath != "" {` => `!= -> ==`
- L439:17 op: `if configFile == "-" {` => `== -> !=`
- L443:14 op: `if jsonTag != "-" && jsonTag != "" && jsonTag != "settings" {` => `!= -> ==`
- L443:21 op: `if jsonTag != "-" && jsonTag != "" && jsonTag != "settings" {` => `&& -> ||`
- L443:32 op: `if jsonTag != "-" && jsonTag != "" && jsonTag != "settings" {` => `!= -> ==`
- L443:38 op: `if jsonTag != "-" && jsonTag != "" && jsonTag != "settings" {` => `&& -> ||`
- L443:49 op: `if jsonTag != "-" && jsonTag != "" && jsonTag != "settings" {` => `!= -> ==`

`pkg/wshutil/wshrouter.go` `WshRouter.processOneBacklogRound` (5 survivors):

- L437:9 op: `if lm == nil {` => `== -> !=`
- L439:17 op: `if highWater > 0 {` => `> -> >=`
- L439:17 op: `if highWater > 0 {` => `> -> <=`
- L443:4 drop-call: `delete(router.backlogHighWaterMark, linkId)` => `(call removed)`
- L447:22 op: `if len(newBacklog) == 0 {` => `== -> !=`

### Task 3: Kill the survivors in claude/arc-mod/hooks/cache-core.ts and 10 more (cache-core.ts to modalfocus.ts)

**Depends on:** none
**Files:** `claude/arc-mod/hooks/cache-core.test.ts`, `frontend/app/cockpit/cockpit-actions.test.ts`, `frontend/app/cockpit/openfileroute.test.ts`, `frontend/app/cockpit/palette-commands.test.ts`, `frontend/app/cockpit/palette-entities.test.ts`, `frontend/app/cockpit/palette-groups.test.ts`, `frontend/app/cockpit/palette-match.test.ts`, `frontend/app/cockpit/palette-scope.test.ts`, `frontend/app/cockpit/versioninfo.test.ts`, `frontend/app/element/metergeometry.test.ts`, `frontend/app/modals/modalfocus.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

`claude/arc-mod/hooks/cache-core.ts` `turnMisses` (16 survivors):

- L67:26 ArrayDeclaration: `let misses: Miss[] = [];` => `["Stryker was here"]`
- L69:13 LogicalOperator: `if (e.type === "system" && e.subtype === "compact_boundary") {` => `e.type === "system" || e.subtype === "compact_boundary"`
- L69:13 ConditionalExpression: `if (e.type === "system" && e.subtype === "compact_boundary") {` => `true`
- L69:36 ConditionalExpression: `if (e.type === "system" && e.subtype === "compact_boundary") {` => `true`
- L75:22 ArrayDeclaration: `misses = [];` => `["Stryker was here"]`
- L80:13 ConditionalExpression: `if (e.type !== "assistant" || e.isSidechain || !u || msg.model === SYNTHETIC_MODEL) {` => `false`
- L92:13 ConditionalExpression: `if (tokens <= 0) {` => `false`
- L92:13 EqualityOperator: `if (tokens <= 0) {` => `tokens < 0`
- L98:34 MethodExpression: `const missedTokens = Math.min(prev.tokens, tokens) - read;` => `Math.max(prev.tokens, tokens)`
- L99:17 ConditionalExpression: `if (missedTokens > NOISE_FLOOR_TOKENS) {` => `true`
- L99:17 EqualityOperator: `if (missedTokens > NOISE_FLOOR_TOKENS) {` => `missedTokens >= NOISE_FLOOR_TOKENS`
- L105:20 ConditionalExpression: `} else if ((u.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) {` => `true`
- L105:20 ConditionalExpression: `} else if ((u.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) {` => `false`
- L105:20 EqualityOperator: `} else if ((u.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) {` => `(u.cache_creation?.ephemeral_5m_input_tokens ?? 0) >= 0`
- L105:20 EqualityOperator: `} else if ((u.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) {` => `(u.cache_creation?.ephemeral_5m_input_tokens ?? 0) <= 0`
- L105:21 LogicalOperator: `} else if ((u.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) {` => `u.cache_creation?.ephemeral_5m_input_tokens && 0`

`frontend/app/cockpit/cockpit-actions.ts` `launchAgent` (33 survivors):

- L36:9 ConditionalExpression: `if (opts.resumePath) {` => `true`
- L43:24 ConditionalExpression: `const isTerminal = opts.runtime === "terminal";` => `false`
- L43:24 ConditionalExpression: `const isTerminal = opts.runtime === "terminal";` => `true`
- L43:24 EqualityOperator: `const isTerminal = opts.runtime === "terminal";` => `opts.runtime !== "terminal"`
- L45:9 ConditionalExpression: `if (!isTerminal && opts.branch?.trim()) {` => `false`
- L45:9 BooleanLiteral: `if (!isTerminal && opts.branch?.trim()) {` => `isTerminal`
- L45:24 MethodExpression: `if (!isTerminal && opts.branch?.trim()) {` => `opts.branch`
- L54:9 ConditionalExpression: `if (isTerminal && !cwd) {` => `true`
- L54:9 ConditionalExpression: `if (isTerminal && !cwd) {` => `false`
- L54:9 LogicalOperator: `if (isTerminal && !cwd) {` => `isTerminal || !cwd`
- L58:9 ConditionalExpression: `if (ws?.oid == null) {` => `false`
- L61:78 BooleanLiteral: `const tabId = await WorkspaceService.CreateTab(ws.oid, opts.projectName, false);` => `true`
- L64:9 ConditionalExpression: `if (blockId == null) {` => `false`
- L85:53 ObjectLiteral: `void RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: false }).catch(() => {});` => `{}`
- L85:63 BooleanLiteral: `void RpcApi.AgentSyncApplyCommand(TabRpcClient, { dryrun: false }).catch(() => {});` => `true`
- L88:11 ObjectLiteral: `? { "session:agent": opts.runtime, "session:project": opts.projectName }` => `{}`
- L90:9 ConditionalExpression: `if (opts.label) {` => `true`
- L90:9 ConditionalExpression: `if (opts.label) {` => `false`
- L93:9 ConditionalExpression: `if (opts.effortORef) {` => `true`
- L93:9 ConditionalExpression: `if (opts.effortORef) {` => `false`
- L96:47 ObjectLiteral: `await RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("tab", tabId), meta: tabMeta });` => `{}`
- L97:9 ConditionalExpression: `if (agentPanel) {` => `true`
- L97:9 ConditionalExpression: `if (agentPanel) {` => `false`
- L97:21 BlockStatement: `if (agentPanel) {` => `{}`
- L98:40 ObjectLiteral: `const pending: PendingLaunch = {` => `{}`
- L101:19 ConditionalExpression: `name: opts.label || opts.projectName,` => `true`
- L101:19 ConditionalExpression: `name: opts.label || opts.projectName,` => `false`
- L101:19 LogicalOperator: `name: opts.label || opts.projectName,` => `opts.label && opts.projectName`
- L105:52 ArrayDeclaration: `globalStore.set(model.pendingLaunchesAtom, [...globalStore.get(model.pendingLaunchesAtom), pending]);` => `[]`
- L110:9 ConditionalExpression: `if (!isTerminal) {` => `true`
- L110:9 ConditionalExpression: `if (!isTerminal) {` => `false`
- L110:9 BooleanLiteral: `if (!isTerminal) {` => `isTerminal`
- L110:22 BlockStatement: `if (!isTerminal) {` => `{}`

`frontend/app/cockpit/openfileroute.ts` `toRel` (6 survivors):

- L31:18 MethodExpression: `const segs = path.split(/[\\/]+/).filter((s) => s !== "");` => `path.split(/[\\/]+/)`
- L31:29 Regex: `const segs = path.split(/[\\/]+/).filter((s) => s !== "");` => `/[\\/]/`
- L31:53 ConditionalExpression: `const segs = path.split(/[\\/]+/).filter((s) => s !== "");` => `true`
- L32:22 MethodExpression: `const rootSegs = root.split(/[\\/]+/).filter((s) => s !== "");` => `root.split(/[\\/]+/)`
- L32:33 Regex: `const rootSegs = root.split(/[\\/]+/).filter((s) => s !== "");` => `/[\\/]/`
- L32:57 ConditionalExpression: `const rootSegs = root.split(/[\\/]+/).filter((s) => s !== "");` => `true`

`frontend/app/cockpit/palette-commands.ts` `commandGroups` (5 survivors):

- L135:24 ConditionalExpression: `const fixed = [...(own != null ? [own] : []), ...GROUP_ORDER.filter((g) => g !== own)];` => `true`
- L135:46 ArrayDeclaration: `const fixed = [...(own != null ? [own] : []), ...GROUP_ORDER.filter((g) => g !== own)];` => `["Stryker was here"]`
- L135:54 MethodExpression: `const fixed = [...(own != null ? [own] : []), ...GROUP_ORDER.filter((g) => g !== own)];` => `GROUP_ORDER`
- L135:80 ConditionalExpression: `const fixed = [...(own != null ? [own] : []), ...GROUP_ORDER.filter((g) => g !== own)];` => `true`
- L136:18 MethodExpression: `const rest = present.filter((g) => !fixed.includes(g)).sort();` => `present.filter(g => !fixed.includes(g))`

`frontend/app/cockpit/palette-entities.ts` `mergeRanked` (5 survivors):

- L66:15 MethodExpression: `const q = query.trim();` => `query`
- L67:9 ConditionalExpression: `if (q === "") {` => `false`
- L67:19 BlockStatement: `if (q === "") {` => `{}`
- L76:34 ConditionalExpression: `while (i < primary.length && j < extra.length) {` => `true`
- L76:34 EqualityOperator: `while (i < primary.length && j < extra.length) {` => `j <= extra.length`

`frontend/app/cockpit/palette-groups.ts` `assembleAllGroups` (5 survivors):

- L131:9 MethodExpression: `if (query.trim() === "") {` => `query`
- L141:25 BooleanLiteral: `asking: true,` => `false`
- L155:9 ConditionalExpression: `launch.length > 0 ? [{ key: "launch", label: 'Start in ${projectLabel}', rich: true, items: launch }] : [];` => `true`
- L155:9 EqualityOperator: `launch.length > 0 ? [{ key: "launch", label: 'Start in ${projectLabel}', rich: true, items: launch }] : [];` => `launch.length >= 0`
- L155:113 ArrayDeclaration: `launch.length > 0 ? [{ key: "launch", label: 'Start in ${projectLabel}', rich: true, items: launch }] : [];` => `["Stryker was here"]`

`frontend/app/cockpit/palette-match.ts` `fuzzyMatch` (9 survivors):

- L31:15 MethodExpression: `const q = query.trim().toLowerCase();` => `query`
- L32:9 ConditionalExpression: `if (q === "") {` => `false`
- L32:19 BlockStatement: `if (q === "") {` => `{}`
- L42:26 EqualityOperator: `for (let j = ti; j < t.length; j++) {` => `j <= t.length`
- L58:13 ConditionalExpression: `if (prevMatch >= 0) {` => `true`
- L58:13 EqualityOperator: `if (prevMatch >= 0) {` => `prevMatch > 0`
- L60:17 ConditionalExpression: `if (gap > 0) {` => `true`
- L60:17 EqualityOperator: `if (gap > 0) {` => `gap >= 0`
- L61:26 MethodExpression: `score -= Math.min(gap, MAX_GAP_PENALTY);` => `Math.max(gap, MAX_GAP_PENALTY)`

`frontend/app/cockpit/palette-scope.ts` `typeQuery` (9 survivors):

- L127:30 ConditionalExpression: `if (s.scope === "all" && s.drill == null && s.actions == null) {` => `true`
- L127:49 ConditionalExpression: `if (s.scope === "all" && s.drill == null && s.actions == null) {` => `true`
- L128:13 ConditionalExpression: `if (s.query === "") {` => `true`
- L131:70 BooleanLiteral: `return { ...s, scope, query: value.slice(1), asGoal: false, via: "prefix" };` => `true`
- L137:17 ConditionalExpression: `if (s.query.length < typed.length && typed.startsWith(s.query)) {` => `true`
- L137:17 LogicalOperator: `if (s.query.length < typed.length && typed.startsWith(s.query)) {` => `s.query.length < typed.length || typed.startsWith(s.query)`
- L137:17 EqualityOperator: `if (s.query.length < typed.length && typed.startsWith(s.query)) {` => `s.query.length <= typed.length`
- L137:17 ConditionalExpression: `if (s.query.length < typed.length && typed.startsWith(s.query)) {` => `true`
- L138:71 BooleanLiteral: `return { ...s, scope: p.scope, query: p.rest, asGoal: false, via: "prefix" };` => `true`

`frontend/app/cockpit/palette-scope.ts` `resolveChannelToken` (8 survivors):

- L262:15 MethodExpression: `const t = token.toLowerCase();` => `token.toUpperCase()`
- L263:33 ArrowFunction: `const exact = channels.find((c) => c.name.toLowerCase() === t);` => `() => undefined`
- L263:40 MethodExpression: `const exact = channels.find((c) => c.name.toLowerCase() === t);` => `c.name.toUpperCase()`
- L263:40 ConditionalExpression: `const exact = channels.find((c) => c.name.toLowerCase() === t);` => `false`
- L264:9 ConditionalExpression: `if (exact) {` => `false`
- L264:16 BlockStatement: `if (exact) {` => `{}`
- L271:26 ConditionalExpression: `if (s != null && s > bestScore) {` => `true`
- L271:26 EqualityOperator: `if (s != null && s > bestScore) {` => `s >= bestScore`

`frontend/app/cockpit/palette-scope.ts` `parseProjectLaunch` (6 survivors):

- L252:29 Regex: `const m = query.replace(/^\s+/, "").match(/^(\S+)\s+([\s\S]+)$/);` => `/^\s/`
- L252:47 Regex: `const m = query.replace(/^\s+/, "").match(/^(\S+)\s+([\s\S]+)$/);` => `/(\S+)\s+([\s\S]+)$/`
- L252:47 Regex: `const m = query.replace(/^\s+/, "").match(/^(\S+)\s+([\s\S]+)$/);` => `/^(\S+)\s+([\s\S]+)/`
- L252:47 Regex: `const m = query.replace(/^\s+/, "").match(/^(\S+)\s+([\s\S]+)$/);` => `/^(\S+)\s([\s\S]+)$/`
- L253:22 ConditionalExpression: `if (m == null || m[2].trim() === "") {` => `false`
- L253:22 MethodExpression: `if (m == null || m[2].trim() === "") {` => `m[2]`

`frontend/app/cockpit/versioninfo.ts` `deriveVersionInfo` (5 survivors):

- L33:20 ConditionalExpression: `buildTime: Number.isFinite(buildTime) && buildTime > 0 ? buildTime : 0,` => `false`
- L33:20 LogicalOperator: `buildTime: Number.isFinite(buildTime) && buildTime > 0 ? buildTime : 0,` => `Number.isFinite(buildTime) || buildTime > 0`
- L33:50 ConditionalExpression: `buildTime: Number.isFinite(buildTime) && buildTime > 0 ? buildTime : 0,` => `true`
- L33:50 EqualityOperator: `buildTime: Number.isFinite(buildTime) && buildTime > 0 ? buildTime : 0,` => `buildTime >= 0`
- L33:50 EqualityOperator: `buildTime: Number.isFinite(buildTime) && buildTime > 0 ? buildTime : 0,` => `buildTime <= 0`

`frontend/app/element/metergeometry.ts` `meterSegments` (6 survivors):

- L24:19 LogicalOperator: `const denom = total != null && total > 0 ? total : live.reduce((sum, s) => sum + s.value, 0);` => `total != null || total > 0`
- L24:19 ConditionalExpression: `const denom = total != null && total > 0 ? total : live.reduce((sum, s) => sum + s.value, 0);` => `true`
- L24:36 ConditionalExpression: `const denom = total != null && total > 0 ? total : live.reduce((sum, s) => sum + s.value, 0);` => `true`
- L24:36 EqualityOperator: `const denom = total != null && total > 0 ? total : live.reduce((sum, s) => sum + s.value, 0);` => `total >= 0`
- L25:9 ConditionalExpression: `if (denom <= 0) return [];` => `false`
- L25:9 EqualityOperator: `if (denom <= 0) return [];` => `denom < 0`

`frontend/app/modals/modalfocus.ts` `focusTrapTarget` (5 survivors):

- L20:19 ConditionalExpression: `const index = active == null ? -1 : focusables.indexOf(active as HTMLElement);` => `true`
- L20:19 ConditionalExpression: `const index = active == null ? -1 : focusables.indexOf(active as HTMLElement);` => `false`
- L20:19 EqualityOperator: `const index = active == null ? -1 : focusables.indexOf(active as HTMLElement);` => `active != null`
- L21:9 ConditionalExpression: `if (index < 0) {` => `true`
- L21:9 EqualityOperator: `if (index < 0) {` => `index <= 0`

### Task 4: Kill the survivors in frontend/app/store/keybindings (bindings.ts to matcher.ts)

**Depends on:** none
**Files:** `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/store/keybindings/matcher.test.ts`

Follow "How every task works a survivor" above. Run one file with `npx vitest run <test file>`. A test file named here that does not exist is created beside the source, in the style of its neighbours' tests.

These sources changed after the mutation run, so their line numbers can be off: `frontend/app/store/keybindings/bindings.ts`. Find each survivor by its source text; one whose line no longer exists goes under Not reached with the reason.

`frontend/app/store/keybindings/bindings.ts` `buildGlobalBindings` (35 survivors):

- L182:13 ConditionalExpression: `idx === -1` => `false`
- L182:21 UnaryOperator: `idx === -1` => `+1`
- L183:33 EqualityOperator: `? SURFACE_ORDER[delta > 0 ? 0 : SURFACE_ORDER.length - 1]` => `delta >= 0`
- L183:33 ConditionalExpression: `? SURFACE_ORDER[delta > 0 ? 0 : SURFACE_ORDER.length - 1]` => `true`
- L188:38 MethodExpression: `const surfaceChords: Binding[] = SURFACE_ORDER.slice(0, 9).map((surface, i) => ({` => `SURFACE_ORDER`
- L190:23 ArithmeticOperator: `keys: 'Ctrl:${i + 1}',` => `i - 1`
- L193:24 BooleanLiteral: `paletteHidden: true, // duplicates the go-target for the same surface, with a worse label` => `false`
- L194:14 ArrowFunction: `run: () => globalStore.set(model.surfaceAtom, surface),` => `() => undefined`
- L222:28 ConditionalExpression: `when: (ctx) => navigate(ctx) && !inAgentCanvas(model, ctx),` => `false`
- L234:28 BooleanLiteral: `paletteHidden: true, // a palette row that opens the palette` => `false`
- L247:28 BooleanLiteral: `paletteHidden: true, // a palette row for a key the palette itself would swallow` => `false`
- L254:19 ArrowFunction: `when: (ctx) => ctx.editable && !ctx.modalOpen,` => `() => undefined`
- L254:28 ConditionalExpression: `when: (ctx) => ctx.editable && !ctx.modalOpen,` => `true`
- L254:28 LogicalOperator: `when: (ctx) => ctx.editable && !ctx.modalOpen,` => `ctx.editable || !ctx.modalOpen`
- L262:28 BooleanLiteral: `paletteHidden: true, // a palette row that opens the palette` => `false`
- L264:18 ArrowFunction: `run: () => globalStore.set(model.paletteOpenAtom, true),` => `() => undefined`
- L272:18 ArrowFunction: `run: () => globalStore.set(resmonOpenAtom, true),` => `() => undefined`
- L281:19 ArrowFunction: `when: (ctx) => !ctx.modalOpen,` => `() => undefined`
- L281:28 BooleanLiteral: `when: (ctx) => !ctx.modalOpen,` => `ctx.modalOpen`
- L282:18 ArrowFunction: `run: () => globalStore.set(model.newAgentOpenAtom, true),` => `() => undefined`
- L289:18 ArrowFunction: `run: () => void launchPiTab(model),` => `() => undefined`
- L296:28 ConditionalExpression: `when: (ctx) => ctx.surface === "agent",` => `true`
- L297:18 ArrowFunction: `run: () => model.cycleFocus(false),` => `() => undefined`
- L304:28 ConditionalExpression: `when: (ctx) => ctx.surface === "agent",` => `true`
- L305:18 ArrowFunction: `run: () => model.cycleFocus(true),` => `() => undefined`
- L312:28 BooleanLiteral: `paletteHidden: true, // one row would fire one press and appear to do nothing` => `false`
- L314:19 ArrowFunction: `when: (ctx) => ctx.surface === "agent",` => `() => undefined`
- L314:28 ConditionalExpression: `when: (ctx) => ctx.surface === "agent",` => `true`
- L314:28 ConditionalExpression: `when: (ctx) => ctx.surface === "agent",` => `false`
- L314:28 EqualityOperator: `when: (ctx) => ctx.surface === "agent",` => `ctx.surface !== "agent"`
- L342:18 ArrowFunction: `run: () => globalStore.set(cheatsheetOpenAtom, true),` => `() => undefined`
- L368:19 ConditionalExpression: `!(ctx.surface === "files" && anyFilterActive(globalStore.get(historyFiltersAtom))) &&` => `true`
- L377:17 ConditionalExpression: `globalStore.get(noteChunkAtom) == null &&` => `true`
- L379:17 ConditionalExpression: `globalStore.get(trackerMenuAtom) == null,` => `true`
- L380:18 ArrowFunction: `run: () => backOrHome(model),` => `() => undefined`

`frontend/app/store/keybindings/bindings.ts` `buildCodeBindings` (30 survivors):

- L1201:37 ConditionalExpression: `const on = (ctx: KeyContext) => ctx.surface === "code" && !ctx.editable && !ctx.modalOpen;` => `false`
- L1201:37 ConditionalExpression: `const on = (ctx: KeyContext) => ctx.surface === "code" && !ctx.editable && !ctx.modalOpen;` => `true`
- L1201:37 EqualityOperator: `const on = (ctx: KeyContext) => ctx.surface === "code" && !ctx.editable && !ctx.modalOpen;` => `ctx.surface !== "code"`
- L1201:80 BooleanLiteral: `const on = (ctx: KeyContext) => ctx.surface === "code" && !ctx.editable && !ctx.modalOpen;` => `ctx.modalOpen`
- L1210:21 ArrowFunction: `const treeKey = (key: TreeKey) => (): void | boolean => {` => `() => undefined`
- L1280:28 ConditionalExpression: `when: (ctx) => ctx.surface === "code",` => `true`
- L1347:18 ArrowFunction: `run: () => startCreate(false),` => `() => undefined`
- L1355:18 ArrowFunction: `run: () => startCreate(true),` => `() => undefined`
- L1393:19 ArrowFunction: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `() => undefined`
- L1393:28 ConditionalExpression: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `true`
- L1393:28 ConditionalExpression: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `false`
- L1393:28 ConditionalExpression: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `true`
- L1393:28 LogicalOperator: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `ctx.surface === "code" || !ctx.modalOpen`
- L1393:28 EqualityOperator: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `ctx.surface !== "code"`
- L1393:54 BooleanLiteral: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `ctx.modalOpen`
- L1409:19 ArrowFunction: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `() => undefined`
- L1409:28 ConditionalExpression: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `true`
- L1409:28 ConditionalExpression: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `false`
- L1409:28 LogicalOperator: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `ctx.surface === "code" || !ctx.modalOpen`
- L1409:28 ConditionalExpression: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `true`
- L1409:28 EqualityOperator: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `ctx.surface !== "code"`
- L1409:54 BooleanLiteral: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `ctx.modalOpen`
- L1413:47 BlockStatement: `if (focusCodeSidebarOpener()) {` => `{}`
- L1425:19 ArrowFunction: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `() => undefined`
- L1425:28 ConditionalExpression: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `false`
- L1425:28 ConditionalExpression: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `true`
- L1425:28 LogicalOperator: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `ctx.surface === "code" || !ctx.modalOpen`
- L1425:28 ConditionalExpression: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `true`
- L1425:28 EqualityOperator: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `ctx.surface !== "code"`
- L1425:54 BooleanLiteral: `when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,` => `ctx.modalOpen`

`frontend/app/store/keybindings/bindings.ts` `buildJarvisBindings` (28 survivors):

- L574:13 ConditionalExpression: `onJarvis(ctx) && globalStore.get(noteChunkAtom) != null && globalStore.get(trackerMenuAtom) == null,` => `false`
- L590:24 ConditionalExpression: `when: (ctx) => onJarvis(ctx) && globalStore.get(trackerMenuAtom) != null,` => `false`
- L591:14 ArrowFunction: `run: () => globalStore.set(trackerMenuAtom, null),` => `() => undefined`
- L598:42 BlockStatement: `if (subject?.kind !== "channel") {` => `{}`
- L602:13 ConditionalExpression: `if (runs.length < 2) {` => `false`
- L602:30 BlockStatement: `if (runs.length < 2) {` => `{}`
- L611:13 ConditionalExpression: `if (next == null || next === cur) {` => `false`
- L611:13 ConditionalExpression: `if (next == null || next === cur) {` => `false`
- L611:13 LogicalOperator: `if (next == null || next === cur) {` => `next == null && next === cur`
- L611:29 ConditionalExpression: `if (next == null || next === cur) {` => `false`
- L611:43 BlockStatement: `if (next == null || next === cur) {` => `{}`
- L612:20 BooleanLiteral: `return false;` => `true`
- L627:18 ArrowFunction: `run: () => clickThrough("[data-new-run]"),` => `() => undefined`
- L635:18 ArrowFunction: `run: () => clickThrough("[data-jarvis-new-initiative]"),` => `() => undefined`
- L643:18 ArrowFunction: `run: () => clickThrough('[data-jarvis-brief-cursor="true"] [data-jarvis-work-on]'),` => `() => undefined`
- L651:18 ArrowFunction: `run: () => clickThrough("[data-jarvis-band-toggle]"),` => `() => undefined`
- L674:28 ConditionalExpression: `when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,` => `false`
- L674:28 LogicalOperator: `when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,` => `onStage(ctx) || globalStore.get(chunkMoveAtom) != null`
- L674:44 ConditionalExpression: `when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,` => `true`
- L674:44 EqualityOperator: `when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,` => `globalStore.get(chunkMoveAtom) == null`
- L675:18 ArrowFunction: `run: () => globalStore.get(chunkMoveAtom)?.("up"),` => `() => undefined`
- L682:28 ConditionalExpression: `when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,` => `false`
- L682:28 LogicalOperator: `when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,` => `onStage(ctx) || globalStore.get(chunkMoveAtom) != null`
- L682:44 ConditionalExpression: `when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,` => `true`
- L682:44 EqualityOperator: `when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,` => `globalStore.get(chunkMoveAtom) == null`
- L683:18 ArrowFunction: `run: () => globalStore.get(chunkMoveAtom)?.("down"),` => `() => undefined`
- L720:28 BooleanLiteral: `paletteHidden: true,` => `false`
- L724:28 ConditionalExpression: `when: (ctx) => ctx.surface === "jarvis" && ctx.editable && !ctx.modalOpen,` => `true`

`frontend/app/store/keybindings/bindings.ts` `buildAgentBindings` (16 survivors):

- L785:16 ConditionalExpression: `return agent != null && parseDocReview(agent.ask) != null ? agent.id : null;` => `true`
- L810:17 ConditionalExpression: `ctx.surface === "agent" &&` => `true`
- L810:17 LogicalOperator: `ctx.surface === "agent" &&` => `ctx.surface === "agent" || !ctx.modalOpen`
- L810:17 ConditionalExpression: `ctx.surface === "agent" &&` => `true`
- L823:17 ConditionalExpression: `ctx.surface === "agent" &&` => `true`
- L853:18 ArrowFunction: `run: () => step(-1),` => `() => undefined`
- L861:18 ArrowFunction: `run: () => step(1),` => `() => undefined`
- L863:104 ArrowFunction: `{ id: "agent:prev-k", keys: "k", group: "Agent", label: "Previous agent", when: agentNav, run: () => step(-1) ` => `() => undefined`
- L864:100 ArrowFunction: `{ id: "agent:next-j", keys: "j", group: "Agent", label: "Next agent", when: agentNav, run: () => step(1) },` => `() => undefined`
- L871:18 ArrowFunction: `run: () => globalStore.set(railVisibleAtom, !globalStore.get(railVisibleAtom)),` => `() => undefined`
- L879:18 ArrowFunction: `run: () => globalStore.set(terminalFullscreenAtom, !globalStore.get(terminalFullscreenAtom)),` => `() => undefined`
- L889:28 BooleanLiteral: `paletteHidden: true,` => `false`
- L910:28 BooleanLiteral: `paletteHidden: true, // duplicates agent:fullscreen, which already has a palette row` => `false`
- L912:18 ArrowFunction: `run: () => globalStore.set(terminalFullscreenAtom, !globalStore.get(terminalFullscreenAtom)),` => `() => undefined`
- L919:28 ConditionalExpression: `when: (ctx) => ctx.surface === "agent" && ctx.editable, // only while the TUI owns focus` => `true`
- L966:18 ArrowFunction: `run: () => setMarking(focusId(), true),` => `() => undefined`

`frontend/app/store/keybindings/bindings.ts` `buildChannelsAskBindings` (9 survivors):

- L486:9 LogicalOperator: `ctx.surface === "jarvis" && !ctx.editable && !ctx.modalOpen && askAgentRef.current != null;` => `ctx.surface === "jarvis" || !ctx.editable`
- L486:9 ConditionalExpression: `ctx.surface === "jarvis" && !ctx.editable && !ctx.modalOpen && askAgentRef.current != null;` => `true`
- L486:9 ConditionalExpression: `ctx.surface === "jarvis" && !ctx.editable && !ctx.modalOpen && askAgentRef.current != null;` => `true`
- L486:72 ConditionalExpression: `ctx.surface === "jarvis" && !ctx.editable && !ctx.modalOpen && askAgentRef.current != null;` => `true`
- L511:42 ObjectLiteral: `const digits: Binding[] = Array.from({ length: 9 }, (_, i) => i + 1).map((n) => ({` => `{}`
- L511:67 ArithmeticOperator: `const digits: Binding[] = Array.from({ length: 9 }, (_, i) => i + 1).map((n) => ({` => `i - 1`
- L516:24 BooleanLiteral: `paletteHidden: true,` => `false`
- L518:14 ArrowFunction: `run: () => toggleDigit(n),` => `() => undefined`
- L527:28 BooleanLiteral: `paletteHidden: true,` => `false`

`frontend/app/store/keybindings/bindings.ts` `buildListNavBindings` (9 survivors):

- L398:13 ConditionalExpression: `if (c == null) {` => `false`
- L402:13 ConditionalExpression: `if (next != null) {` => `true`
- L420:28 BooleanLiteral: `paletteHidden: true,` => `false`
- L429:28 BooleanLiteral: `paletteHidden: true,` => `false`
- L438:28 BooleanLiteral: `paletteHidden: true,` => `false`
- L447:28 BooleanLiteral: `paletteHidden: true,` => `false`
- L456:28 BooleanLiteral: `paletteHidden: true,` => `false`
- L465:28 BooleanLiteral: `paletteHidden: true,` => `false`
- L468:21 ConditionalExpression: `if (target == null) {` => `false`

`frontend/app/store/keybindings/bindings.ts` `buildFilesBindings` (9 survivors):

- L1010:21 ConditionalExpression: `if (el == null) {` => `true`
- L1034:18 ArrowFunction: `run: () => globalStore.set(splitViewAtom, !globalStore.get(splitViewAtom)),` => `() => undefined`
- L1042:18 ArrowFunction: `run: () => globalStore.set(ignoreWsAtom, !globalStore.get(ignoreWsAtom)),` => `() => undefined`
- L1068:18 ArrowFunction: `run: () => gotoChange("next"),` => `() => undefined`
- L1076:18 ArrowFunction: `run: () => gotoChange("previous"),` => `() => undefined`
- L1109:18 ArrowFunction: `run: () => clearHistoryFilters(),` => `() => undefined`
- L1122:21 ConditionalExpression: `if (el != null) {` => `true`
- L1150:21 ConditionalExpression: `if (el == null) {` => `true`
- L1175:18 ArrowFunction: `run: () => leaveCompare(),` => `() => undefined`

`frontend/app/store/keybindings/matcher.ts` `matchBinding` (6 survivors):

- L23:67 BooleanLiteral: `const active = bindings.filter((b) => (b.when ? b.when(ctx) : true));` => `false`
- L24:23 MethodExpression: `const sequences = active.filter((b) => isSequenceKeys(b.keys));` => `active`
- L25:21 MethodExpression: `const singles = active.filter((b) => !isSequenceKeys(b.keys));` => `active`
- L30:79 ObjectLiteral: `return { kind: "resetAndProcess", result: matchBinding(waveEvent, { ...ctx, leader: null }, bindings) };` => `{}`
- L41:17 ConditionalExpression: `if (lead === ctx.leader && keyutil.checkKeyPressed(waveEvent, next)) {` => `true`
- L75:13 ConditionalExpression: `if (keyutil.checkKeyPressed(waveEvent, p)) {` => `true`
