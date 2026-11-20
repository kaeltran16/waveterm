// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"slices"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/agentdocs"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// maxAgentTranscripts caps a block's agent:transcripts; the oldest drops first.
const maxAgentTranscripts = 32

type agentDocsEntry struct {
	key  string
	docs []agentdocs.Doc
}

// one entry per transcript path, rebuilt only when it or a subagent transcript has changed, so the cockpit
// can ask on every click
var agentDocsCache = struct {
	sync.Mutex
	m map[string]agentDocsEntry
}{m: map[string]agentDocsEntry{}}

func (ws *WshServer) AgentDocsCommand(ctx context.Context, data wshrpc.CommandAgentDocsData) (*wshrpc.CommandAgentDocsRtnData, error) {
	var transcripts []string
	if data.BlockId != "" {
		block, err := wstore.DBGet[*waveobj.Block](ctx, data.BlockId)
		if err != nil {
			return nil, fmt.Errorf("reading block %s: %w", data.BlockId, err)
		}
		if block != nil {
			transcripts = block.Meta.GetStringList(waveobj.MetaKey_AgentTranscripts)
		}
	}
	if data.TranscriptPath != "" && !slices.Contains(transcripts, data.TranscriptPath) {
		transcripts = append(transcripts, data.TranscriptPath)
	}
	lists := make([][]agentdocs.Doc, 0, len(transcripts))
	for _, p := range transcripts {
		docs, err := transcriptDocs(p)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			// one unreadable transcript must not hide the docs the others list
			log.Printf("agentdocs: transcript=%q err=%v", p, err)
			continue
		}
		lists = append(lists, docs)
	}
	merged := agentdocs.Merge(lists...)
	rtn := &wshrpc.CommandAgentDocsRtnData{Docs: make([]wshrpc.AgentDoc, 0, len(merged))}
	for _, d := range merged {
		_, err := os.Stat(d.Path)
		rtn.Docs = append(rtn.Docs, wshrpc.AgentDoc{Path: d.Path, Ts: d.Ts, Verb: d.Verb, Gone: errors.Is(err, os.ErrNotExist)})
	}
	return rtn, nil
}

func transcriptDocs(transcript string) ([]agentdocs.Doc, error) {
	key, err := agentEditsKey("", transcript)
	if err != nil {
		return nil, err
	}
	agentDocsCache.Lock()
	e, ok := agentDocsCache.m[transcript]
	agentDocsCache.Unlock()
	if ok && e.key == key {
		return e.docs, nil
	}
	docs, err := agentdocs.Read(transcript)
	if err != nil {
		return nil, err
	}
	agentDocsCache.Lock()
	agentDocsCache.m[transcript] = agentDocsEntry{key: key, docs: docs}
	agentDocsCache.Unlock()
	return docs, nil
}

// lineageLastPath is the transcript path last recorded per block, so a status event repeating it skips the read.
var lineageLastPath sync.Map

// noteTranscriptLineage appends an agent status event's transcript path to its block's agent:transcripts when
// the list lacks it: agent:transcriptpath is overwritten on /clear and on resume, and the Docs list reads them all.
func noteTranscriptLineage(ctx context.Context, ev *wps.WaveEvent) {
	var data baseds.AgentStatusData
	if utilfn.ReUnmarshal(&data, ev.Data) != nil || data.TranscriptPath == "" {
		return
	}
	oref, err := waveobj.ParseORef(data.ORef)
	if err != nil {
		return
	}
	blockId := oref.OID
	switch oref.OType {
	case waveobj.OType_Block:
	case waveobj.OType_Tab:
		blockId = tabAgentBlock(ctx, oref.OID)
	default:
		return
	}
	if blockId == "" {
		return
	}
	if last, ok := lineageLastPath.Load(blockId); ok && last == data.TranscriptPath {
		return
	}
	changed, err := recordTranscript(ctx, blockId, data.TranscriptPath)
	if err != nil {
		log.Printf("agentdocs: recording transcript %q on block %s: %v", data.TranscriptPath, blockId, err)
		return
	}
	lineageLastPath.Store(blockId, data.TranscriptPath)
	if changed {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Block, blockId))
	}
}

// recordTranscript reads and writes the list in one transaction, so two new paths landing at once both stay.
func recordTranscript(ctx context.Context, blockId, transcript string) (bool, error) {
	changed := false
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		block, err := wstore.DBGet[*waveobj.Block](tx.Context(), blockId)
		if err != nil || block == nil {
			return err
		}
		list := block.Meta.GetStringList(waveobj.MetaKey_AgentTranscripts)
		if slices.Contains(list, transcript) {
			return nil
		}
		list = append(list, transcript)
		if len(list) > maxAgentTranscripts {
			list = list[len(list)-maxAgentTranscripts:]
		}
		stored := make([]any, len(list))
		for i, p := range list {
			stored[i] = p
		}
		if block.Meta == nil {
			block.Meta = waveobj.MetaMapType{}
		}
		block.Meta[waveobj.MetaKey_AgentTranscripts] = stored
		changed = true
		return wstore.DBUpdate(tx.Context(), block)
	})
	return changed, err
}
