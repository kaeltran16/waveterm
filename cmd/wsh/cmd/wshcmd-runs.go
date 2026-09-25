// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	workspaceIdEnvVar = "WAVETERM_WORKSPACEID"
	// an engine launch builds a worktree and starts a worker per lane before CreateRun replies; this is the
	// + Run launcher's budget (CREATE_RUN_TIMEOUT_MS), and the server derives its handler deadline from it
	runsStartTimeoutMs  = 180_000
	runsCancelTimeoutMs = 60_000 // cancel stops each live worker gracefully before it returns
	runsLandTimeoutMs   = int64(orchestrate.LandTimeout/time.Millisecond) + 10_000
	runsReadTimeoutMs   = 10_000
	runsListDefault     = 20
	runsGoalWidth       = 70
	runsShowGoalWidth   = 240 // a task run's goal is its whole worker prompt; --json carries it in full
	effortORefPrefix    = "effort:"
)

var runsCmd = &cobra.Command{
	Use:   "runs",
	Short: "start, list, inspect and cancel cockpit runs from outside a run (per-task steering is wsh jarvis dag)",
	Args:  cobra.NoArgs,
	RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var runsStartCmd = &cobra.Command{
	Use:   "start [goal]",
	Short: "start a run in this project, as the + Run launcher does",
	Long: `Start a run in this project, as the + Run launcher does.

A quick run takes a goal. An orchestrator run takes a goal, or --plan with a plan file (the goal then
defaults to the plan's name). The project is the git repository holding the current directory (or
--project); a worktree resolves to its main checkout. The lead route is --runtime/--model, else the
project's saved route, else the harness preference in settings.

A launch can take minutes. If it reports no reply, the run may still have started: check
'wsh runs list' before starting it again.`,
	Args:    cobra.MaximumNArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE:    runsStartRun,
}

var runsListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list this project's runs, newest first",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE:    runsListRun,
}

var runsShowCmd = &cobra.Command{
	Use:     "show <run-id>",
	Short:   "show a run: status, route, initiative, commits, task digest and sealed report",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE:    runsShowRun,
}

var runsCancelCmd = &cobra.Command{
	Use:   "cancel <run-id>",
	Short: "cancel a run; a run with live workers needs --yes",
	Long: `Cancel a run. Completed phases, transcripts and artifacts are kept; a finished run cannot be
cancelled. When the run has live workers this prints what would stop and exits non-zero unless --yes
is passed.`,
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE:    runsCancelRun,
}

var runsLandCmd = &cobra.Command{
	Use:   "land <run-id>",
	Short: "merge a finished run's branch back into the branch it started from, or say why it is held",
	Long: `Merge a finished run's wave/<run-id> branch back into the branch the run started from, in the
project checkout, then remove its landing tree and branch. The engine does this itself when the run
completes; this retries a held land once its reason is cleared. It can take minutes when it re-runs
Check and Verify. --force lands a run whose final stage failed.`,
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE:    runsLandRun,
}

var runsAckCmd = &cobra.Command{
	Use:     "ack <run-id>",
	Short:   "acknowledge a finished run's unverified outcome, which clears it from the attention list",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE:    runsAckRun,
}

var runsAttentionCmd = &cobra.Command{
	Use:     "attention",
	Short:   "list everything waiting on the human across every project (review gates, escalations, asks)",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE:    runsAttentionRun,
}

func init() {
	f := runsStartCmd.Flags()
	f.String("mode", "", "quick|orchestrator (default quick; --plan implies orchestrator)")
	f.String("plan", "", "plan file for an orchestrator run, in the format 'wsh jarvis dag submit --help' describes")
	f.String("runtime", "", "lead harness: claude|pi (default: the project's saved route, else settings)")
	f.String("model", "", "lead model id (needs --runtime)")
	f.String("worker-runtime", "", "orchestrator worker harness (default: the lead's)")
	f.String("worker-model", "", "orchestrator worker model id (needs --worker-runtime)")
	f.Int("parallelism", 0, "orchestrator width (default: the project's profile)")
	f.String("landing", "", "branch|checkout: where an orchestrator run commits (default: the project's profile, else branch)")
	f.String("effort", "", "initiative to attach the run to (id from 'wsh effort list')")
	f.String("chunk", "", "the initiative's chunk: its label or 1-based number")
	f.Bool("json", false, "JSON output")
	for _, c := range []*cobra.Command{runsStartCmd, runsListCmd, runsShowCmd, runsCancelCmd, runsLandCmd, runsAckCmd} {
		c.Flags().String("project", "", "project directory (default: the current directory)")
		c.Flags().String("channel", "", "channel id, instead of resolving the project")
	}
	runsListCmd.Flags().Bool("all", false, "every project, not just this one")
	runsListCmd.Flags().Bool("tasks", false, "include the runs that work one task of another run (engine workers and reviewers, lead-spawned children)")
	runsListCmd.Flags().Int("limit", runsListDefault, "most runs to print")
	runsListCmd.Flags().Bool("json", false, "JSON output")
	runsShowCmd.Flags().Bool("json", false, "JSON output")
	runsCancelCmd.Flags().Bool("yes", false, "cancel even though workers are live")
	runsLandCmd.Flags().Bool("force", false, "land even though the final stage failed")
	runsAttentionCmd.Flags().Bool("json", false, "JSON output")
	runsCmd.AddCommand(runsStartCmd, runsListCmd, runsShowCmd, runsCancelCmd, runsLandCmd, runsAckCmd, runsAttentionCmd)
	rootCmd.AddCommand(runsCmd)
}

func runsStartRun(cmd *cobra.Command, args []string) error {
	ch, err := runsChannel(cmd)
	if err != nil {
		return err
	}
	goal := ""
	if len(args) > 0 {
		goal = args[0]
	}
	flag := func(name string) string { v, _ := cmd.Flags().GetString(name); return v }
	parallelism, _ := cmd.Flags().GetInt("parallelism")
	opts := runsStartOpts{
		goal: goal, mode: flag("mode"), plan: flag("plan"), parallelism: parallelism, landing: flag("landing"),
		workerRuntime: flag("worker-runtime"), workerModel: flag("worker-model"),
		effort: flag("effort"), chunk: flag("chunk"),
	}
	data, err := runsStartData(opts)
	if err != nil {
		return err
	}
	if data.PlanPath, err = runsAbs(data.PlanPath); err != nil {
		return err
	}
	route, err := runsLeadRoute(ch.OID, flag("runtime"), flag("model"))
	if err != nil {
		return err
	}
	data.Runtime, data.Model = route.Runtime, route.Model
	if data.EffortOID != "" {
		if data.ChunkLabel, err = runsChunkLabel(data.EffortOID, data.ChunkLabel); err != nil {
			return err
		}
	}
	if data.WorkspaceId, err = runsWorkspaceId(); err != nil {
		return err
	}
	data.ChannelId = ch.OID
	rtn, err := wshclient.CreateRunCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: runsStartTimeoutMs})
	if err != nil {
		return runsStartErr(err)
	}
	if isJSON(cmd) {
		return jsonOut(rtn.Run)
	}
	fmt.Printf("started run %s (%s, %s) in %s\n", rtn.Run.ID, runsMode(rtn.Run), rtn.Run.Status, ch.Name)
	fmt.Printf("follow it with: wsh runs show %s\n", rtn.Run.ID)
	return nil
}

type runsStartOpts struct {
	goal, mode, plan           string
	parallelism                int
	landing                    string
	workerRuntime, workerModel string
	effort, chunk              string
}

// runsStartData applies the flag rules; the parts that need the RPC client (channel, workspace, route,
// chunk label) are filled in by the caller, so these rules are testable on their own.
func runsStartData(o runsStartOpts) (wshrpc.CommandCreateRunData, error) {
	var s wshrpc.CommandCreateRunData
	mode := o.mode
	if o.plan != "" {
		if mode != "" && mode != jarvis.RunMode_Orchestrator {
			return s, fmt.Errorf("--plan needs an orchestrator run; drop --mode or pass --mode orchestrator")
		}
		mode = jarvis.RunMode_Orchestrator
	}
	switch mode {
	case "", jarvis.RunMode_Quick, jarvis.RunMode_Orchestrator:
	default:
		return s, fmt.Errorf("--mode must be quick or orchestrator, not %q", mode)
	}
	if o.goal == "" && o.plan == "" {
		return s, fmt.Errorf("pass a goal, or --plan <plan.md>")
	}
	engine := mode == jarvis.RunMode_Orchestrator
	if !engine && (o.parallelism != 0 || o.landing != "" || o.workerRuntime != "" || o.workerModel != "") {
		return s, fmt.Errorf("--parallelism, --landing and --worker-runtime/--worker-model need an orchestrator run")
	}
	if o.workerModel != "" && o.workerRuntime == "" {
		return s, fmt.Errorf("--worker-model needs --worker-runtime")
	}
	effort := strings.TrimPrefix(o.effort, effortORefPrefix)
	if (effort == "") != (o.chunk == "") {
		return s, fmt.Errorf("--effort and --chunk go together")
	}
	s.Goal, s.Mode, s.PlanPath, s.Parallelism, s.Landing = o.goal, mode, o.plan, o.parallelism, o.landing
	if o.workerRuntime != "" {
		s.WorkerRoute = &waveobj.RoutePin{Runtime: o.workerRuntime, Model: o.workerModel}
	}
	s.EffortOID, s.ChunkLabel = effort, o.chunk
	return s, nil
}

func runsAbs(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	// wavesrv reads the file and does not share this process's cwd
	return filepath.Abs(path)
}

// runsStartErr turns a missed reply into what it means. The server finishes a launch whatever the client's
// deadline, and CreateRun has no idempotency key, so a caller that reads a timeout as failure and retries
// starts the same run twice.
func runsStartErr(err error) error {
	if strings.Contains(err.Error(), "EC-TIME") {
		return fmt.Errorf("no reply within %s, but the run may have launched anyway: check 'wsh runs list' before starting it again (%w)",
			time.Duration(runsStartTimeoutMs)*time.Millisecond, err)
	}
	return err
}

func runsLeadRoute(channelId, runtime, model string) (waveobj.RoutePin, error) {
	if runtime != "" || model != "" {
		return runsRoute(runtime, model, nil, wconfig.SettingsType{})
	}
	prof, err := wshclient.GetJarvisProfileCommand(RpcClient, wshrpc.CommandGetJarvisProfileData{ChannelId: channelId}, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return waveobj.RoutePin{}, fmt.Errorf("reading the project's profile: %w", err)
	}
	config, err := wshclient.GetFullConfigCommand(RpcClient, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return waveobj.RoutePin{}, fmt.Errorf("reading settings: %w", err)
	}
	return runsRoute("", "", prof.Override, config.Settings)
}

// runsRoute is the + Run launcher's lead-route precedence (resolveChannelLaunchRoute): an explicit route,
// else the project's saved one, else the harness preference in settings. The server validates whatever
// comes out, so this only picks.
func runsRoute(runtime, model string, override *waveobj.ProfileOverride, settings wconfig.SettingsType) (waveobj.RoutePin, error) {
	if model != "" && runtime == "" {
		return waveobj.RoutePin{}, fmt.Errorf("--model needs --runtime")
	}
	if runtime != "" {
		return waveobj.RoutePin{Runtime: runtime, Model: model}, nil
	}
	if override != nil && override.Route != nil && override.Route.Runtime != "" {
		return *override.Route, nil
	}
	if settings.HarnessPreferredRuntime != "" {
		return waveobj.RoutePin{Runtime: settings.HarnessPreferredRuntime, Model: settings.HarnessPreferredModel}, nil
	}
	return waveobj.RoutePin{}, fmt.Errorf("no route: pass --runtime, or save a route for this project in the cockpit")
}

// runsChunkLabel resolves a chunk number to its label. The run stores the ref it is given and attribution
// matches labels, so a stored "2" would point at whatever chunk is second after a reorder.
func runsChunkLabel(effortOID, ref string) (string, error) {
	rtn, err := wshclient.EffortGetCommand(RpcClient, wshrpc.CommandEffortGetData{EffortOID: effortOID}, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return "", fmt.Errorf("reading initiative %s: %w", effortOID, err)
	}
	idx, err := jarvis.ResolveChunkIndex(rtn.Effort, ref)
	if err != nil {
		return "", err
	}
	return rtn.Effort.Chunks[idx].Label, nil
}

func runsWorkspaceId() (string, error) {
	if ws := os.Getenv(workspaceIdEnvVar); ws != "" {
		return ws, nil
	}
	list, err := wshclient.WorkspaceListCommand(RpcClient, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return "", fmt.Errorf("listing workspaces: %w", err)
	}
	return runsPickWorkspace(list)
}

// runsPickWorkspace chooses where worker tabs go when this process is not in an Arc terminal. Guessing
// between two workspaces would put the workers somewhere the user is not looking.
func runsPickWorkspace(list []wshrpc.WorkspaceInfoData) (string, error) {
	if len(list) == 1 && list[0].WorkspaceData != nil {
		return list[0].WorkspaceData.OID, nil
	}
	return "", fmt.Errorf("%s is not set and there are %d workspaces; run this from an Arc terminal", workspaceIdEnvVar, len(list))
}

func runsChannels() ([]*waveobj.Channel, error) {
	rtn, err := wshclient.GetChannelsCommand(RpcClient, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return nil, fmt.Errorf("listing projects: %w", err)
	}
	return rtn.Channels, nil
}

// runsChannel resolves the project a command acts on: --channel by id, else the channel whose project is
// the main checkout of the repository at --project (or the current directory).
func runsChannel(cmd *cobra.Command) (*waveobj.Channel, error) {
	chans, err := runsChannels()
	if err != nil {
		return nil, err
	}
	if id, _ := cmd.Flags().GetString("channel"); id != "" {
		for _, ch := range chans {
			if ch.OID == id {
				return ch, nil
			}
		}
		return nil, fmt.Errorf("no channel %s", id)
	}
	dir, _ := cmd.Flags().GetString("project")
	if dir == "" {
		if dir, err = os.Getwd(); err != nil {
			return nil, err
		}
	}
	root, err := runsProjectRoot(context.Background(), dir)
	if err != nil {
		return nil, err
	}
	if ch := wstore.MatchChannelAtPath(chans, root); ch != nil {
		return ch, nil
	}
	return nil, fmt.Errorf("%s is not an Arc project: add it in the cockpit, or pass --channel", root)
}

// runsProjectRoot is the main checkout of the repository holding dir: a channel is registered at the main
// checkout, so an agent working in one of its worktrees must still land on it. Outside a repository it
// is dir itself.
func runsProjectRoot(ctx context.Context, dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	wts, err := gitinfo.ListWorktrees(ctx, abs)
	if err != nil {
		return "", fmt.Errorf("reading the repository at %s: %w", abs, err)
	}
	if len(wts) > 0 && wts[0].IsMain {
		return wts[0].Path, nil
	}
	return abs, nil
}

type runsRow struct {
	Channel string       `json:"channel"`
	Run     *waveobj.Run `json:"run"`
}

func runsOf(ch *waveobj.Channel) ([]runsRow, error) {
	rtn, err := wshclient.GetChannelRunsCommand(RpcClient, wshrpc.CommandGetChannelRunsData{ChannelId: ch.OID}, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return nil, fmt.Errorf("listing runs of %s: %w", ch.Name, err)
	}
	rows := make([]runsRow, 0, len(rtn.Runs))
	for _, r := range rtn.Runs {
		rows = append(rows, runsRow{Channel: ch.Name, Run: r})
	}
	return rows, nil
}

func runsListRun(cmd *cobra.Command, args []string) error {
	all, _ := cmd.Flags().GetBool("all")
	tasks, _ := cmd.Flags().GetBool("tasks")
	limit, _ := cmd.Flags().GetInt("limit")
	var chans []*waveobj.Channel
	if all {
		var err error
		if chans, err = runsChannels(); err != nil {
			return err
		}
	} else {
		ch, err := runsChannel(cmd)
		if err != nil {
			return err
		}
		chans = []*waveobj.Channel{ch}
	}
	var rows []runsRow
	for _, ch := range chans {
		chRows, err := runsOf(ch)
		if err != nil {
			return err
		}
		for _, row := range chRows {
			if tasks || !runsIsTask(row.Run) {
				rows = append(rows, row)
			}
		}
	}
	rows = runsNewest(rows, limit)
	if isJSON(cmd) {
		return jsonOut(rows)
	}
	for _, line := range runsListLines(rows, all, time.Now().UnixMilli()) {
		fmt.Println(line)
	}
	return nil
}

// runsIsTask reports a run that exists to work one task of another run: an engine task's worker or reviewer
// is a quick run carrying its parent's dagoref (only an orchestrator owns one), and a lead's child carries
// the lead's oref. A project's run list is its top-level runs; these are reached through their parent.
func runsIsTask(r *waveobj.Run) bool {
	return (r.DagORef != "" && r.Mode != jarvis.RunMode_Orchestrator) || r.ParentLeadORef != ""
}

func runsNewest(rows []runsRow, limit int) []runsRow {
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Run.CreatedTs > rows[j].Run.CreatedTs })
	if limit > 0 && len(rows) > limit {
		rows = rows[:limit]
	}
	return rows
}

func runsListLines(rows []runsRow, withChannel bool, now int64) []string {
	if len(rows) == 0 {
		return []string{"no runs"}
	}
	var buf strings.Builder
	w := tabwriter.NewWriter(&buf, 0, 4, 2, ' ', 0)
	for _, row := range rows {
		r := row.Run
		cols := []string{r.ID, r.Status, runsMode(r), runsAgo(r.CreatedTs, now)}
		if withChannel {
			cols = append(cols, row.Channel)
		}
		cols = append(cols, runsClip(r.Goal, runsGoalWidth))
		fmt.Fprintln(w, strings.Join(cols, "\t"))
	}
	w.Flush()
	return strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
}

// runsFind locates a run by id. No RPC reads one run directly, and a project holds few channels, so this
// walks them: --channel or the current project first, since that is where the id usually came from.
func runsFind(cmd *cobra.Command, runId string) (*waveobj.Channel, *waveobj.Run, error) {
	chans, err := runsChannels()
	if err != nil {
		return nil, nil, err
	}
	if here, herr := runsChannel(cmd); herr == nil {
		chans = append([]*waveobj.Channel{here}, chans...)
	}
	seen := map[string]bool{}
	for _, ch := range chans {
		if seen[ch.OID] {
			continue
		}
		seen[ch.OID] = true
		rows, err := runsOf(ch)
		if err != nil {
			return nil, nil, err
		}
		for _, row := range rows {
			if row.Run.ID == runId {
				return ch, row.Run, nil
			}
		}
	}
	return nil, nil, fmt.Errorf("no run %s in any project (ids come from 'wsh runs list')", runId)
}

// runsDigest reads the task digest of a run that owns a dag, or nil when it owns none or the read fails;
// show and cancel are still useful without it. A task's run carries its parent's dagoref, and reading the
// digest there would print the whole plan under one task.
func runsDigest(channelId string, run *waveobj.Run) *wshrpc.CommandDagStatusRtnData {
	if run.DagORef == "" || run.Mode != jarvis.RunMode_Orchestrator {
		return nil
	}
	rtn, err := wshclient.DagStatusCommand(RpcClient, wshrpc.CommandDagStatusData{ChannelId: channelId, RunId: run.ID}, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		fmt.Fprintf(os.Stderr, "task digest unavailable: %v\n", err)
		return nil
	}
	return rtn
}

func runsShowRun(cmd *cobra.Command, args []string) error {
	ch, run, err := runsFind(cmd, args[0])
	if err != nil {
		return err
	}
	digest := runsDigest(ch.OID, run)
	if isJSON(cmd) {
		return jsonOut(map[string]any{"channel": ch.Name, "channelid": ch.OID, "run": run, "dag": digest})
	}
	for _, line := range runsShowLines(ch, run, digest, time.Now().UnixMilli()) {
		fmt.Println(line)
	}
	return nil
}

func runsShowLines(ch *waveobj.Channel, r *waveobj.Run, digest *wshrpc.CommandDagStatusRtnData, now int64) []string {
	lines := []string{
		"run      " + r.ID,
		"goal     " + runsClip(r.Goal, runsShowGoalWidth),
		fmt.Sprintf("project  %s (channel %s)", ch.Name, ch.OID),
		fmt.Sprintf("status   %s  mode=%s  created %s", r.Status, runsMode(r), runsAgo(r.CreatedTs, now)),
	}
	route := r.Runtime
	if r.Model != "" {
		route += " " + r.Model
	}
	if r.WorkerRoute != nil && r.WorkerRoute.Runtime != "" {
		route += "  workers=" + strings.TrimSpace(r.WorkerRoute.Runtime+" "+r.WorkerRoute.Model)
	}
	if route != "" {
		lines = append(lines, "route    "+route)
	}
	if r.EffortRef != nil && r.EffortRef.EffortOID != "" {
		lines = append(lines, fmt.Sprintf("effort   %s%s chunk %q", effortORefPrefix, r.EffortRef.EffortOID, r.EffortRef.ChunkLabel))
	}
	if r.Branch != "" {
		lines = append(lines, "branch   "+r.Branch)
	}
	switch {
	case r.EndCommit != "":
		lines = append(lines, fmt.Sprintf("commits  %s..%s", runsShort(r.BaseCommit), runsShort(r.EndCommit)))
	case r.BaseCommit != "":
		lines = append(lines, "base     "+runsShort(r.BaseCommit))
	}
	if usage := runsUsage(r, digest); len(usage) > 0 {
		lines = append(lines, "usage    "+usageTotals(usage, usageLabels))
	}
	if digest != nil {
		lines = append(lines, "")
		lines = append(lines, dagStatusLines(digest, now)...)
	}
	if ev := r.Evidence; ev != nil {
		lines = append(lines, "", fmt.Sprintf("sealed   %d files  +%d -%d  took %s", len(ev.Files), ev.AddTotal, ev.DelTotal, durOrZero(ev.DurationMs)))
		for _, v := range ev.Verifs {
			lines = append(lines, fmt.Sprintf("verify   %s  %s", v.Result, v.Cmd))
		}
		if v := ev.Verification; v != nil {
			lines = append(lines, "outcome  "+v.State)
			for _, reason := range v.Reasons {
				lines = append(lines, "         unverified: "+reason)
			}
		}
	}
	lines = append(lines, runsLandLines(r.Land)...)
	if report := runsReport(r); report != "" {
		lines = append(lines, "", "report", report)
	}
	return lines
}

// runsUsage is the sealed total, which counts the lead's wrap-up, else the one the dag took when it finished
func runsUsage(r *waveobj.Run, digest *wshrpc.CommandDagStatusRtnData) []waveobj.UsageRow {
	if r.Evidence != nil && len(r.Evidence.Usage) > 0 {
		return r.Evidence.Usage
	}
	if digest != nil {
		return digest.Digest.Report.Usage
	}
	return nil
}

// runsReport is the sealed summary, else the lead's report, which is what the seal is derived from
func runsReport(r *waveobj.Run) string {
	if r.Evidence != nil && r.Evidence.Summary != "" {
		return r.Evidence.Summary
	}
	return r.Report
}

func runsCancelRun(cmd *cobra.Command, args []string) error {
	ch, run, err := runsFind(cmd, args[0])
	if err != nil {
		return err
	}
	yes, _ := cmd.Flags().GetBool("yes")
	live := runsLiveWorkers(run, runsDigest(ch.OID, run))
	if live > 0 && !yes {
		return fmt.Errorf("run %s (%s, %q) has %d live worker(s); cancelling stops them. Re-run with --yes to cancel", run.ID, run.Status, runsClip(run.Goal, runsGoalWidth), live)
	}
	if err := wshclient.CancelRunCommand(RpcClient, wshrpc.CommandCancelRunData{ChannelId: ch.OID, RunId: run.ID}, &wshrpc.RpcOpts{Timeout: runsCancelTimeoutMs}); err != nil {
		return err
	}
	fmt.Printf("cancelled run %s\n", run.ID)
	return nil
}

// runsLandLines are where a run's branch stands on its way back into its base
func runsLandLines(l *waveobj.RunLand) []string {
	if l == nil {
		return nil
	}
	head := "land     " + l.State
	switch {
	case l.Reason != "":
		head += ": " + l.Reason
	case l.Commit != "":
		head += " " + runsShort(l.Commit)
	}
	lines := []string{head}
	for _, note := range l.Notes {
		lines = append(lines, "         note: "+note)
	}
	return lines
}

func runsLandRun(cmd *cobra.Command, args []string) error {
	ch, run, err := runsFind(cmd, args[0])
	if err != nil {
		return err
	}
	force, _ := cmd.Flags().GetBool("force")
	land, err := runsLand(ch.OID, run.ID, force)
	if err != nil {
		return err
	}
	for _, line := range runsLandLines(land) {
		fmt.Println(line)
	}
	if land.State != orchestrate.LandState_Landed {
		return fmt.Errorf("run %s did not land", run.ID)
	}
	return nil
}

func runsLand(channelId, runId string, force bool) (*waveobj.RunLand, error) {
	return wshclient.LandRunCommand(RpcClient, wshrpc.CommandLandRunData{ChannelId: channelId, RunId: runId, Force: force}, &wshrpc.RpcOpts{Timeout: runsLandTimeoutMs})
}

func runsAckRun(cmd *cobra.Command, args []string) error {
	ch, run, err := runsFind(cmd, args[0])
	if err != nil {
		return err
	}
	if err := runsAck(ch.OID, run.ID); err != nil {
		return err
	}
	fmt.Printf("acknowledged run %s\n", run.ID)
	return nil
}

func runsAck(channelId, runId string) error {
	return wshclient.AckRunCommand(RpcClient, wshrpc.CommandAckRunData{ChannelId: channelId, RunId: runId}, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
}

// runsLiveWorkers counts the workers a cancel would stop: the workers on a running phase plus an engine
// run's running tasks. It can overcount a worker that has already exited, which only costs a --yes.
func runsLiveWorkers(r *waveobj.Run, digest *wshrpc.CommandDagStatusRtnData) int {
	n := 0
	for _, p := range r.Phases {
		if p.State == jarvis.PhaseState_Running {
			n += len(p.WorkerOrefs)
		}
	}
	if digest != nil {
		n += digest.Digest.Counts.Running
	}
	return n
}

func runsAttentionRun(cmd *cobra.Command, args []string) error {
	rtn, err := wshclient.GetAttentionCommand(RpcClient, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return err
	}
	if isJSON(cmd) {
		return jsonOut(rtn.Items)
	}
	for _, line := range runsAttentionLines(rtn.Items, time.Now().UnixMilli()) {
		fmt.Println(line)
	}
	return nil
}

func runsAttentionLines(items []wshrpc.AttentionItem, now int64) []string {
	if len(items) == 0 {
		return []string{"nothing is waiting on you"}
	}
	var buf strings.Builder
	w := tabwriter.NewWriter(&buf, 0, 4, 2, ' ', 0)
	for _, it := range items {
		where := it.ChannelName
		if where == "" {
			where = "-"
		}
		run := it.RunId
		if run == "" {
			run = "-"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s: %s\n", it.Action, it.Kind, where, run, runsAgo(it.WaitingSince, now), runsClip(it.Source, runsGoalWidth), strings.Join(strings.Fields(it.Text), " "))
	}
	w.Flush()
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	return append(lines, "", "a run's detail: wsh runs show <run-id>; its tasks' questions: wsh jarvis dag asks --channel <id> --runid <run-id>")
}

func runsMode(r *waveobj.Run) string {
	if r.Mode == "" {
		return "pipeline" // a run stored before modes were recorded
	}
	return r.Mode
}

func runsAgo(ts, now int64) string {
	if ts <= 0 {
		return "-"
	}
	if d := compactDur(now - ts); d != "" {
		return d + " ago"
	}
	return "just now"
}

func runsShort(sha string) string {
	if sha == "" {
		return "?"
	}
	return sha[:min(7, len(sha))]
}

func runsClip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}
