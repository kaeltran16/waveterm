// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The three reads that make the memory subsystem's own state answerable from outside it: whether semantic
// recall is working, why proactive recall has been silent, and where the last run left off. Each was
// already computed and persisted; none had a read path.

package wshserver

import (
	"context"
	"fmt"
	"log"
	"sort"
	"sync/atomic"

	"github.com/wavetermdev/waveterm/pkg/jarviscontinuity"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/jarvisproactive"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// refusal listing bounds. The default is what a diagnostic needs to show a pattern; the cap keeps a
// caller from turning an ambient read into a full history dump.
const (
	defaultRefusalLimit = 10
	maxRefusalLimit     = 50
)

func (ws *WshServer) GetEmbedIndexStatusCommand(ctx context.Context) (*wshrpc.EmbedIndexStatus, error) {
	st := jarvisembed.Status(ctx)
	return &wshrpc.EmbedIndexStatus{
		State:        st.State,
		Reason:       st.Reason,
		Detail:       st.Detail,
		Enabled:      st.Enabled,
		HasKey:       st.HasKey,
		Model:        st.Model,
		IndexedModel: st.IndexedModel,
		Dims:         st.Dims,
		IndexedNodes: st.IndexedNodes,
		VaultNodes:   st.VaultNodes,
		StaleNodes:   st.StaleNodes,
	}, nil
}

// reconcileRunning single-flights the catch-up. Two concurrent whole-vault rebuilds against one index db
// would race each other's writes, and the second press is not a user error — the work is already happening.
var reconcileRunning atomic.Bool

func tryStartReconcile() bool { return reconcileRunning.CompareAndSwap(false, true) }

func finishReconcile() { reconcileRunning.Store(false) }

// EmbedReconcileCommand dispatches the catch-up and returns immediately. It CANNOT do the work inline:
// wshutil.DefaultTimeoutMs is 5000 and binds the server-side context, while a 373-note build measured
// 5m17s (pkg/jarvisembed/status.go). The frontend learns it finished by re-reading GetEmbedIndexStatus,
// which it already polls — so there is no completion event to invent.
func (ws *WshServer) EmbedReconcileCommand(ctx context.Context) error {
	if !tryStartReconcile() {
		return nil
	}
	// detached: the handler returns in milliseconds and its ctx is cancelled with it, which would kill the
	// reconcile a moment after starting it
	bg := context.WithoutCancel(ctx)
	go func() {
		defer finishReconcile()
		ix, err := jarvisembed.OpenIndex(bg)
		if err != nil {
			log.Printf("[jarvispet] reconcile: open index: %v\n", err)
			return
		}
		defer ix.Close()
		v, err := wavevault.OpenVault(bg)
		if err != nil {
			log.Printf("[jarvispet] reconcile: open vault: %v\n", err)
			return
		}
		st, err := ix.Reconcile(bg, v)
		if err != nil {
			log.Printf("[jarvispet] reconcile: %v\n", err)
			return
		}
		log.Printf("[jarvispet] reconcile: embedded=%d pruned=%d rebuilt=%v\n", st.Embedded, st.Pruned, st.Rebuilt)
	}()
	return nil
}

func (ws *WshServer) ListProactiveRefusalsCommand(ctx context.Context, data wshrpc.CommandListProactiveRefusalsData) (*wshrpc.CommandListProactiveRefusalsRtnData, error) {
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, fmt.Errorf("loading runs: %w", err)
	}
	out := buildProactiveRefusals(runs, data.Limit)
	return &out, nil
}

// buildProactiveRefusals is the pure core: every run carrying a "none" verdict, newest first, truncated to
// the limit. Total counts every refusal on record — all of history, so truncation cannot hide the scale;
// each row keeps its own timestamp for a caller that wants a window. Pending and hit verdicts are not
// refusals, and a run that never evaluated has no record at all and is silently absent.
func buildProactiveRefusals(runs []*waveobj.Run, limit int) wshrpc.CommandListProactiveRefusalsRtnData {
	if limit <= 0 {
		limit = defaultRefusalLimit
	}
	if limit > maxRefusalLimit {
		limit = maxRefusalLimit
	}
	out := wshrpc.CommandListProactiveRefusalsRtnData{Refusals: []wshrpc.ProactiveRefusal{}}
	for _, run := range runs {
		sug, ok := jarvisproactive.ReadSuggestion(run)
		if !ok || sug.Status != jarvisproactive.StatusNone {
			continue
		}
		out.Refusals = append(out.Refusals, wshrpc.ProactiveRefusal{
			RunORef:    waveobj.MakeORef(waveobj.OType_Run, run.OID).String(),
			ChannelOid: run.ChannelOID,
			Goal:       run.Goal,
			Reason:     sug.Reason,
			Ts:         run.CreatedTs,
		})
	}
	out.Total = len(out.Refusals)
	sort.SliceStable(out.Refusals, func(i, j int) bool { return out.Refusals[i].Ts > out.Refusals[j].Ts })
	if len(out.Refusals) > limit {
		out.Refusals = out.Refusals[:limit]
	}
	return out
}

func (ws *WshServer) GetLatestResumeCommand(ctx context.Context) (*wshrpc.CommandGetLatestResumeRtnData, error) {
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, fmt.Errorf("loading runs: %w", err)
	}
	return buildLatestResume(runs), nil
}

// buildLatestResume picks the single newest narrative. Ordering is by the narrative's own Updated stamp
// (the dossier's, written at the boundary) and not by the run's, because a run that reached rest twice
// carries only its latest text — the run's createdts would rank a stale narrative above a fresh one.
// Runs with no stamp fall back to their completion, then their creation, so an early narrative written
// before Updated was populated still ranks rather than vanishing.
//
// Always returns non-nil: an empty result with Card nil is "nothing to resume", which is a real answer and
// not an error. The scan reads every run row — the same read ResolveSpaceScope and ResolveDossierEdges
// already make — but the response is one card, so the cost is bounded where the caller can feel it.
func buildLatestResume(runs []*waveobj.Run) *wshrpc.CommandGetLatestResumeRtnData {
	out := &wshrpc.CommandGetLatestResumeRtnData{}
	var bestRank int64
	for _, run := range runs {
		card, ok := jarviscontinuity.ReadResumeCard(run)
		if !ok {
			continue
		}
		rank := resumeRank(card, run)
		if out.Card != nil && rank <= bestRank {
			continue
		}
		bestRank = rank
		out.Card = &wshrpc.ResumeCardData{
			TaskId:  card.TaskID,
			Summary: card.Summary,
			Status:  card.Status,
			Updated: card.Updated,
		}
		out.RunORef = waveobj.MakeORef(waveobj.OType_Run, run.OID).String()
		out.ChannelOid = run.ChannelOID
		out.RunStatus = run.Status
		out.RunGoal = run.Goal
	}
	return out
}

// resumeRank is the recency key. All three sources are Unix millis (jarvisdossier stamps `updated` with
// UnixMilli; wstore stamps run timestamps the same way), so mixing them in one comparison is sound.
func resumeRank(card jarviscontinuity.ResumeCard, run *waveobj.Run) int64 {
	if card.Updated > 0 {
		return card.Updated
	}
	if run.CompletedTs > 0 {
		return run.CompletedTs
	}
	return run.CreatedTs
}
