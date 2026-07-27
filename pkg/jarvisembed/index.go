// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	sqlite_vec "github.com/asg017/sqlite-vec-go-bindings/cgo"
	_ "github.com/mattn/go-sqlite3"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// ErrEmbeddingsDisabled is the typed graceful-degradation signal: returned when
// embeddings are off/misconfigured. Consumers fall back to L1/L2 (invariant 11).
var ErrEmbeddingsDisabled = errors.New("jarvisembed: embeddings disabled")

func init() { sqlite_vec.Auto() }

// ScoredChunk is one KNN hit: the source node/section plus a grounding snippet
// and a cosine similarity score (higher = closer).
type ScoredChunk struct {
	NodeID         string
	Collection     string
	SectionHeading string
	SectionIdx     int
	Snippet        string
	Score          float32
}

type Index struct {
	db        *sql.DB
	emb       Embedder
	available bool
	dims      int // 0 until learned from the first embedding
}

func indexDBPath() string {
	return filepath.Join(wavebase.GetWaveDataDir(), "jarvis", "index.db")
}

// OpenIndex opens (or creates) the derived-layer index. If embeddings are not
// fully configured it returns an unavailable handle that does no DB or network
// work; Query on it yields ErrEmbeddingsDisabled.
func OpenIndex(ctx context.Context) (*Index, error) {
	emb := embedderForTest()
	if emb == nil {
		var ok bool
		emb, ok = newConfiguredEmbedder()
		if !ok {
			return &Index{available: false}, nil
		}
	}
	return openIndexAt(ctx, indexDBPath(), emb)
}

// OpenIndexAtForTest opens an index at an explicit path with an explicit
// embedder. A nil embedder yields an unavailable index.
func OpenIndexAtForTest(ctx context.Context, dbPath string, emb Embedder) (*Index, error) {
	if emb == nil {
		return &Index{available: false}, nil
	}
	return openIndexAt(ctx, dbPath, emb)
}

func openIndexAt(ctx context.Context, dbPath string, emb Embedder) (*Index, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, err
	}
	ix := &Index{db: db, emb: emb, available: true}
	if err := ix.ensureBaseSchema(ctx); err != nil {
		db.Close()
		return nil, err
	}
	if err := ix.db.QueryRow(`select dims from meta limit 1`).Scan(&ix.dims); err != nil && !errors.Is(err, sql.ErrNoRows) {
		db.Close()
		return nil, err
	}
	return ix, nil
}

func (ix *Index) Available() bool { return ix != nil && ix.available }

func (ix *Index) Close() error {
	if ix == nil || ix.db == nil {
		return nil
	}
	return ix.db.Close()
}

func (ix *Index) ensureBaseSchema(ctx context.Context) error {
	_, err := ix.db.ExecContext(ctx, `
create table if not exists meta (model text, dims integer);
create table if not exists chunks (
	rowid integer primary key,
	node_id text not null,
	collection text not null,
	section_idx integer not null,
	section_heading text,
	section_text text,
	content_hash text not null
);
create index if not exists chunks_node on chunks(node_id);
create table if not exists attrib_vectors (
	key text primary key,
	content_hash text not null,
	model text not null,
	vec blob not null
);
`)
	return err
}

// ensureVecTable creates the vec0 virtual table at the given dims once dims are
// known (from the first embedding). No-op if already present.
func (ix *Index) ensureVecTable(ctx context.Context, dims int) error {
	_, err := ix.db.ExecContext(ctx, fmt.Sprintf(
		`create virtual table if not exists vec_chunks using vec0(embedding float[%d] distance_metric=cosine, collection text)`, dims))
	return err
}

// Query embeds queryText and returns the top-k nearest section chunks whose
// collection is within scope (the physical boundary — a WorkerScope query can
// never return a tasks/ chunk). It reconciles lazily first (invariant 1).
func (ix *Index) Query(ctx context.Context, v *wavevault.Vault, queryText string, k int, scope wavevault.Scope) ([]ScoredChunk, error) {
	if !ix.Available() {
		return nil, ErrEmbeddingsDisabled
	}
	if _, err := ix.Reconcile(ctx, v); err != nil {
		return nil, err
	}
	vecs, err := ix.emb.Embed(ctx, []string{queryText})
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 || ix.dims == 0 {
		return nil, nil // nothing indexed yet
	}
	colls := scope.Collections
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(colls)), ",")
	args := []any{encodeVec(vecs[0]), k}
	for _, c := range colls {
		args = append(args, c)
	}
	sqlStr := fmt.Sprintf(`
select c.node_id, c.collection, c.section_heading, c.section_idx, c.section_text, vc.distance
from vec_chunks vc
join chunks c on c.rowid = vc.rowid
where vc.embedding match ? and vc.k = ? and vc.collection in (%s)
order by vc.distance`, placeholders)
	rows, err := ix.db.QueryContext(ctx, sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ScoredChunk
	for rows.Next() {
		var sc ScoredChunk
		var dist float64
		var text string
		if err := rows.Scan(&sc.NodeID, &sc.Collection, &sc.SectionHeading, &sc.SectionIdx, &text, &dist); err != nil {
			return nil, err
		}
		sc.Snippet = truncate(text, 240)
		sc.Score = float32(1 - dist) // cosine distance -> similarity
		out = append(out, sc)
	}
	return out, rows.Err()
}

// Embed exposes the configured embedder for consumers (S2) that need raw
// vectors outside the vault chunk index. Unavailable => ErrEmbeddingsDisabled.
func (ix *Index) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if !ix.Available() {
		return nil, ErrEmbeddingsDisabled
	}
	return ix.emb.Embed(ctx, texts)
}

// EmbedCached returns the vector for text, cached by key. A stored row is reused
// only when its content_hash and model both match the current embedder; otherwise
// the text is (re-)embedded and the row replaced. This lets S2 embed a run/dossier
// fingerprint once, not per read. Unavailable => ErrEmbeddingsDisabled.
func (ix *Index) EmbedCached(ctx context.Context, key, contentHash, text string) ([]float32, error) {
	if !ix.Available() {
		return nil, ErrEmbeddingsDisabled
	}
	var blob []byte
	var storedHash, storedModel string
	err := ix.db.QueryRowContext(ctx, `select vec, content_hash, model from attrib_vectors where key = ?`, key).
		Scan(&blob, &storedHash, &storedModel)
	switch {
	case err == nil && storedHash == contentHash && storedModel == ix.emb.Model():
		return decodeVec(blob), nil
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return nil, err
	}
	vecs, err := ix.emb.Embed(ctx, []string{text})
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 {
		return nil, nil
	}
	if _, err := ix.db.ExecContext(ctx,
		`insert or replace into attrib_vectors(key, content_hash, model, vec) values (?,?,?,?)`,
		key, contentHash, ix.emb.Model(), encodeVec(vecs[0])); err != nil {
		return nil, err
	}
	return vecs[0], nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
