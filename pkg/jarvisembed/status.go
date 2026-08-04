// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"database/sql"
	"errors"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// The index is a derived artifact keyed on two things: the embedding model it was written with, and the
// per-node content hash of the vault it was written from. When either key goes out of date a recall is not
// the recall the configuration promises — a model change wipes and rebuilds the whole vec0 table on the
// next query, a hash change re-embeds that node's chunks, and on a real corpus neither finishes inside a
// query's budget (see reconcile.go: a 373-note build measured 5m17s against a 90s dispatch budget). That
// is the degradation this read exists to make visible: every consumer degrades gracefully to keyword-level
// results, and nothing in the app can currently tell that apart from semantic recall working.
const (
	IndexState_OK    = "ok"
	IndexState_Off   = "off"
	IndexState_Stale = "stale"
)

// Reasons. An Off reason means recall is impossible right now (configuration, credentials, provider, or
// no corpus to search). A Stale reason means the index exists but does not match what a query needs.
const (
	IndexReason_Disabled      = "disabled"       // flag off, or base URL / model unset
	IndexReason_NoKey         = "no-key"         // the BYOK secret is absent
	IndexReason_ProviderError = "provider-error" // the last real provider call failed: configured but unreachable
	IndexReason_IndexError    = "index-error"    // the index db could not be opened or read
	IndexReason_VaultError    = "vault-error"    // the vault could not be read, so recall has no corpus
	IndexReason_ModelMismatch = "model-mismatch" // indexed under another model; the next query wipes and rebuilds
	IndexReason_NotBuilt      = "not-built"      // configured, the vault has nodes, nothing is indexed yet
	IndexReason_ContentDrift  = "content-drift"  // indexed content hashes no longer match the vault's
)

// IndexStatus is what the index can honestly say about itself. State is the three-way answer a consumer
// acts on; Reason and Detail are the diagnosis. The counts are reported so "stale" is legible as a
// magnitude — one edited note and a never-built index are both stale and are not the same problem.
type IndexStatus struct {
	State        string `json:"state"`
	Reason       string `json:"reason,omitempty"`
	Detail       string `json:"detail,omitempty"` // provider/index/vault error text, when there is one
	Enabled      bool   `json:"enabled"`          // config flag on and base URL + model set
	HasKey       bool   `json:"haskey"`           // the BYOK secret resolves
	Model        string `json:"model,omitempty"`  // the configured embedding model
	IndexedModel string `json:"indexedmodel,omitempty"`
	Dims         int    `json:"dims,omitempty"`
	IndexedNodes int    `json:"indexednodes"`
	VaultNodes   int    `json:"vaultnodes"`
	StaleNodes   int    `json:"stalenodes"` // vault nodes whose content hash is missing from or differs in the index
}

// Status answers whether semantic recall is actually working. Cheap by construction: two local SQL reads
// plus one vault graph load, no embedder call and no network, so it is safe on an RPC budget.
func Status(ctx context.Context) IndexStatus {
	baseURL, model, enabled := resolveConfig()
	st := IndexStatus{Model: model}
	if !enabled {
		st.State, st.Reason = IndexState_Off, IndexReason_Disabled
		return st
	}
	st.Enabled = true
	if _, ok := resolveKey(); !ok {
		st.State, st.Reason = IndexState_Off, IndexReason_NoKey
		return st
	}
	st.HasKey = true
	if perr, _ := lastProviderError(baseURL, model); perr != "" {
		st.State, st.Reason, st.Detail = IndexState_Off, IndexReason_ProviderError, perr
		return st
	}

	ix, err := OpenIndex(ctx)
	if err != nil {
		st.State, st.Reason, st.Detail = IndexState_Off, IndexReason_IndexError, err.Error()
		return st
	}
	defer ix.Close()
	if !ix.Available() {
		// configured and keyed, yet no embedder was built. Nothing more specific is known, so report the
		// state a caller must act on rather than inventing a cause.
		st.State, st.Reason = IndexState_Off, IndexReason_Disabled
		return st
	}
	indexed, indexedModel, dims, err := ix.indexedHashes(ctx)
	if err != nil {
		st.State, st.Reason, st.Detail = IndexState_Off, IndexReason_IndexError, err.Error()
		return st
	}
	st.IndexedModel, st.Dims, st.IndexedNodes = indexedModel, dims, len(indexed)

	// the vault is the other half of the hash check, and it is also recall's corpus: if it cannot be read,
	// recall cannot happen at all. jarvisproactive already refuses on the same condition (ReasonVaultError).
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		st.State, st.Reason, st.Detail = IndexState_Off, IndexReason_VaultError, err.Error()
		return st
	}
	nodes, err := v.Retriever(wavevault.AllScope()).Query(wavevault.Filter{})
	if err != nil {
		st.State, st.Reason, st.Detail = IndexState_Off, IndexReason_VaultError, err.Error()
		return st
	}
	st.VaultNodes = len(nodes)
	for _, n := range nodes {
		if indexed[n.ID] != n.ContentHash {
			st.StaleNodes++
		}
	}
	st.State, st.Reason = classifyIndexState(model, st.IndexedModel, st.IndexedNodes, st.VaultNodes, st.StaleNodes)
	return st
}

// classifyIndexState is the pure verdict over what the index and the vault already reported. Split out
// because it is the whole contract a consumer depends on, and it is the part worth pinning in a test.
// Model precedence first: a mismatched tag invalidates every hash comparison below it.
func classifyIndexState(configuredModel, indexedModel string, indexedNodes, vaultNodes, staleNodes int) (state, reason string) {
	if indexedModel != "" && indexedModel != configuredModel {
		return IndexState_Stale, IndexReason_ModelMismatch
	}
	switch {
	case vaultNodes == 0:
		return IndexState_OK, "" // an empty vault and an empty index agree; there is nothing to recall
	case indexedNodes == 0:
		return IndexState_Stale, IndexReason_NotBuilt
	case staleNodes > 0:
		return IndexState_Stale, IndexReason_ContentDrift
	}
	return IndexState_OK, ""
}

// indexedHashes reads the index's per-node content hash plus its model/dims tags in two queries, so a
// status read never costs a round trip per node. Every chunk of a node carries that node's hash
// (writeNode writes one hash across its sections), so distinct node_id + content_hash is one row per node.
func (ix *Index) indexedHashes(ctx context.Context) (map[string]string, string, int, error) {
	var indexedModel string
	var dims int
	err := ix.db.QueryRowContext(ctx, `select model, dims from meta limit 1`).Scan(&indexedModel, &dims)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, "", 0, err
	}
	rows, err := ix.db.QueryContext(ctx, `select distinct node_id, content_hash from chunks`)
	if err != nil {
		return nil, "", 0, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var nodeID, hash string
		if err := rows.Scan(&nodeID, &hash); err != nil {
			return nil, "", 0, err
		}
		out[nodeID] = hash
	}
	return out, indexedModel, dims, rows.Err()
}
