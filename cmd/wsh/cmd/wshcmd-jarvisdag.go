// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/pitasks"
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

// dagPlanPath resolves --plan to an absolute path, because wavesrv parses the file and does not share
// this process's cwd. A plan is a whole dag on its own, so combining it with dag JSON is a mistake.
func dagPlanPath(args []string, file, plan string) (string, error) {
	if plan == "" {
		return "", nil
	}
	if len(args) == 1 || file != "" {
		return "", fmt.Errorf("pass --plan alone, not with dag JSON or --file")
	}
	return filepath.Abs(plan)
}

var dagSubmitCmd = &cobra.Command{
	Use:     "submit [dag-json]",
	Short:   "validate and submit a DAG for the current run (--plan <plan.md>, inline JSON, or --file <path>|-)",
	Long:    "Validate and submit a DAG for the current run (--plan <plan.md>, inline JSON, or --file <path>|-).\n\n" + jarvis.PlanFormat + dagOneDagPerRunNote,
	Args:    cobra.MaximumNArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		file, _ := cmd.Flags().GetString("file")
		plan, _ := cmd.Flags().GetString("plan")
		planPath, err := dagPlanPath(args, file, plan)
		if err != nil {
			return err
		}
		var data wshrpc.CommandDagSubmitData
		if planPath != "" {
			data.PlanPath = planPath
		} else {
			raw, err := dagSubmitSource(args, file, cmd.InOrStdin())
			if err != nil {
				return err
			}
			if err := json.Unmarshal(raw, &data); err != nil {
				return fmt.Errorf("dag json: %w", err)
			}
		}
		channelId, runId, err := dagIds(cmd)
		if err != nil {
			return err
		}
		data.ChannelId = channelId
		data.RunId = runId
		g, err := wshclient.DagSubmitCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 20_000})
		if err != nil {
			return err
		}
		fmt.Printf("dag %s submitted (%d tasks, %d lanes, longest chain %d, parallelism %d)\n", g.ID, len(g.Tasks), len(jarvis.Lanes(g.Tasks)), jarvis.LongestChain(g.Tasks), g.Parallelism)
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
	model, _ := cmd.Flags().GetString("model")
	if model == "" {
		return wshrpc.CommandDagActionData{}, fmt.Errorf("--model is required")
	}
	runtime, _ := cmd.Flags().GetString("runtime")
	return wshrpc.CommandDagActionData{
		ChannelId: channelID,
		RunId:     runID,
		TaskId:    args[0],
		Action:    "escalate",
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
	Short:   "list the questions waiting on the lead, oldest first, with every option",
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
		for _, line := range dagAskLines(rtn.Asks, time.Now().UnixMilli()) {
			fmt.Println(line)
		}
		return nil
	},
}

// dagAskLines renders the lead's question queue, oldest first: every question of every entry the lead
// holds, with the option indexes `dag answer` takes. Entries the human holds are only counted, since
// the lead handed them on and an answer from it would race the human's.
func dagAskLines(asks []wshrpc.DagAskItem, now int64) []string {
	sorted := append([]wshrpc.DagAskItem(nil), asks...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Ts < sorted[j].Ts })
	var lines []string
	held := 0
	for _, a := range sorted {
		if a.Owner == agentask.AskOwner_User {
			held++
			continue
		}
		lines = append(lines, dagAskHeading(a, now))
		if a.Note != "" {
			lines = append(lines, "  note: "+a.Note)
		}
		for _, q := range a.Questions {
			lines = append(lines, dagQuestionLines(q)...)
		}
	}
	if len(lines) == 0 {
		lines = append(lines, "no questions waiting")
	} else {
		lines = append(lines,
			`answer:  wsh jarvis dag answer <task-id> '[{"selectedindexes":[0]}]'  (one item per question, in order; {"text":"..."} for free text)`,
			`forward: wsh jarvis dag forward <task-id> "<what you checked, what you recommend>"`)
	}
	if held > 0 {
		lines = append(lines, fmt.Sprintf("%d held by the human in the run cockpit", held))
	}
	return lines
}

func dagAskHeading(a wshrpc.DagAskItem, now int64) string {
	age := compactDur(now - a.Ts)
	if age == "" {
		age = "0s"
	}
	line := fmt.Sprintf("%s  asked %s ago", a.TaskId, age)
	if a.Deadline == 0 {
		return line
	}
	if left := a.Deadline - now; left > 0 {
		return line + "  deadline in " + compactDur(left)
	}
	return line + "  deadline passed"
}

func dagQuestionLines(q baseds.AgentAskQuestion) []string {
	head := "  " + q.Question
	if q.Header != "" {
		head = fmt.Sprintf("  [%s] %s", q.Header, q.Question)
	}
	if q.MultiSelect {
		head += " (multi-select)"
	}
	lines := []string{head}
	for i, o := range q.Options {
		opt := fmt.Sprintf("    %d) %s", i, o.Label)
		if o.Description != "" {
			opt += " - " + o.Description
		}
		lines = append(lines, opt)
	}
	return lines
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

// dagForwardData is the forward action's payload. The note is not checked here: the server owns what
// a forward needs.
func dagForwardData(cmd *cobra.Command, args []string) (wshrpc.CommandDagActionData, error) {
	channelId, runId, err := dagIds(cmd)
	if err != nil {
		return wshrpc.CommandDagActionData{}, err
	}
	return wshrpc.CommandDagActionData{ChannelId: channelId, RunId: runId, TaskId: args[0], Action: "forward", Notes: args[1]}, nil
}

var dagForwardCmd = &cobra.Command{
	Use:     "forward <task-id> <note>",
	Short:   "hand a task's question, failure, stall or merge conflict to the human, with what you checked and recommend",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		data, err := dagForwardData(cmd, args)
		if err != nil {
			return err
		}
		return wshclient.DagActionCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 10_000})
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
	jarvisDagCmd.AddCommand(dagSubmitCmd, dagImportCmd, dagStatusCmd, dagMergeCmd, dagAsksCmd, dagAnswerCmd, dagForwardCmd)
	jarvisDagCmd.AddCommand(dagAction("approve"), dagAction("sendback"), dagAction("retry"), dagAction("skip"), dagEscalateCmd, dagAction("cancel"))
	jarvisDagCmd.AddCommand(dagInitCmd)
	for _, c := range jarvisDagCmd.Commands() {
		c.Flags().String("runid", "", "run id")
		c.Flags().String("channel", "", "channel id")
	}
	dagSubmitCmd.Flags().String("file", "", "read the dag JSON from a file (\"-\" for stdin)")
	dagSubmitCmd.Flags().String("plan", "", "submit a plan file in the plan format below; its tasks become the dag")
	dagImportCmd.Flags().String("dir", "", "pi-tasks dir (default .)")
	dagImportCmd.Flags().String("title", "", "dag title (shown in the ui; default runs the first task's label)")
	dagImportCmd.Flags().Int("parallelism", 0, fmt.Sprintf("concurrent children (1-%d); default is the dag's ready width", orchestrate.MaxParallelism))
	dagInitCmd.Flags().String("dir", "", "pi-tasks dir (default .)")
	dagEscalateCmd.Flags().String("model", "", "exact model id to retry on (e.g. sonnet, or opencode/deepseek-v4-pro for pi)")
	dagEscalateCmd.Flags().String("runtime", "", "runtime to retry on; empty keeps the task's current runtime")
	dagMergeCmd.Flags().Bool("continue", false, "finish a blocked squash merge after manual conflict resolution")
	jarvisCmd.AddCommand(jarvisDagCmd)
}
