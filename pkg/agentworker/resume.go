// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentworker

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// startAgentTab starts a worker's process. A var so tests need no pty.
var startAgentTab = jarvis.StartAgentTab

// resumeMu serializes resumes: a forced start replaces a running process, so two messages reaching one stopped
// worker at once would start its session twice and kill the first.
var resumeMu sync.Mutex

// ResumeWorker starts a worker's process again in its own session with prompt as the turn's message, after the
// memory gate admits it. On a refusal or a failed start the worker stays stopped.
func ResumeWorker(ctx context.Context, tabId, prompt string) error {
	resumeMu.Lock()
	defer resumeMu.Unlock()
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return fmt.Errorf("loading worker tab %s: %w", tabId, err)
	}
	if ParentOf(tab) == "" {
		return fmt.Errorf("tab %s is not a worker an agent started", tabId)
	}
	if len(tab.BlockIds) == 0 {
		return fmt.Errorf("worker tab %s has no block", tabId)
	}
	blockId := tab.BlockIds[0]
	if rs := blockcontroller.GetBlockControllerRuntimeStatus(blockId); rs != nil && rs.ShellProcStatus == blockcontroller.Status_Running {
		return fmt.Errorf("worker %s is already running; send the message again", tabId)
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return fmt.Errorf("loading worker block %s: %w", blockId, err)
	}
	cwd := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	if !wavebase.SnapshotMayStart(cwd) {
		return fmt.Errorf("snapshot store: not resuming the worker in %q, only workers inside %s", cwd, wavebase.SnapshotScratchDir())
	}
	args, err := resumeArgs(tab, block, prompt)
	if err != nil {
		return err
	}
	claim, err := Admit(cwd, tabId)
	if err != nil {
		return err
	}
	if err := armAndStart(ctx, tabId, blockId, args); err != nil {
		claim.Release()
		return err
	}
	Bind(claim, blockId)
	if err := PublishStatus(ctx, blockId, baseds.AgentState_Working, time.Now()); err != nil {
		// the worker runs, and its own hooks report its status soon after
		log.Printf("agentworker: publishing worker %s working: %v", tabId, err)
	}
	return nil
}

// resumeArgs is the command line that reopens the worker's session with its first start's launch flags, so the
// prompt cache prefix still matches. A message too long for a command line moves to a file.
func resumeArgs(tab *waveobj.Tab, block *waveobj.Block, prompt string) ([]string, error) {
	// function-scoped: the start defines the package's own name for this key
	const metaBaseArgs = "agent:baseargs"
	sessionId := block.Meta.GetString(MetaSessionId, "")
	if sessionId == "" || !block.Meta.HasKey(metaBaseArgs) {
		return nil, fmt.Errorf("worker %s has no session to resume", tab.OID)
	}
	harness := tab.Meta.GetString(metaTabHarness, "")
	// ResumeWorkerArgs reads an empty harness as a legacy run's claude, and a worker always names its own
	if harness == "" {
		return nil, fmt.Errorf("worker %s names no harness", tab.OID)
	}
	prompt, err := jarvis.LaunchPrompt(prompt, "")
	if err != nil {
		return nil, err
	}
	args, ok := jarvis.ResumeWorkerArgs(harness, sessionId, block.Meta.GetStringList(metaBaseArgs), prompt)
	if !ok {
		return nil, fmt.Errorf("harness %q cannot resume a session", harness)
	}
	return args, nil
}

// armAndStart gives the block its controller back with the resume's command line and starts it. A failed start
// disarms the block again. Either reaches the frontend at once, so the worker's stopped mark follows it.
func armAndStart(ctx context.Context, tabId, blockId string, args []string) error {
	ctx, flush := jarvis.CollectUpdates(ctx)
	defer flush()
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId)
	arm := waveobj.MetaMapType{waveobj.MetaKey_Controller: blockcontroller.BlockController_Cmd, waveobj.MetaKey_CmdArgs: args}
	if _, err := wstore.UpdateObjectMeta(ctx, oref, arm, false); err != nil {
		return fmt.Errorf("arming worker block %s: %w", blockId, err)
	}
	startErr := startAgentTab(ctx, tabId, blockId)
	if startErr == nil {
		return nil
	}
	disarm := waveobj.MetaMapType{waveobj.MetaKey_Controller: ""}
	if _, err := wstore.UpdateObjectMeta(context.WithoutCancel(ctx), oref, disarm, false); err != nil {
		log.Printf("agentworker: disarming worker block %s after a failed start: %v", blockId, err)
	}
	return fmt.Errorf("starting worker %s: %w", tabId, startErr)
}
