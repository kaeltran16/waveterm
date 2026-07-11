// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// Hook-reliability pilot (shadow, log-only). Polls the OS for live claude agents, derives each one's
// state from files + process liveness (the observer), snapshots the hook channel's state for the same
// block, and appends a three-way comparison record per sweep. It NEVER publishes to the roster. See
// docs/superpowers/specs/2026-07-12-hook-reliability-pilot-design.md.

var (
	observeInterval    int
	observeOut         string
	observeHookLog     string
	observeQuietWindow int
	observeTailLines   int
	observeOnce        bool
)

var agentObserveShadowCmd = &cobra.Command{
	Use:                   "agent-observe-shadow",
	Short:                 "Pilot: shadow-observe agent state from files+process and log a three-way comparison vs the hook channel",
	Args:                  cobra.NoArgs,
	RunE:                  agentObserveShadowRun,
	Hidden:                true,
	DisableFlagsInUseLine: true,
}

func init() {
	rootCmd.AddCommand(agentObserveShadowCmd)
	home, _ := os.UserHomeDir()
	agentObserveShadowCmd.Flags().IntVar(&observeInterval, "interval", 5, "poll interval in seconds")
	agentObserveShadowCmd.Flags().StringVar(&observeOut, "out", filepath.Join(home, ".claude", "arc-observe-shadow.log"), "path to append the three-way comparison JSONL")
	agentObserveShadowCmd.Flags().StringVar(&observeHookLog, "hook-log", filepath.Join(home, ".claude", "arc-hook-debug.log"), "path to the hook debug log (needs WAVETERM_HOOK_DEBUG=1 on the agents)")
	agentObserveShadowCmd.Flags().IntVar(&observeQuietWindow, "quiet-window", 20, "idle hysteresis: seconds of transcript quiescence before a finished turn counts as idle")
	agentObserveShadowCmd.Flags().IntVar(&observeTailLines, "tail-lines", 60, "transcript tail lines to derive state from")
	agentObserveShadowCmd.Flags().BoolVar(&observeOnce, "once", false, "run a single sweep and exit (for verification)")
}

func agentObserveShadowRun(cmd *cobra.Command, args []string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("resolving home: %w", err)
	}
	projectsRoot := filepath.Join(home, ".claude", "projects")
	quiet := time.Duration(observeQuietWindow) * time.Second

	// Best-effort RPC so we can read the retained agent:status (the roster track). Requires the shadow
	// to run inside a Wave block (WAVETERM_BLOCKID + JWT in env). Absent RPC degrades to hook+observer
	// only; the report then marks roster coverage NOT MEASURED.
	rpcAvailable := false
	if jwt := os.Getenv(wshutil.WaveJwtTokenVarName); jwt != "" {
		if setupRpcClient(nil, jwt) == nil {
			rpcAvailable = true
		}
	}
	if !rpcAvailable {
		fmt.Fprintln(os.Stderr, "agent-observe-shadow: no RPC (run inside a Wave block for the roster track); continuing with hook+observer only")
	}

	if err := os.MkdirAll(filepath.Dir(observeOut), 0o755); err != nil {
		return fmt.Errorf("creating out dir: %w", err)
	}
	out, err := os.OpenFile(observeOut, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("opening out log: %w", err)
	}
	defer out.Close()

	write := func(rec agentobserve.ShadowRecord) {
		b, mErr := json.Marshal(rec)
		if mErr != nil {
			return
		}
		_, _ = out.Write(append(b, '\n'))
	}

	// readRoster returns the retained agent:status state the cockpit currently shows for a block, and
	// whether the read succeeded. It reflects hook + backend backstops — the real user-facing surface.
	readRoster := func(blockUUID string) agentobserve.RosterProbe {
		if !rpcAvailable || blockUUID == "" {
			return agentobserve.RosterProbe{}
		}
		scope := "block:" + agentobserve.NormalizeBlockID(blockUUID)
		events, err := wshclient.EventReadHistoryCommand(RpcClient, wshrpc.CommandEventReadHistoryData{
			Event: wps.Event_AgentStatus, Scope: scope, MaxItems: 50,
		}, &wshrpc.RpcOpts{Timeout: 2000})
		if err != nil {
			return agentobserve.RosterProbe{}
		}
		state := ""
		for _, ev := range events { // ascending; keep the last event carrying a state
			b, mErr := json.Marshal(ev.Data)
			if mErr != nil {
				continue
			}
			var data baseds.AgentStatusData
			if json.Unmarshal(b, &data) == nil && data.State != "" {
				state = data.State
			}
		}
		return agentobserve.RosterProbe{State: state, Checked: true}
	}

	lastSeen := map[int32]agentobserve.ShadowRecord{}

	sweep := func() {
		now := time.Now()
		procs, pErr := agentobserve.EnumerateAgents()
		if pErr != nil {
			fmt.Fprintf(os.Stderr, "enumerate agents: %v\n", pErr)
			return
		}
		hooks := map[string]agentobserve.HookState{}
		if content, rErr := os.ReadFile(observeHookLog); rErr == nil {
			hooks = agentobserve.ParseHookLog(string(content))
		}

		present := map[int32]bool{}
		for _, p := range procs {
			present[p.Pid] = true
			res := agentobserve.Resolve(projectsRoot, p.Cwd, p.CreateMs)
			var tail agentobserve.TailResult
			if res.Path != "" {
				tail, _ = agentobserve.ReadTail(res.Path, observeTailLines)
			}
			rec := agentobserve.BuildRecord(p, res, tail, hooks[agentobserve.NormalizeBlockID(p.BlockID)], readRoster(p.BlockID), now, quiet)
			write(rec)
			lastSeen[p.Pid] = rec
		}
		// emit a `gone` record the first sweep a previously-seen process is absent: the observer's
		// liveness floor makes it idle immediately, so this timestamps exit for the stale-working metric.
		for pid, prev := range lastSeen {
			if present[pid] {
				continue
			}
			gone := prev
			gone.Ts = now.UnixMilli()
			gone.Event = agentobserve.EventGone
			gone.ObserverState = "idle"
			gone.HookState = hooks[agentobserve.NormalizeBlockID(prev.BlockID)].LastState
			gone.HookCount = hooks[agentobserve.NormalizeBlockID(prev.BlockID)].Count
			roster := readRoster(prev.BlockID) // roster's own stale-working: is the cockpit still showing this exited agent?
			gone.RosterState = roster.State
			gone.RosterChecked = roster.Checked
			write(gone)
			delete(lastSeen, pid)
		}
	}

	if observeOnce {
		sweep()
		return nil
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	fmt.Fprintf(os.Stderr, "agent-observe-shadow: polling every %ds -> %s (ctrl-c to stop)\n", observeInterval, observeOut)
	ticker := time.NewTicker(time.Duration(observeInterval) * time.Second)
	defer ticker.Stop()
	sweep() // immediate first sweep
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			sweep()
		}
	}
}
