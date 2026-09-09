// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/pitasks"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var jarvisDagCmd = &cobra.Command{
	Use:   "dag",
	Short: "orchestration engine: submit/steer a task DAG",
	Args:  cobra.NoArgs,
	RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

// dagOneDagPerRunNote states the constraint both submit paths hit at the same moment — after
// the planning cost is already spent. Stating it in help is the cheap half of the fix: a lead
// that reads it while planning never proposes the two-phase import the engine refuses.
var dagOneDagPerRunNote = fmt.Sprintf(`

A run holds exactly one dag for its whole lifetime: the first submission wins and a later,
differing one is rejected as a dag conflict. There is no multi-phase import, so a plan that
does not fit in %d tasks must be compressed, or split across two runs.`, orchestrate.MaxTasks)

// dagSubmitSource reads the DAG payload from exactly one source: inline argv JSON, or --file (a path,
// or "-" for stdin). A lead writing a large DAG cannot reliably quote it through argv on Windows,
// which is what --file is for.
func dagSubmitSource(args []string, file string, stdin io.Reader) ([]byte, error) {
	if len(args) == 1 && file != "" {
		return nil, fmt.Errorf("pass the dag JSON inline or with --file, not both")
	}
	if len(args) == 1 {
		return []byte(args[0]), nil
	}
	if file == "-" {
		return io.ReadAll(stdin)
	}
	if file != "" {
		return os.ReadFile(file)
	}
	return nil, fmt.Errorf("dag JSON required: pass it inline or with --file <path>")
}

var dagSubmitCmd = &cobra.Command{
	Use:     "submit [dag-json]",
	Short:   "validate and submit a DAG for the current run (inline JSON, or --file <path>|-)",
	Long:    "Validate and submit a DAG for the current run (inline JSON, or --file <path>|-)." + dagOneDagPerRunNote,
	Args:    cobra.MaximumNArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		file, _ := cmd.Flags().GetString("file")
		raw, err := dagSubmitSource(args, file, cmd.InOrStdin())
		if err != nil {
			return err
		}
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		var data wshrpc.CommandDagSubmitData
		if err := json.Unmarshal(raw, &data); err != nil {
			return fmt.Errorf("dag json: %w", err)
		}
		data.ChannelId = channelId
		data.RunId = runId
		g, err := wshclient.DagSubmitCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 20_000})
		if err != nil {
			return err
		}
		fmt.Printf("dag %s submitted (%d tasks, parallelism %d)\n", g.ID, len(g.Tasks), g.Parallelism)
		return nil
	},
}

var dagImportCmd = &cobra.Command{
	Use:     "import-tasks",
	Short:   "submit a DAG from the pi-tasks store in <cwd> (default .)",
	Long:    "Submit a DAG from the pi-tasks store in <cwd> (default .)." + dagOneDagPerRunNote,
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, _ := cmd.Flags().GetString("dir")
		if dir == "" {
			dir = "."
		}
		title, _ := cmd.Flags().GetString("title")
		tasks, err := pitasks.Read(dir)
		if err != nil {
			return fmt.Errorf("reading pi-tasks: %w", err)
		}
		nodes, err := orchestrate.ImportPitasks(tasks)
		if err != nil {
			return err
		}
		if title == "" && len(nodes) > 0 {
			title = nodes[0].Label
		}
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		parallelism, _ := cmd.Flags().GetInt("parallelism")
		if parallelism == 0 {
			parallelism = orchestrate.DefaultParallelism(nodes)
		}
		g, err := wshclient.DagSubmitCommand(RpcClient, wshrpc.CommandDagSubmitData{
			ChannelId: channelId, RunId: runId, Title: title, Parallelism: parallelism, Tasks: nodes,
		}, &wshrpc.RpcOpts{Timeout: 20_000})
		if err != nil {
			return err
		}
		fmt.Printf("dag %s submitted from %d pi-tasks (parallelism %d)\n", g.ID, len(g.Tasks), g.Parallelism)
		return nil
	},
}

var dagStatusCmd = &cobra.Command{
	Use:     "status",
	Short:   "print a per-task status digest (state, stall/ask signal, next action)",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		rtn, err := wshclient.DagStatusCommand(RpcClient, wshrpc.CommandDagStatusData{ChannelId: channelId, RunId: runId}, &wshrpc.RpcOpts{Timeout: 10_000})
		if err != nil {
			return err
		}
		for _, line := range dagStatusLines(rtn, time.Now().UnixMilli()) {
			fmt.Println(line)
		}
		return nil
	},
}

// dagWaitEvents is every engine event that can change what the lead should do next. Each is already
// registered in wps.AllEvents and published scoped to the owning run.
var dagWaitEvents = []string{
	wps.DagEventChildDone, wps.DagEventGateOpen, wps.DagEventBlocked, wps.DagEventComplete,
	wps.DagEventTaskSpawned, wps.DagEventChildAsk, wps.DagEventTaskStalled, wps.DagEventTaskRetried,
}

// waitDecision reports whether the lead should be handed control now, and why. Pure, so the blocking
// glue evaluates it identically against the first digest and every post-event digest. Actions come
// from the digest's own single derivation — never re-derived here from task state.
func waitDecision(d wshrpc.DagStatusDigest) (bool, string) {
	if d.Next.Kind == "terminal" || d.Health == "done" || d.Health == "cancelled" {
		status := d.Next.TerminalStatus
		if status == "" {
			status = d.Health
		}
		return true, "terminal:" + status
	}
	if len(d.Next.Actions) > 0 {
		return true, "action:" + d.Next.Kind
	}
	return false, ""
}

func printDagWait(rtn *wshrpc.CommandDagStatusRtnData, reason string) {
	fmt.Printf("woke: %s\n", reason)
	for _, line := range dagStatusLines(rtn, time.Now().UnixMilli()) {
		fmt.Println(line)
	}
	fmt.Printf("dagversion=%d\n", rtn.Digest.DagVersion)
}

// DagWaitDefaultTimeout is bounded by Claude Code's Bash tool, which caps at 600s: a wait that
// outlives its caller is killed and reported as a tool failure, which reads as a real error to a lead.
const DagWaitDefaultTimeout = 540

var dagWaitCmd = &cobra.Command{
	Use:     "wait",
	Short:   "block until the dag needs the lead, goes terminal, or the timeout elapses",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		timeoutSec, _ := cmd.Flags().GetInt("timeout")
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		// subscribe before the first status read: an event landing between the two would otherwise be
		// lost, and the lead would block on state that had already moved.
		runScope := waveobj.MakeORef(waveobj.OType_Run, runId).String()
		woke := make(chan struct{}, 1)
		for _, ev := range dagWaitEvents {
			RpcClient.EventListener.On(ev, func(e *wps.WaveEvent) {
				if !e.HasScope(runScope) {
					return
				}
				select {
				case woke <- struct{}{}:
				default: // a pending wake already covers this one
				}
			})
			wshclient.EventSubCommand(RpcClient, wps.SubscriptionRequest{Event: ev, Scopes: []string{runScope}}, nil)
		}
		// one deadline for the whole call, not restarted per event
		deadline := time.After(time.Duration(timeoutSec) * time.Second)
		for {
			rtn, err := wshclient.DagStatusCommand(RpcClient, wshrpc.CommandDagStatusData{ChannelId: channelId, RunId: runId}, &wshrpc.RpcOpts{Timeout: 10_000})
			if err != nil {
				return err
			}
			if rtn.Group == nil {
				// a sent-back plan is a wake, not an error: the dag the lead was waiting on was
				// discarded on purpose, and the notes are the whole point of returning here.
				if rtn.PlanFeedback != "" {
					fmt.Printf("woke: plan-sent-back\n%s\n", rtn.PlanFeedback)
					return nil
				}
				return fmt.Errorf("no dag for this run — submit one first")
			}
			if ret, reason := waitDecision(rtn.Digest); ret {
				printDagWait(rtn, reason)
				return nil
			}
			select {
			case <-woke:
				// re-read and re-evaluate; a purely informational event resumes blocking
			case <-deadline:
				printDagWait(rtn, "timeout")
				return nil
			}
		}
	},
}

// dagStatusLines renders the shared digest: header counts and per-task action/signal come from the
// backend's typed digest, never re-derived from task state locally.
func dagStatusLines(rtn *wshrpc.CommandDagStatusRtnData, now int64) []string {
	g := rtn.Group
	d := rtn.Digest
	if g == nil {
		if rtn.PlanFeedback != "" {
			return []string{"plan sent back — submit a revised dag", rtn.PlanFeedback}
		}
		return []string{"dag status unavailable"}
	}
	line := fmt.Sprintf("dag %s  status=%s  tasks=%d/%d  failures=%d  parallelism=%d",
		g.ID, g.Status, d.Counts.Done, d.Counts.Total, g.Failures, g.Parallelism)
	lines := []string{line}
	if len(g.Tasks) == 0 {
		return lines
	}
	taskDigestByID := map[string]wshrpc.DagTaskDigest{}
	for _, td := range d.Tasks {
		taskDigestByID[td.TaskId] = td
	}
	var buf strings.Builder
	w := tabwriter.NewWriter(&buf, 0, 4, 2, ' ', 0)
	for _, t := range g.Tasks {
		td, ok := taskDigestByID[t.ID]
		if !ok {
			continue
		}
		signal := ""
		if td.AskSummary != "" {
			signal = "ask: " + compactText(td.AskSummary, 60)
		} else if td.FreshnessTs > 0 && (t.State == orchestrate.TaskState_Running || t.State == orchestrate.TaskState_Stalled) {
			signal = "idle " + compactDur(now-td.FreshnessTs)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", t.ID, t.State, signal, strings.Join(td.HumanActions, ","), t.Label)
	}
	w.Flush()
	for _, row := range strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n") {
		lines = append(lines, row)
	}
	return lines
}

// compactDur renders a millisecond span as the shortest readable form ("45s", "2m3s", "1h2m").
func compactDur(ms int64) string {
	if ms <= 0 {
		return ""
	}
	d := time.Duration(ms) * time.Millisecond
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d/time.Second))
	case d < time.Hour:
		m := int(d / time.Minute)
		if s := int((d % time.Minute) / time.Second); s > 0 {
			return fmt.Sprintf("%dm%ds", m, s)
		}
		return fmt.Sprintf("%dm", m)
	case d < 24*time.Hour:
		h := int(d / time.Hour)
		if m := int((d % time.Hour) / time.Minute); m > 0 {
			return fmt.Sprintf("%dh%dm", h, m)
		}
		return fmt.Sprintf("%dh", h)
	default:
		return fmt.Sprintf("%dd%dh", int(d/(24*time.Hour)), int((d%(24*time.Hour))/time.Hour))
	}
}

// compactText truncates rune-wise with an ellipsis to n runes.
func compactText(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// dagIds returns the --channel/--runid flags, falling back to the caller's own run context when the
// lead runs the command from its own session (the engine never injects the ids, so the lead must not
// need to know them). A fallback that resolves nothing is an error — the command cannot target a dag.
func dagIds(cmd *cobra.Command) (string, string, error) {
	channelId, _ := cmd.Flags().GetString("channel")
	runId, _ := cmd.Flags().GetString("runid")
	if channelId != "" && runId != "" {
		return channelId, runId, nil
	}
	if RpcClient == nil {
		return "", "", fmt.Errorf("--channel/--runid required outside a wave session")
	}
	oref, err := resolveBlockArg()
	if err != nil {
		return "", "", fmt.Errorf("resolving block: %w", err)
	}
	rtn, err := wshclient.JarvisCtxCommand(RpcClient, wshrpc.CommandJarvisCtxData{BlockORef: oref.String()}, &wshrpc.RpcOpts{Timeout: 5000})
	if err != nil {
		return "", "", err
	}
	if rtn.RunId == "" {
		return "", "", fmt.Errorf("no run context for this block; pass --channel/--runid explicitly")
	}
	return rtn.ChannelId, rtn.RunId, nil
}

func dagAction(action string) *cobra.Command {
	return &cobra.Command{
		Use:     fmt.Sprintf("%s <task-id>", action),
		Short:   fmt.Sprintf("dag action: %s", action),
		Args:    cobra.ExactArgs(1),
		PreRunE: preRunSetupRpcClient,
		RunE: func(cmd *cobra.Command, args []string) error {
			channelId, runId, err := dagIds(cmd)
			if err != nil {
				return err
			}
			return wshclient.DagActionCommand(RpcClient, wshrpc.CommandDagActionData{
				ChannelId: channelId, RunId: runId, TaskId: args[0], Action: action,
			}, &wshrpc.RpcOpts{Timeout: 10_000})
		},
	}
}

func dagEscalateData(cmd *cobra.Command, args []string) (wshrpc.CommandDagActionData, error) {
	channelID, runID, err := dagIds(cmd)
	if err != nil {
		return wshrpc.CommandDagActionData{}, err
	}
	tier, _ := cmd.Flags().GetString("tier")
	model, _ := cmd.Flags().GetString("model")
	runtime, _ := cmd.Flags().GetString("runtime")
	return wshrpc.CommandDagActionData{
		ChannelId: channelID,
		RunId:     runID,
		TaskId:    args[0],
		Action:    "escalate",
		Tier:      tier,
		Model:     model,
		Runtime:   runtime,
	}, nil
}

var dagEscalateCmd = &cobra.Command{
	Use:     "escalate <task-id>",
	Short:   "re-queue a failed or stalled task on a chosen model (one judged hop)",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		data, err := dagEscalateData(cmd, args)
		if err != nil {
			return err
		}
		return wshclient.DagActionCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 10_000})
	},
}

var dagMergeCmd = &cobra.Command{
	Use:   "merge <task-id>",
	Short: "squash-merge a finished task's worktree back into the project branch",
	Long: "Squash-merge a finished task's worktree back into the project branch. On a squash\n" +
		"conflict the task enters blocked-merge: resolve the conflicts in the project tree, then\n" +
		"re-run with --continue so the engine commits the resolved state.",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		cont, err := cmd.Flags().GetBool("continue")
		if err != nil {
			return err
		}
		data := wshrpc.CommandDagMergeData{ChannelId: channelId, RunId: runId, TaskId: args[0]}
		if cont {
			return wshclient.DagMergeContinueCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 60_000})
		}
		return wshclient.DagMergeCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 60_000})
	},
}

var dagAsksCmd = &cobra.Command{
	Use:     "asks",
	Short:   "list pending asks of the dag's children",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		rtn, err := wshclient.DagAsksCommand(RpcClient, wshrpc.CommandDagStatusData{ChannelId: channelId, RunId: runId}, &wshrpc.RpcOpts{Timeout: 10_000})
		if err != nil {
			return err
		}
		if len(rtn.Asks) == 0 {
			fmt.Println("no pending child asks")
			return nil
		}
		for _, a := range rtn.Asks {
			fmt.Printf("%s: %s\n", a.TaskId, a.Question)
		}
		return nil
	},
}

var dagAnswerCmd = &cobra.Command{
	Use:     "answer <task-id> <answers-json>",
	Short:   "deliver an answer to a child's pending ask (answers-json: [{\"selectedindexes\":[0]}] or [{\"text\":\"...\"}])",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		var answers []baseds.AgentAnswerItem
		if err := json.Unmarshal([]byte(args[1]), &answers); err != nil {
			return fmt.Errorf("answers json: %w", err)
		}
		return wshclient.DagAnswerCommand(RpcClient, wshrpc.CommandDagAnswerData{
			ChannelId: channelId, RunId: runId, TaskId: args[0], Answers: answers,
		}, &wshrpc.RpcOpts{Timeout: 10_000})
	},
}

// dagAckCmd is invoked by the pi control watcher, not by a human — it echoes the control file's
// envelope back so the server can record that the lead actually received the event. Hidden because a
// hand-typed acknowledgement would be a claim nobody made.
var dagAckCmd = &cobra.Command{
	Use:     "ack",
	Short:   "confirm a lead-control event was dispatched (pi control watcher)",
	Hidden:  true,
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		channelId, _ := cmd.Flags().GetString("channel")
		runId, _ := cmd.Flags().GetString("runid")
		eventId, _ := cmd.Flags().GetString("event")
		sessionId, _ := cmd.Flags().GetString("session")
		return wshclient.PiControlAckCommand(RpcClient, wshrpc.CommandPiControlAckData{
			ChannelId: channelId, RunId: runId, EventId: eventId, SessionId: sessionId,
		}, &wshrpc.RpcOpts{Timeout: 5_000})
	},
}

var dagInitCmd = &cobra.Command{
	Use:   "init",
	Short: "scaffold a .pi/tasks/tasks.json store for a DAG (edit the sample, then import-tasks)",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		dir, _ := cmd.Flags().GetString("dir")
		if dir == "" {
			dir = "."
		}
		path := filepath.Join(dir, ".pi", "tasks", "tasks.json")
		if _, err := os.Stat(path); err == nil {
			return fmt.Errorf("%s already exists — edit it, or run import-tasks on it as-is", path)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		now := time.Now().UnixMilli()
		template := fmt.Sprintf(`{
  "nextId": 2,
  "tasks": [
    {
      "id": "1",
      "subject": "Example task: replace with your first unit of work",
      "description": "Plan context the child needs: file paths, pinned decisions, test commands. The engine passes label + description + the headless contract to the child, so pin here everything the child must not re-ask.",
      "status": "pending",
      "owner": "",
      "blocks": [],
      "blockedBy": [],
      "createdAt": %d,
      "updatedAt": %d
    }
  ]
}`, now, now)
		return os.WriteFile(path, []byte(template), 0o644)
	},
}

func init() {
	jarvisDagCmd.AddCommand(dagSubmitCmd, dagImportCmd, dagStatusCmd, dagMergeCmd, dagAsksCmd, dagAnswerCmd)
	jarvisDagCmd.AddCommand(dagAction("approve"), dagAction("sendback"), dagAction("retry"), dagAction("skip"), dagEscalateCmd, dagAction("cancel"))
	jarvisDagCmd.AddCommand(dagInitCmd, dagAckCmd, dagWaitCmd)
	for _, c := range jarvisDagCmd.Commands() {
		c.Flags().String("runid", "", "run id")
		c.Flags().String("channel", "", "channel id")
	}
	dagSubmitCmd.Flags().String("file", "", "read the dag JSON from a file (\"-\" for stdin)")
	dagWaitCmd.Flags().Int("timeout", DagWaitDefaultTimeout, "seconds to block before returning the current digest")
	dagImportCmd.Flags().String("dir", "", "pi-tasks dir (default .)")
	dagImportCmd.Flags().String("title", "", "dag title (shown in the ui; default runs the first task's label)")
	dagImportCmd.Flags().Int("parallelism", 0, fmt.Sprintf("concurrent children (1-%d); default is the dag's ready width", orchestrate.MaxParallelism))
	dagInitCmd.Flags().String("dir", "", "pi-tasks dir (default .)")
	dagAckCmd.Flags().String("event", "", "control event id from the control file envelope")
	dagAckCmd.Flags().String("session", "", "pi session id the control file was written for")
	dagEscalateCmd.Flags().String("model", "", "exact model id to retry on (e.g. opencode/claude-opus-4-8)")
	dagEscalateCmd.Flags().String("runtime", "", "runtime to retry on; empty keeps the task's current runtime")
	dagEscalateCmd.Flags().String("tier", "", "legacy: retry on a higher tier (mid|capable)")
	dagMergeCmd.Flags().Bool("continue", false, "finish a blocked squash merge after manual conflict resolution")
	jarvisCmd.AddCommand(jarvisDagCmd)
}
