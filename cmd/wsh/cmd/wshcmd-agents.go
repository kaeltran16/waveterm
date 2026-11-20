// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

const (
	agentsShortIdLen     = 8
	agentsWaitPoll       = 2 * time.Second
	agentsWaitDefault    = 10 * time.Minute
	agentsNoRun          = "-"
	agentsAllProjectsTip = "wsh agents list --all shows every project"
	agentsSelfMark       = "(you)"
	agentsTitleMax       = 60
	// a start may create a worktree and launch a process before it returns
	agentsStartTimeoutMs = 60_000
)

var agentsCmd = &cobra.Command{
	Use:   "agents",
	Short: "find a live agent tab, hand it a prompt, and read its last answer",
	Args:  cobra.NoArgs,
	RunE:  func(cmd *cobra.Command, args []string) error { return cmd.Help() },
}

var agentsListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list this project's live claude and pi agent tabs",
	Args:    cobra.NoArgs,
	PreRunE: preRunSetupRpcClient,
	RunE:    agentsListRun,
}

var agentsSendCmd = &cobra.Command{
	Use:   "send <tab> [text]",
	Short: "hand a prompt to a live agent's session; it joins the turn the agent is running, if any",
	Long: `Hand a prompt to a live agent's session, so follow-up work goes to the session that already holds
the context instead of a new run. <tab> is a tab id or a unique prefix of one, as 'wsh agents list'
prints it. The text is the argument or the contents of --file, never both.

The message arrives marked as sent by this agent, not typed by the user. The target cannot send one
back in the same turn: read its reply with 'wsh agents read <tab>', or pass --wait to have this
command wait for it.`,
	Args:    cobra.RangeArgs(1, 2),
	PreRunE: preRunSetupRpcClient,
	RunE:    agentsSendRun,
}

var agentsStartCmd = &cobra.Command{
	Use:   "start [task]",
	Short: "start a worker: a claude or pi agent in its own tab under this one; prints its tab id",
	Long: `Start a worker: an agent in its own tab, nested under this one in the Agent tree. The task is the
argument or the contents of --file, never both. Harness, model and permission mode default to this agent's;
--permission-mode may only be stricter. --worktree <branch> runs it in a new worktree on that new branch, off
this checkout's HEAD. Prints the worker's tab id and nothing else; read its answer with 'wsh agents read <tab>'
or 'wsh agents wait <tab>'.`,
	Args:    cobra.MaximumNArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE:    agentsStartRun,
}

var agentsWaitCmd = &cobra.Command{
	Use:   "wait <tab>",
	Short: "wait until a live agent is idle or asking the user, and print its answer",
	Long: `Wait until a live agent settles: it is idle or stopped (and its last answer is printed) or it has a
question or a permission prompt open for the user. --until idle (met by stopped too) or --until asking waits for
that state alone. Returns at once when the agent is already in it.`,
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE:    agentsWaitRun,
}

var agentsExplainCmd = &cobra.Command{
	Use:   "explain <tab>",
	Short: "print what Arc knows about a tab's agent and why it reads as live or not",
	Long: `Print what Arc reads about a tab's agent: whether 'wsh agents list' shows it and why not, its latest
status with the hook that reported it and when, whether its shell runs, whether its mod's control stream is
open and whether it has a question open. <tab> is a tab id or a unique prefix of one, a live agent or not.`,
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE:    agentsExplainRun,
}

var agentsReadCmd = &cobra.Command{
	Use:     "read <tab>",
	Short:   "print a live agent's last answer",
	Args:    cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE:    agentsReadRun,
}

func init() {
	agentsListCmd.Flags().Bool("all", false, "every project, not just this one")
	agentsListCmd.Flags().Bool("json", false, "JSON output")
	agentsListCmd.Flags().Bool("others", false, "leave out this session's own tab")
	agentsSendCmd.Flags().String("file", "", "read the text from this file instead of the argument")
	agentsSendCmd.Flags().Bool("json", false, "print the send's result as JSON; not with --wait")
	agentsSendCmd.Flags().Bool("wait", false, "wait for the target's answer and print it")
	agentsSendCmd.Flags().Duration("timeout", agentsWaitDefault, "how long --wait waits")
	agentsStartCmd.Flags().String("file", "", "read the task from this file instead of the argument")
	agentsStartCmd.Flags().String("harness", "", "claude or pi; this agent's by default")
	agentsStartCmd.Flags().String("model", "", "the model; this agent's by default, when the harness is the same")
	agentsStartCmd.Flags().String("reasoning", "", "the reasoning level, as the harness names it")
	agentsStartCmd.Flags().String("system-prompt", "", "replace the harness's system prompt")
	agentsStartCmd.Flags().String("append-system-prompt", "", "append to the harness's system prompt")
	agentsStartCmd.Flags().String("tools", "", "the only tools the worker gets, comma-separated")
	agentsStartCmd.Flags().String("permission-mode", "", "claude's permission mode, as strict as this agent's or stricter")
	agentsStartCmd.Flags().String("worktree", "", "a new branch the worker works on, in its own worktree")
	agentsStartCmd.Flags().Bool("json", false, "print the start's result as JSON")
	agentsWaitCmd.Flags().String("until", "", "idle or asking; either by default")
	agentsWaitCmd.Flags().Duration("timeout", agentsWaitDefault, "how long to wait")
	agentsReadCmd.Flags().Bool("json", false, "JSON output")
	agentsExplainCmd.Flags().Bool("json", false, "JSON output")
	agentsCmd.AddCommand(agentsListCmd, agentsSendCmd, agentsStartCmd, agentsWaitCmd, agentsReadCmd, agentsExplainCmd)
	rootCmd.AddCommand(agentsCmd)
}

func agentsListRun(cmd *cobra.Command, args []string) error {
	rtn, err := wshclient.AgentsListCommand(RpcClient, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return err
	}
	all, _ := cmd.Flags().GetBool("all")
	projectPath := ""
	if !all {
		if projectPath, err = agentsCallerProject(); err != nil {
			return err
		}
	}
	rows := agentsInProject(rtn.Agents, projectPath)
	selfTab := getTabIdFromEnv()
	if others, _ := cmd.Flags().GetBool("others"); others {
		rows = agentsWithout(rows, selfTab)
	}
	if isJSON(cmd) {
		return jsonOut(rows)
	}
	for _, line := range agentsListLines(rows, projectPath != "", selfTab) {
		fmt.Println(line)
	}
	return nil
}

// agentsCallerProject is the path of the project holding the current directory, "" when none does
func agentsCallerProject() (string, error) {
	chans, err := runsChannels()
	if err != nil {
		return "", err
	}
	p, _, err := runsProjectAt(chans, "")
	if err != nil {
		return "", fmt.Errorf("resolving this project (pass --all to skip it): %w", err)
	}
	if p == nil {
		return "", nil
	}
	return p.path, nil
}

// agentsInProject keeps the rows inside projectPath; an empty path keeps them all. Never nil, so --json
// prints [] for no rows.
func agentsInProject(rows []wshrpc.AgentInfo, projectPath string) []wshrpc.AgentInfo {
	kept := []wshrpc.AgentInfo{}
	for _, row := range rows {
		if projectPath == "" || runsPathWithin(row.ProjectPath, projectPath) {
			kept = append(kept, row)
		}
	}
	return kept
}

// agentsWithout drops the row of tab, the caller's own; an empty tab (none known) drops nothing. Never nil,
// so --json prints [] for no rows.
func agentsWithout(rows []wshrpc.AgentInfo, tab string) []wshrpc.AgentInfo {
	kept := []wshrpc.AgentInfo{}
	for _, row := range rows {
		if tab == "" || row.TabId != tab {
			kept = append(kept, row)
		}
	}
	return kept
}

// agentsListLines prints a row per agent. Two sessions in one project read alike by name, and a worktree's
// session files under its main checkout's project, so a row also shows where the session works when that is
// not the checkout, its task title, and which row is the caller's own.
func agentsListLines(rows []wshrpc.AgentInfo, filtered bool, selfTab string) []string {
	if len(rows) == 0 {
		if filtered {
			return []string{"no live agents in this project; " + agentsAllProjectsTip}
		}
		return []string{"no live agents"}
	}
	var buf strings.Builder
	w := tabwriter.NewWriter(&buf, 0, 4, 2, ' ', 0)
	for _, r := range rows {
		run := agentsNoRun
		if r.RunId != "" {
			run = agentsShort(r.RunId)
		}
		about := agentsTitle(r.Title)
		if r.TabId == selfTab {
			about = strings.TrimSpace(agentsSelfMark + " " + about)
		}
		fmt.Fprintln(w, strings.Join([]string{agentsShort(r.TabId), r.Name, r.Project, run, r.Harness, r.State, agentsWhere(r), about}, "\t"))
	}
	w.Flush()
	return strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
}

// agentsWhere is the session's directory when it is not its project's checkout, relative to the checkout when
// inside it (a .claude/worktrees tree), "-" otherwise
func agentsWhere(r wshrpc.AgentInfo) string {
	if r.Cwd == "" || runsNormPath(r.Cwd) == runsNormPath(r.ProjectPath) {
		return agentsNoRun
	}
	if runsPathWithin(r.Cwd, r.ProjectPath) {
		return runsNormPath(r.Cwd)[len(runsNormPath(r.ProjectPath))+1:]
	}
	return r.Cwd
}

// agentsTitle is a title on one line, cut to fit a terminal row
func agentsTitle(title string) string {
	t := []rune(strings.Join(strings.Fields(title), " "))
	if len(t) > agentsTitleMax {
		return string(t[:agentsTitleMax-1]) + "…"
	}
	return string(t)
}

func agentsShort(id string) string {
	return id[:min(agentsShortIdLen, len(id))]
}

func agentsSendRun(cmd *cobra.Command, args []string) error {
	wait, _ := cmd.Flags().GetBool("wait")
	asJSON := isJSON(cmd)
	if err := agentsSendFlagsErr(asJSON, wait); err != nil {
		return err
	}
	file, _ := cmd.Flags().GetString("file")
	text, err := agentsSendText(args[1:], file)
	if err != nil {
		return err
	}
	from, err := resolveBlockArg()
	if err != nil {
		return err
	}
	sent, err := wshclient.AgentsSendCommand(RpcClient, wshrpc.CommandAgentsSendData{Tab: args[0], Text: text, FromORef: from.String()},
		&wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return err
	}
	lines, err := agentsSendOutput(sent, asJSON)
	if err != nil {
		return err
	}
	for _, line := range lines {
		fmt.Println(line)
	}
	if !wait {
		return nil
	}
	timeout, _ := cmd.Flags().GetDuration("timeout")
	read := func() (*wshrpc.CommandAgentsReadRtnData, error) {
		return wshclient.AgentsReadCommand(RpcClient, wshrpc.CommandAgentsReadData{Tab: sent.TabId}, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	}
	answer, err := agentsWait(read, time.Sleep, time.Now, sent, timeout)
	if err != nil {
		return err
	}
	for _, line := range agentsWaitLines(answer) {
		fmt.Println(line)
	}
	return nil
}

// agentsSendText is the message: the text argument or the file's contents, exactly one of them, not blank
func agentsSendText(textArgs []string, file string) (string, error) {
	if (len(textArgs) > 0) == (file != "") {
		return "", fmt.Errorf("pass the text as an argument or with --file, one of them")
	}
	text := ""
	if file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return "", fmt.Errorf("reading --file: %w", err)
		}
		text = string(b)
	} else {
		text = textArgs[0]
	}
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("the message is empty")
	}
	return text, nil
}

// agentsSendFlagsErr refuses --json with --wait: --wait prints the answer as a second document, and two JSON
// documents on stdout would break a --json reader
func agentsSendFlagsErr(asJSON, wait bool) error {
	if asJSON && wait {
		return fmt.Errorf("EC-INVALID-ARGS: --json and --wait print two documents; drop one of them")
	}
	return nil
}

// agentsSendOutput is what the send prints: the RPC return as one JSON line under --json, else the text lines
func agentsSendOutput(sent *wshrpc.CommandAgentsSendRtnData, asJSON bool) ([]string, error) {
	if !asJSON {
		return agentsSendLines(sent), nil
	}
	b, err := json.Marshal(sent)
	if err != nil {
		return nil, err
	}
	return []string{string(b)}, nil
}

func agentsSendLines(sent *wshrpc.CommandAgentsSendRtnData) []string {
	how := "it started a turn"
	if sent.MidTurn {
		how = "it joined the turn the agent is running"
	}
	id := agentsShort(sent.TabId)
	return []string{
		fmt.Sprintf("sent to %s: %s", id, how),
		"read the answer with: wsh agents read " + id,
	}
}

func agentsStartRun(cmd *cobra.Command, args []string) error {
	file, _ := cmd.Flags().GetString("file")
	task, err := agentsSendText(args, file)
	if err != nil {
		return err
	}
	from, err := resolveBlockArg()
	if err != nil {
		return err
	}
	flag := func(name string) string {
		v, _ := cmd.Flags().GetString(name)
		return v
	}
	rtn, err := wshclient.AgentsStartCommand(RpcClient, wshrpc.CommandAgentsStartData{
		FromORef: from.String(), Prompt: task,
		Harness: flag("harness"), Model: flag("model"), Reasoning: flag("reasoning"), SystemPrompt: flag("system-prompt"),
		AppendSystemPrompt: flag("append-system-prompt"), Tools: flag("tools"), PermissionMode: flag("permission-mode"),
		Worktree: flag("worktree"),
	}, &wshrpc.RpcOpts{Timeout: agentsStartTimeoutMs})
	if err != nil {
		return err
	}
	out, err := agentsStartOutput(rtn, isJSON(cmd))
	if err != nil {
		return err
	}
	fmt.Println(out)
	return nil
}

// agentsStartOutput is what a start prints: the worker's tab id alone, so a caller can capture it, or the RPC
// return as one JSON line under --json
func agentsStartOutput(rtn *wshrpc.CommandAgentsStartRtnData, asJSON bool) (string, error) {
	if !asJSON {
		return rtn.TabId, nil
	}
	b, err := json.Marshal(rtn)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// errAgentsPollTimeout is agentsPoll's timeout, which each caller words for itself
var errAgentsPollTimeout = errors.New("timed out")

// agentsPoll reads every agentsWaitPoll until settled says the read ends the wait or fails, or the timeout
// passes, when it returns the last read with errAgentsPollTimeout. read, sleep and now are parameters so a
// test scripts them.
func agentsPoll(read func() (*wshrpc.CommandAgentsReadRtnData, error), sleep func(time.Duration), now func() time.Time,
	timeout time.Duration, settled func(r *wshrpc.CommandAgentsReadRtnData, elapsed time.Duration) (bool, error)) (*wshrpc.CommandAgentsReadRtnData, error) {
	start := now()
	for {
		r, err := read()
		if err != nil {
			return nil, err
		}
		done, err := settled(r, now().Sub(start))
		if err != nil {
			return nil, err
		}
		if done {
			return r, nil
		}
		if now().Sub(start) >= timeout {
			return r, errAgentsPollTimeout
		}
		sleep(agentsWaitPoll)
	}
}

// agentsWait polls read until the target has answered the send: it is no longer working and its last
// answer is newer than the send. A target that ends up asking the user is returned as it stands, since
// only the user can move it on. A send that started a turn fails once the target has stayed idle for the
// engine's wake-confirm window: the message did not reach the session.
func agentsWait(read func() (*wshrpc.CommandAgentsReadRtnData, error), sleep func(time.Duration), now func() time.Time,
	sent *wshrpc.CommandAgentsSendRtnData, timeout time.Duration) (*wshrpc.CommandAgentsReadRtnData, error) {
	id := agentsShort(sent.TabId)
	// a send into a running turn has no start to see, and the target may read idle between its turns
	started := sent.MidTurn
	r, err := agentsPoll(read, sleep, now, timeout, func(r *wshrpc.CommandAgentsReadRtnData, elapsed time.Duration) (bool, error) {
		if r.State == wshrpc.AgentsState_Asking {
			return true, nil
		}
		if r.State != wshrpc.AgentsState_Working && r.AnswerTs > sent.SentTs {
			return true, nil
		}
		started = started || r.State != wshrpc.AgentsState_Idle
		if !started && elapsed >= orchestrate.WakeConfirmTimeout {
			return false, fmt.Errorf("%s did not start a turn within %s, so the message may not have reached it; look at its terminal, or run 'wsh agents wait %s' later",
				id, orchestrate.WakeConfirmTimeout, id)
		}
		return false, nil
	})
	if errors.Is(err, errAgentsPollTimeout) {
		if r.State == wshrpc.AgentsState_Working {
			return nil, fmt.Errorf("%s is still working after %s; run 'wsh agents wait %s' to keep waiting", id, timeout, id)
		}
		return nil, fmt.Errorf("%s is %s after %s and has not answered since the send; run 'wsh agents wait %s' to keep waiting", id, r.State, timeout, id)
	}
	return r, err
}

// agentsCheckUntil refuses an --until other than the two states a caller can act on
func agentsCheckUntil(until string) error {
	if until != "" && until != wshrpc.AgentsState_Idle && until != wshrpc.AgentsState_Asking {
		return fmt.Errorf("--until is idle or asking, got %q", until)
	}
	return nil
}

// agentsWaitUntil polls read until the agent is in the until state, or settled for an empty until. A stopped
// worker has answered and holds no process, so it meets idle.
func agentsWaitUntil(read func() (*wshrpc.CommandAgentsReadRtnData, error), sleep func(time.Duration), now func() time.Time,
	until string, timeout time.Duration) (*wshrpc.CommandAgentsReadRtnData, error) {
	r, err := agentsPoll(read, sleep, now, timeout, func(r *wshrpc.CommandAgentsReadRtnData, _ time.Duration) (bool, error) {
		stopped := r.State == wshrpc.AgentsState_Stopped
		return r.State == until || (until == "" && r.State != wshrpc.AgentsState_Working) || (until == wshrpc.AgentsState_Idle && stopped), nil
	})
	if errors.Is(err, errAgentsPollTimeout) {
		id := agentsShort(r.TabId)
		return nil, fmt.Errorf("%s is still %s after %s; run 'wsh agents wait %s' to keep waiting", id, r.State, timeout, id)
	}
	return r, err
}

func agentsWaitRun(cmd *cobra.Command, args []string) error {
	until, _ := cmd.Flags().GetString("until")
	if err := agentsCheckUntil(until); err != nil {
		return err
	}
	timeout, _ := cmd.Flags().GetDuration("timeout")
	read := func() (*wshrpc.CommandAgentsReadRtnData, error) {
		return wshclient.AgentsReadCommand(RpcClient, wshrpc.CommandAgentsReadData{Tab: args[0]}, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	}
	r, err := agentsWaitUntil(read, time.Sleep, time.Now, until, timeout)
	if err != nil {
		return err
	}
	for _, line := range agentsWaitLines(r) {
		fmt.Println(line)
	}
	return nil
}

func agentsWaitLines(r *wshrpc.CommandAgentsReadRtnData) []string {
	if r.State == wshrpc.AgentsState_Asking {
		id := agentsShort(r.TabId)
		return []string{fmt.Sprintf("%s is waiting on the user: it has a question or a permission prompt open. Once it is answered, run 'wsh agents read %s'", id, id)}
	}
	return agentsReadLines(r)
}

func agentsReadRun(cmd *cobra.Command, args []string) error {
	rtn, err := wshclient.AgentsReadCommand(RpcClient, wshrpc.CommandAgentsReadData{Tab: args[0]}, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return err
	}
	if isJSON(cmd) {
		return jsonOut(rtn)
	}
	for _, line := range agentsReadLines(rtn) {
		fmt.Println(line)
	}
	return nil
}

func agentsReadLines(r *wshrpc.CommandAgentsReadRtnData) []string {
	if r.Answer == "" {
		return []string{fmt.Sprintf("%s has not answered yet (state: %s)", agentsShort(r.TabId), r.State)}
	}
	return []string{r.Answer}
}

func agentsExplainRun(cmd *cobra.Command, args []string) error {
	rtn, err := wshclient.AgentsExplainCommand(RpcClient, wshrpc.CommandAgentsExplainData{Tab: args[0]}, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		return err
	}
	if isJSON(cmd) {
		return jsonOut(rtn)
	}
	for _, line := range agentsExplainLines(rtn, time.Now()) {
		fmt.Println(line)
	}
	return nil
}

func agentsExplainLines(r *wshrpc.CommandAgentsExplainRtnData, now time.Time) []string {
	live := "yes, as " + r.State
	if !r.Live {
		live = "no: " + r.NotLive
	}
	shell := "not running"
	if r.ShellRunning {
		shell = "running"
	}
	stream := "none: a prompt is typed into the terminal"
	if r.HasStream {
		stream = "open: a prompt runs over the mod"
	}
	question := "none"
	if r.OpenAsk {
		question = "open"
	}
	lines := []string{
		fmt.Sprintf("tab       %s (%s)", r.TabId, r.Name),
		"live      " + live,
		"status    " + agentsExplainStatus(r.Status, now),
		"shell     " + shell,
		"stream    " + stream,
		"question  " + question,
	}
	if r.Status.Cwd != "" {
		lines = append(lines, "cwd       "+r.Status.Cwd)
	}
	if r.Status.TranscriptPath != "" {
		lines = append(lines, "transcript "+r.Status.TranscriptPath)
	}
	return lines
}

// agentsExplainStatus is the latest status report on one line: who reported what, from which hook, how long ago
func agentsExplainStatus(s baseds.AgentStatusData, now time.Time) string {
	if s.State == "" {
		return "none reported since wavesrv started"
	}
	line := s.Agent + " reported " + s.State
	if s.Hook != "" {
		line += " from " + s.Hook
		if s.NotificationType != "" {
			line += " (" + s.NotificationType + ")"
		}
	}
	line += " " + now.Sub(time.UnixMilli(s.Ts)).Round(time.Second).String() + " ago"
	if s.Detail != "" {
		line += ": " + s.Detail
	}
	return line
}
