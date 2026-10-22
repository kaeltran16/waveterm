// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/brainstormcheck"
	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// builderCheckPollEvery is how often a watcher judges its reviewer's run.
const builderCheckPollEvery = 5 * time.Second

const (
	builderCheckReading  = "reading"
	builderCheckAnswered = "answered"
	builderCheckFailed   = "failed"

	builderCheckRestartedReason = "Arc restarted before the builder started."
	builderCheckDetachedReason  = "Arc restarted and the brainstorm is no longer attached to this tab."
)

// launchBuilderCheck starts the reviewer's session. A var so tests spawn no worker.
var launchBuilderCheck = orchestrate.LaunchJudgingSession

// readBuilderCheckRun reads the reviewer's run. A var so tests can script it.
var readBuilderCheckRun = wstore.GetRun

// armBuilderCheck starts a check's watcher on a detached context, off the handler's RPC budget. A var so tests
// drive the watcher's steps themselves.
var armBuilderCheck = func(c builderCheck) { go watchBuilderCheck(context.Background(), c) }

// builderCheckMu makes the handler's not-reading check and its reading write one step.
var builderCheckMu sync.Mutex

// builderCheck is one check in flight. Project, Spec and Title are set only before the launch; RunId, ChannelId
// once the reviewer is launched. StartedTs is the record's checkts.
type builderCheck struct {
	TabId, BlockId, File string
	Project, Spec, Title string
	RunId, ChannelId     string
	StartedTs            int64
}

// brainstormDoc is what the check reads from brainstorm.json.
type brainstormDoc struct {
	Title string `json:"title"`
	Spec  string `json:"spec"`
}

func (ws *WshServer) BrainstormCheckCommand(ctx context.Context, data wshrpc.CommandBrainstormCheckData) error {
	if data.BlockId == "" || data.File == "" {
		return fmt.Errorf("a block id and a brainstorm file are required")
	}
	c, err := readBrainstormForCheck(data.File)
	if err != nil {
		return err
	}
	c.BlockId = data.BlockId
	c.TabId, err = wstore.DBFindTabForBlockId(ctx, data.BlockId)
	if err != nil {
		return fmt.Errorf("finding the tab of block %s: %w", data.BlockId, err)
	}
	builderCheckMu.Lock()
	defer builderCheckMu.Unlock()
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, c.TabId)
	if err != nil {
		return fmt.Errorf("loading tab %s: %w", c.TabId, err)
	}
	if tab.Meta.GetString(waveobj.MetaKey_BrainstormCheckState, "") == builderCheckReading {
		return fmt.Errorf("a builder check is already running")
	}
	c.StartedTs = time.Now().UnixMilli()
	if err := setBuilderCheck(ctx, c.TabId, builderCheckReading, c.StartedTs, "", "", ""); err != nil {
		return err
	}
	armBuilderCheck(c)
	return nil
}

// readBrainstormForCheck reads file and checks that the spec it names exists, relative to the brainstorm's
// project: the directory above .superpowers.
func readBrainstormForCheck(file string) (builderCheck, error) {
	if !filepath.IsAbs(file) {
		return builderCheck{}, fmt.Errorf("the brainstorm file must be an absolute path: %s", file)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return builderCheck{}, fmt.Errorf("reading %s: %w", file, err)
	}
	var doc brainstormDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return builderCheck{}, fmt.Errorf("%s is not valid JSON: %w", file, err)
	}
	if doc.Spec == "" {
		return builderCheck{}, fmt.Errorf("%s names no spec: set spec to the spec's path", file)
	}
	project, err := brainstormProject(file)
	if err != nil {
		return builderCheck{}, err
	}
	spec := doc.Spec
	if !filepath.IsAbs(spec) {
		spec = filepath.Join(project, spec)
	}
	if info, err := os.Stat(spec); err != nil || info.IsDir() {
		return builderCheck{}, fmt.Errorf("the spec %s does not exist: write it before starting the check", spec)
	}
	title := doc.Title
	if title == "" {
		title = filepath.Base(filepath.Dir(file))
	}
	return builderCheck{File: file, Project: project, Spec: spec, Title: title}, nil
}

func brainstormProject(file string) (string, error) {
	for dir := filepath.Dir(file); filepath.Dir(dir) != dir; dir = filepath.Dir(dir) {
		if filepath.Base(dir) == ".superpowers" {
			return filepath.Dir(dir), nil
		}
	}
	return "", fmt.Errorf("%s is not under a .superpowers directory", file)
}

// setBuilderCheck writes the check's record on the agent's tab, all five keys at once, clearing the empty ones,
// and broadcasts the tab.
func setBuilderCheck(ctx context.Context, tabId, state string, ts int64, run, channel, reason string) error {
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_BrainstormCheckState:   state,
		waveobj.MetaKey_BrainstormCheckTs:      ts,
		waveobj.MetaKey_BrainstormCheckRun:     nil,
		waveobj.MetaKey_BrainstormCheckChannel: nil,
		waveobj.MetaKey_BrainstormCheckReason:  nil,
	}
	for key, val := range map[string]string{
		waveobj.MetaKey_BrainstormCheckRun:     run,
		waveobj.MetaKey_BrainstormCheckChannel: channel,
		waveobj.MetaKey_BrainstormCheckReason:  reason,
	} {
		if val != "" {
			meta[key] = val
		}
	}
	oref := waveobj.MakeORef(waveobj.OType_Tab, tabId)
	if _, err := wstore.UpdateObjectMeta(ctx, oref, meta, false); err != nil {
		return fmt.Errorf("writing the builder check on tab %s: %w", tabId, err)
	}
	wcore.SendWaveObjUpdate(oref)
	return nil
}

func failBuilderCheck(ctx context.Context, c builderCheck, reason string) {
	if err := setBuilderCheck(ctx, c.TabId, builderCheckFailed, time.Now().UnixMilli(), c.RunId, c.ChannelId, reason); err != nil {
		log.Printf("builder check: %v", err)
	}
}

// watchBuilderCheck launches c's reviewer when it has none yet, then judges its run until it is delivered or
// failed.
func watchBuilderCheck(ctx context.Context, c builderCheck) {
	if c.RunId == "" {
		if err := startBuilderCheck(ctx, &c); err != nil {
			failBuilderCheck(ctx, c, "Arc could not start the builder: "+err.Error())
			return
		}
	}
	for !tickBuilderCheck(ctx, c, time.Now().UnixMilli()) {
		time.Sleep(builderCheckPollEvery)
	}
}

// startBuilderCheck launches c's reviewer in the project's channel, in the workspace that holds the agent's tab,
// and records its run on the tab.
func startBuilderCheck(ctx context.Context, c *builderCheck) error {
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, c.TabId)
	if err != nil {
		return fmt.Errorf("loading tab %s: %w", c.TabId, err)
	}
	name := tab.Meta.GetString(waveobj.MetaKey_SessionProject, "")
	if name == "" {
		name = filepath.Base(c.Project)
	}
	ch, err := wstore.EnsureChannelAtPath(ctx, name, c.Project)
	if err != nil {
		return fmt.Errorf("the project's channel: %w", err)
	}
	workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, c.TabId)
	if err != nil {
		return fmt.Errorf("finding the workspace of tab %s: %w", c.TabId, err)
	}
	if workspaceId == "" {
		return fmt.Errorf("tab %s is in no workspace", c.TabId)
	}
	reportPath := filepath.Join(os.TempDir(), "builder-check-"+uuid.NewString()+".md")
	runId, err := launchBuilderCheck(ctx, orchestrate.JudgingSession{
		ChannelId: ch.OID, WorkspaceId: workspaceId,
		Role: jarvis.UsageRole_BuilderCheck, Label: "Builder check · " + c.Title, Tree: c.Project,
		Prompt: brainstormcheck.Prompt(c.Spec, reportPath),
		Route:  builderCheckRoute(ch, tab.Meta.GetString(waveobj.MetaKey_SessionAgent, "")),
	})
	if err != nil {
		return err
	}
	c.RunId, c.ChannelId = runId, ch.OID
	return setBuilderCheck(ctx, c.TabId, builderCheckReading, c.StartedTs, c.RunId, c.ChannelId, "")
}

// builderCheckRoute is the reviewer route of the run settings for ch, else the brainstorming agent's runtime when
// it can run a worker, else the default runtime, each with its default model when the setting names none (D3).
func builderCheckRoute(ch *waveobj.Channel, agent string) waveobj.RoutePin {
	profile := jarvis.ResolveProfile(jarvis.LoadGlobalProfile(), jarvis.OverrideFromMeta(ch))
	if r := profile.ReviewerRoute; r != nil && (r.Runtime != "" || r.Model != "") {
		return waveobj.RoutePin{Runtime: runroute.DefaultRuntime(r.Runtime), Model: r.Model}
	}
	if spec, ok := harness.Lookup(agent); ok && spec.RunWorkerCapable {
		return waveobj.RoutePin{Runtime: agent}
	}
	return waveobj.RoutePin{Runtime: runroute.DefaultRuntime("")}
}

// tickBuilderCheck judges c's run once and acts on the verdict. It reports whether the check is settled.
func tickBuilderCheck(ctx context.Context, c builderCheck, now int64) bool {
	run, err := readBuilderCheckRun(ctx, c.ChannelId, c.RunId)
	if err != nil {
		run = nil
	}
	lost := ""
	if run == nil || run.Status != jarvis.RunStatus_Done {
		lost, _ = orchestrate.JudgingSessionLost(ctx, c.ChannelId, c.RunId, c.StartedTs, now)
	}
	action := brainstormcheck.Decide(run, lost)
	switch action.Kind {
	case brainstormcheck.Deliver:
		path := brainstormcheck.ReportPath(c.File)
		if err := os.WriteFile(path, []byte(run.Report), 0o644); err != nil {
			failBuilderCheck(ctx, c, fmt.Sprintf("Arc could not write the builder's questions to %s: %v", path, err))
			return true
		}
		deliverAgentMessage(c.BlockId, brainstormcheck.Line(path))
		if err := setBuilderCheck(ctx, c.TabId, builderCheckAnswered, now, c.RunId, c.ChannelId, ""); err != nil {
			log.Printf("builder check: %v", err)
		}
		return true
	case brainstormcheck.Fail:
		if run != nil && run.Status != jarvis.RunStatus_Done {
			stopStageSession(*run)
		}
		failBuilderCheck(ctx, c, action.Reason)
		return true
	}
	return false
}

// ResumeBuilderChecks re-arms the watcher of every check that was reading when wavesrv stopped, and fails one
// whose reviewer never launched (D6). Called once at startup, after the store is up.
func ResumeBuilderChecks(ctx context.Context) {
	tabs, err := wstore.DBGetAllObjsByType[*waveobj.Tab](ctx, waveobj.OType_Tab)
	if err != nil {
		log.Printf("builder check: loading tabs: %v", err)
		return
	}
	for _, tab := range tabs {
		if tab.Meta.GetString(waveobj.MetaKey_BrainstormCheckState, "") != builderCheckReading {
			continue
		}
		c := builderCheck{
			TabId:     tab.OID,
			File:      tab.Meta.GetString(waveobj.MetaKey_SessionBrainstorm, ""),
			RunId:     tab.Meta.GetString(waveobj.MetaKey_BrainstormCheckRun, ""),
			ChannelId: tab.Meta.GetString(waveobj.MetaKey_BrainstormCheckChannel, ""),
			StartedTs: int64(tab.Meta.GetFloat(waveobj.MetaKey_BrainstormCheckTs, 0)),
		}
		if len(tab.BlockIds) > 0 {
			c.BlockId = tab.BlockIds[0]
		}
		switch {
		case c.RunId == "":
			failBuilderCheck(ctx, c, builderCheckRestartedReason)
		case c.File == "":
			// the brainstorm was closed meanwhile: its questions have nowhere to go
			failBuilderCheck(ctx, c, builderCheckDetachedReason)
		default:
			armBuilderCheck(c)
		}
	}
}
