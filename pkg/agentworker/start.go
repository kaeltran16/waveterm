// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const metaTabProject = "session:project"

// parentTab is what a worker takes from the agent that starts it.
type parentTab struct {
	tab         *waveobj.Tab
	workspaceId string
	cwd         string
	facts       Parent
}

// Start opens a worker's tab under the agent at data.FromORef and starts it. Nothing is left behind on a refusal:
// the tab is opened unstarted, the memory gate is asked with its id, and a refusal deletes it before the one
// flush of updates, so the UI never shows it.
func Start(ctx context.Context, data wshrpc.CommandAgentsStartData) (*wshrpc.CommandAgentsStartRtnData, error) {
	if strings.TrimSpace(data.Prompt) == "" {
		return nil, fmt.Errorf("the task is empty")
	}
	parent, err := loadParentTab(ctx, data.FromORef)
	if err != nil {
		return nil, err
	}
	launch, err := ComposeLaunch(SessionOptions{
		Harness: data.Harness, Model: data.Model, Reasoning: data.Reasoning, SystemPrompt: data.SystemPrompt,
		AppendSystemPrompt: data.AppendSystemPrompt, Tools: data.Tools, PermissionMode: data.PermissionMode,
	}, parent.facts)
	if err != nil {
		return nil, err
	}
	cwd, err := workDir(ctx, parent.cwd, data.Worktree)
	if err != nil {
		return nil, err
	}
	if !wavebase.SnapshotMayStart(cwd) {
		return nil, fmt.Errorf("snapshot store: not starting a worker in %q, only inside %s", cwd, wavebase.SnapshotScratchDir())
	}
	sessionId := uuid.NewString()
	prompt, err := jarvis.LaunchPrompt(data.Prompt, sessionId)
	if err != nil {
		return nil, err
	}

	ctx = waveobj.ContextWithUpdates(ctx)
	defer func() { wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx)) }()
	tabId, blockId, err := jarvis.OpenAgentTab(ctx, jarvis.AgentTabSpec{
		WorkspaceId: parent.workspaceId,
		TabName:     parent.tab.Meta.GetString(metaTabProject, parent.tab.Name),
		TabMeta: waveobj.MetaMapType{
			metaTabHarness: launch.Harness,
			metaTabProject: parent.tab.Meta.GetString(metaTabProject, ""),
			MetaParentTab:  parent.tab.OID,
		},
		BlockMeta: workerBlockMeta(launch, cwd, sessionId, prompt),
	})
	if err != nil {
		return nil, err
	}
	claim, err := Admit(cwd, tabId)
	if err != nil {
		removeTab(ctx, parent.workspaceId, tabId)
		return nil, err
	}
	if err := prepareDir(ctx, parent.cwd, cwd, data.Worktree, launch.Harness); err != nil {
		abandon(ctx, claim, parent.workspaceId, tabId)
		return nil, err
	}
	if err := startAgentTab(ctx, tabId, blockId); err != nil {
		abandon(ctx, claim, parent.workspaceId, tabId)
		return nil, fmt.Errorf("starting the worker: %w", err)
	}
	Bind(claim, blockId)
	// the worker runs either way; the roster lists it once its own hooks report
	if err := PublishStatus(ctx, blockId, baseds.AgentState_Working); err != nil {
		log.Printf("agentworker: publishing the first status of worker %s: %v", tabId, err)
	}
	return &wshrpc.CommandAgentsStartRtnData{TabId: tabId, Harness: launch.Harness, Cwd: cwd}, nil
}

// loadParentTab reads the calling agent's tab, workspace, directory and latest status. Its directory is the one it
// reports, or its block's cmd:cwd before it has reported one.
func loadParentTab(ctx context.Context, fromORef string) (*parentTab, error) {
	oref, err := waveobj.ParseORef(fromORef)
	if err != nil || oref.OType != waveobj.OType_Block {
		return nil, fmt.Errorf("cannot tell who is starting the worker: %q is not a block; wsh agents start runs inside an agent's terminal", fromORef)
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, oref.OID)
	if err != nil {
		return nil, fmt.Errorf("finding the tab of block %s: %w", oref.OID, err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return nil, fmt.Errorf("loading the parent's tab %s: %w", tabId, err)
	}
	if len(tab.BlockIds) == 0 {
		return nil, fmt.Errorf("the parent's tab %s has no block", tabId)
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		return nil, fmt.Errorf("loading the parent's block: %w", err)
	}
	workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return nil, fmt.Errorf("finding the workspace of tab %s: %w", tabId, err)
	}
	if workspaceId == "" {
		return nil, fmt.Errorf("the parent's tab %s is in no workspace", tabId)
	}
	status := orchestrate.LatestAgentStatus(block.OID, tabId)
	harness := status.Agent
	if harness == "" {
		harness = tab.Meta.GetString(metaTabHarness, "")
	}
	p := &parentTab{tab: tab, workspaceId: workspaceId, cwd: status.Cwd, facts: Parent{
		Harness: harness, Model: parentModel(harness, status), PermissionMode: status.PermissionMode,
	}}
	if p.cwd == "" {
		p.cwd = block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	}
	if p.cwd == "" {
		return nil, fmt.Errorf("the parent reports no directory to start the worker in")
	}
	return p, nil
}

// parentModel is the model the parent runs, as a route names it. pi reports its provider apart from the model id. A
// claude status may carry no model (a Notification, the mod's own idle), and then the transcript says it.
func parentModel(harness string, status baseds.AgentStatusData) string {
	switch {
	case harness == "pi" && status.Provider != "" && status.Model != "":
		return status.Provider + "/" + status.Model
	case harness == "claude" && status.Model == "" && status.TranscriptPath != "":
		return agentsessions.LastClaudeModel(status.TranscriptPath)
	}
	return status.Model
}

// workDir is where the worker works: the parent's directory, or with a branch the worktree that branch will get.
// It creates nothing, so a refusal later leaves no worktree behind.
func workDir(ctx context.Context, parentCwd, branch string) (string, error) {
	if branch == "" {
		return parentCwd, nil
	}
	if _, err := gitinfo.HeadCommit(ctx, parentCwd); err != nil {
		return "", fmt.Errorf("--worktree needs a git repository with a commit, and %s is not one: %w", parentCwd, err)
	}
	if _, err := gitinfo.ResolveCommit(ctx, parentCwd, "refs/heads/"+branch); err == nil {
		return "", fmt.Errorf("branch %q already exists: --worktree takes a new branch", branch)
	}
	wt := gitinfo.WorktreePath(parentCwd, branch)
	if _, err := os.Stat(wt); err == nil {
		return "", fmt.Errorf("%s already exists: --worktree takes a new branch with a new worktree", wt)
	}
	return wt, nil
}

// prepareDir creates the worktree when one was asked for, and registers claude's folder trust, whose first-run
// prompt would otherwise hold an unattended start.
func prepareDir(ctx context.Context, parentCwd, cwd, branch, harness string) error {
	if branch != "" {
		if _, err := gitinfo.CreateWorktree(ctx, parentCwd, branch); err != nil {
			return fmt.Errorf("creating the worktree for %s: %w", branch, err)
		}
	}
	if harness == "claude" {
		if err := jarvis.EnsureClaudeDirTrusted(cwd); err != nil {
			return fmt.Errorf("registering claude folder trust for %s: %w", cwd, err)
		}
	}
	return nil
}

// workerBlockMeta is the worker block's launch meta. Unlike a run worker's it has no ARC_RUN_AGENT: a worker is an
// ordinary agent that asks in its own terminal.
func workerBlockMeta(l Launch, cwd, sessionId, prompt string) waveobj.MetaMapType {
	// non-nil even when empty: a missing agent:baseargs reads as "launched before resume support"
	baseArgs := l.BaseArgs
	if baseArgs == nil {
		baseArgs = []string{}
	}
	return waveobj.MetaMapType{
		waveobj.MetaKey_View:          "term",
		waveobj.MetaKey_Controller:    "cmd",
		waveobj.MetaKey_Cmd:           l.Bin,
		waveobj.MetaKey_CmdArgs:       FirstStartArgs(l, sessionId, prompt),
		"agent:baseargs":              baseArgs,
		waveobj.MetaKey_CmdShell:      false,
		waveobj.MetaKey_CmdJwt:        true,
		waveobj.MetaKey_CmdCwd:        cwd,
		waveobj.MetaKey_CmdKeepOnExit: true,
		waveobj.MetaKey_CmdEnv:        map[string]any{consult.PromptCacheTTLEnv: consult.ShortSessionCacheTTL},
		MetaSessionId:                 sessionId,
		MetaNoticeOwed:                true,
	}
}

// abandon undoes an admitted start that failed before its process ran.
func abandon(ctx context.Context, claim *memgate.Claim, workspaceId, tabId string) {
	claim.Release()
	removeTab(ctx, workspaceId, tabId)
}

// removeTab deletes a worker's tab that never started. Uncancelled, since an expired ctx is one way to get here.
func removeTab(ctx context.Context, workspaceId, tabId string) {
	if _, err := wcore.DeleteTab(context.WithoutCancel(ctx), workspaceId, tabId, false); err != nil {
		log.Printf("agentworker: removing the tab %s of a refused start: %v", tabId, err)
	}
}
