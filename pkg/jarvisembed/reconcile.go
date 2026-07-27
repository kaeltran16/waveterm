// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// ReconcileStats summarizes a reconcile pass.
type ReconcileStats struct {
	Embedded int  // sections (re)embedded
	Pruned   int  // chunks deleted for removed/changed nodes
	Rebuilt  bool // full rebuild (model change)
}

// Reconcile brings the index up to date with the whole vault (always AllScope,
// so scope-narrow queries never prune out-of-scope chunks). Only nodes whose
// ContentHash changed since indexed hit the embedder. This one method is both
// the lazy path (called by Query) and the warm path (called at a commit
// boundary). No-op and no network on an unchanged vault.
func (ix *Index) Reconcile(ctx context.Context, v *wavevault.Vault) (ReconcileStats, error) {
	var st ReconcileStats
	if !ix.available {
		return st, ErrEmbeddingsDisabled
	}

	// Model-change rebuild.
	var storedModel string
	err := ix.db.QueryRowContext(ctx, `select model from meta limit 1`).Scan(&storedModel)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := ix.db.ExecContext(ctx, `insert into meta(model, dims) values (?, 0)`, ix.emb.Model()); err != nil {
			return st, err
		}
	case err != nil:
		return st, err
	case storedModel != ix.emb.Model():
		if err := ix.wipe(ctx); err != nil {
			return st, err
		}
		if _, err := ix.db.ExecContext(ctx, `insert into meta(model, dims) values (?, 0)`, ix.emb.Model()); err != nil {
			return st, err
		}
		ix.dims = 0
		st.Rebuilt = true
	}

	r := v.Retriever(wavevault.AllScope())
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		return st, err
	}

	live := map[string]bool{}
	var batch []pendingNode
	batchChunks, batchChars := 0, 0
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		n, err := ix.embedBatch(ctx, batch)
		st.Embedded += n
		batch, batchChunks, batchChars = nil, 0, 0
		return err
	}
	for _, n := range nodes {
		live[n.ID] = true
		var have string
		row := ix.db.QueryRowContext(ctx, `select content_hash from chunks where node_id = ? limit 1`, n.ID)
		if err := row.Scan(&have); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return st, err
		}
		if have == n.ContentHash {
			continue // unchanged
		}
		nwb, err := r.Read(n.ID)
		if err != nil {
			return st, err
		}
		p := newPendingNode(n, nwb.Body)
		// the batchChunks>0 guard keeps a single over-budget node from flushing an empty batch: it goes
		// out alone, which is exactly what every node did before batching
		if batchChunks > 0 && (batchChunks+len(p.texts) > embedBatchChunks || batchChars+p.chars > embedBatchChars) {
			if err := flush(); err != nil {
				return st, err
			}
		}
		batch = append(batch, p)
		batchChunks += len(p.texts)
		batchChars += p.chars
	}
	if err := flush(); err != nil {
		return st, err
	}

	// Prune nodes no longer present.
	pruned, err := ix.pruneMissing(ctx, live)
	if err != nil {
		return st, err
	}
	st.Pruned += pruned
	return st, nil
}

// Embed-request batching. Reconcile used to make one request per node, so a first build cost one
// network round-trip per note — measured at 5m17s for a 373-note vault, against the 90s budget
// jarvisproactive's detached dispatch eval allows. S3 could therefore never finish its own lazy build:
// each dispatch died partway and surfaced no card. Both bounds exist because providers cap a request on
// both axes; embedBatchChars is the binding one (an input tops out at maxEmbedChars, and 64 of those far
// exceeds what a single request may carry), while embedBatchChunks keeps one response a sane size.
const (
	embedBatchChunks = 64
	embedBatchChars  = 100000
)

// pendingNode is one node's chunked, embed-ready text, buffered until its batch flushes.
type pendingNode struct {
	node     wavevault.Node
	sections []Section
	texts    []string
	chars    int
}

func newPendingNode(n wavevault.Node, body string) pendingNode {
	sections := splitSections(body)
	texts := make([]string, len(sections))
	chars := 0
	for i, s := range sections {
		texts[i] = embedText(n.Frontmatter, s)
		chars += len(texts[i])
	}
	return pendingNode{node: n, sections: sections, texts: texts, chars: chars}
}

// embedBatch embeds every buffered node's sections in one request, then writes each node's rows in its
// own transaction. Per-node commits are deliberate and survive batching: a reconcile cancelled mid-build
// keeps every node it finished, and the next pass skips those on the content-hash check instead of
// re-paying for them. Returns the number of sections written.
func (ix *Index) embedBatch(ctx context.Context, batch []pendingNode) (int, error) {
	var texts []string
	for _, p := range batch {
		texts = append(texts, p.texts...)
	}
	if len(texts) == 0 {
		return 0, nil
	}
	vecs, err := ix.emb.Embed(ctx, texts)
	if err != nil {
		return 0, err
	}
	if len(vecs) == 0 {
		return 0, nil
	}
	if len(vecs) != len(texts) {
		return 0, fmt.Errorf("jarvisembed: embedder returned %d vectors for %d inputs", len(vecs), len(texts))
	}
	if ix.dims == 0 {
		ix.dims = len(vecs[0])
		if _, err := ix.db.ExecContext(ctx, `update meta set dims = ?`, ix.dims); err != nil {
			return 0, err
		}
	}
	if err := ix.ensureVecTable(ctx, ix.dims); err != nil {
		return 0, err
	}
	written, off := 0, 0
	for _, p := range batch {
		if err := ix.writeNode(ctx, p, vecs[off:off+len(p.texts)]); err != nil {
			return written, err
		}
		off += len(p.texts)
		written += len(p.texts)
	}
	return written, nil
}

// writeNode replaces one node's chunk + vector rows in a single transaction.
func (ix *Index) writeNode(ctx context.Context, p pendingNode, vecs [][]float32) error {
	tx, err := ix.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `delete from vec_chunks where rowid in (select rowid from chunks where node_id = ?)`, p.node.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `delete from chunks where node_id = ?`, p.node.ID); err != nil {
		return err
	}
	for i, s := range p.sections {
		res, err := tx.ExecContext(ctx,
			`insert into chunks(node_id, collection, section_idx, section_heading, section_text, content_hash) values (?,?,?,?,?,?)`,
			p.node.ID, p.node.Collection, s.Idx, s.Heading, s.Text, p.node.ContentHash)
		if err != nil {
			return err
		}
		rowid, _ := res.LastInsertId()
		if _, err := tx.ExecContext(ctx, `insert into vec_chunks(rowid, embedding, collection) values (?,?,?)`,
			rowid, encodeVec(vecs[i]), p.node.Collection); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (ix *Index) pruneMissing(ctx context.Context, live map[string]bool) (int, error) {
	rows, err := ix.db.QueryContext(ctx, `select distinct node_id from chunks`)
	if err != nil {
		return 0, err
	}
	var dead []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		if !live[id] {
			dead = append(dead, id)
		}
	}
	rows.Close()
	pruned := 0
	for _, id := range dead {
		res, err := ix.db.ExecContext(ctx, `delete from vec_chunks where rowid in (select rowid from chunks where node_id = ?)`, id)
		if err != nil {
			return pruned, err
		}
		if _, err := ix.db.ExecContext(ctx, `delete from chunks where node_id = ?`, id); err != nil {
			return pruned, err
		}
		if aff, _ := res.RowsAffected(); aff > 0 {
			pruned += int(aff)
		} else {
			pruned++
		}
	}
	return pruned, nil
}

func (ix *Index) wipe(ctx context.Context) error {
	for _, stmt := range []string{`drop table if exists vec_chunks`, `delete from chunks`, `delete from meta`, `delete from attrib_vectors`} {
		if _, err := ix.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// encodeVec serializes a float32 vector to the little-endian byte form sqlite-vec accepts.
func encodeVec(v []float32) []byte {
	b := make([]byte, 0, len(v)*4)
	for _, f := range v {
		bits := math.Float32bits(f)
		b = append(b, byte(bits), byte(bits>>8), byte(bits>>16), byte(bits>>24))
	}
	return b
}

// decodeVec is the inverse of encodeVec: little-endian float32 bytes -> vector.
func decodeVec(b []byte) []float32 {
	out := make([]float32, len(b)/4)
	for i := range out {
		bits := uint32(b[i*4]) | uint32(b[i*4+1])<<8 | uint32(b[i*4+2])<<16 | uint32(b[i*4+3])<<24
		out[i] = math.Float32frombits(bits)
	}
	return out
}

// Cosine is the cosine similarity of two equal-length vectors (0 on length
// mismatch or a zero vector). Higher = more similar.
func Cosine(a, b []float32) float32 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return float32(dot / (math.Sqrt(na) * math.Sqrt(nb)))
}
