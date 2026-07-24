// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisdossier

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// Decision is the typed projection of one decision record. Rationale is the human-owned prose; every
// other field is machine-owned. Hash is the baseHash for a later SupersedeDecision.
type Decision struct {
	ID         string
	Created    int64
	Actor      string
	Provenance string
	Status     string
	Links      []string
	Rationale  string
	Hash       string
}

// DecisionFacts are the deterministic inputs code captures when a decision is submitted or a worker
// reports one. TaskID is the dossier this decision belongs to; it is auto-added to the links block
// and appended to the dossier's refs. Rationale is a seed draft (may be empty); the model/human owns
// the final prose. Summary feeds the filename slug only.
type DecisionFacts struct {
	TaskID     string
	Actor      string
	Provenance string
	Links      []string
	Rationale  string
	Summary    string
}

// newDecisionID mints an opaque stable id "dec-<8hex>". Callers link by this id, never the filename.
func newDecisionID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return "dec-" + hex.EncodeToString(b[:])
}

// AppendDecision creates a new immutable decision file in decisions/ (machine-authored) and links its
// id into the owning dossier's refs block. Append-only: it never rewrites an existing decision. It
// returns the decision id even if the dossier link step fails, so the record is never lost — the
// caller can retry the link. It reads the dossier through a fresh full-scope retriever to obtain the
// current baseHash (appends are coarse and rare, so a scan is acceptable).
func AppendDecision(v *wavevault.Vault, f DecisionFacts) (string, error) {
	id := newDecisionID()
	now := nowFn()
	date := time.UnixMilli(now).UTC().Format("2006-01-02")
	filename := date + "-" + boundedSlug(f.Summary, id) + ".md"
	links := append([]string{f.TaskID}, f.Links...)
	if _, err := v.Create("decisions", filename, renderDecision(id, now, f, links)); err != nil {
		return "", err
	}
	r := v.Retriever(wavevault.AllScope())
	d, err := LoadDossier(r, f.TaskID)
	if err != nil {
		return id, fmt.Errorf("jarvisdossier: decision %s created but dossier %s not found to link: %w", id, f.TaskID, err)
	}
	if _, err := SetRefs(v, f.TaskID, append(d.Refs, id), d.Hash); err != nil {
		return id, fmt.Errorf("jarvisdossier: decision %s created but linking to %s failed: %w", id, f.TaskID, err)
	}
	return id, nil
}

func renderDecision(id string, now int64, f DecisionFacts, links []string) string {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("id: " + id + "\n")
	b.WriteString("created: " + strconv.FormatInt(now, 10) + "\n")
	b.WriteString("actor: " + yamlScalar(f.Actor) + "\n")
	b.WriteString("provenance: " + yamlScalar(f.Provenance) + "\n")
	b.WriteString("status: active\n")
	b.WriteString("---\n")
	b.WriteString("<!-- jarvis:begin links -->\n" + renderRefs(links) + "\n<!-- jarvis:end links -->\n\n")
	b.WriteString(f.Rationale + "\n")
	return b.String()
}

// DecisionSpec is the region-ownership contract for a decision file: machine frontmatter keys plus
// the machine links block. The rationale body is human-owned (a human edit locks the seed draft).
func DecisionSpec() wavevault.RegionSpec {
	return wavevault.RegionSpec{
		MachineKeys: []string{"id", "created", "actor", "provenance", "status"},
		Blocks:      []string{"links"},
	}
}

// LoadDecision reads a decision by id and projects it, tolerant of missing fields. Rationale is the
// body with the machine links block stripped.
func LoadDecision(r *wavevault.Retriever, id string) (*Decision, error) {
	nb, err := r.Read(id)
	if err != nil {
		return nil, err
	}
	fm := nb.Node.Frontmatter
	return &Decision{
		ID:         nb.Node.ID,
		Created:    fmInt(fm, "created"),
		Actor:      fmString(fm, "actor"),
		Provenance: fmString(fm, "provenance"),
		Status:     fmString(fm, "status"),
		Links:      parseLinks(extractBlock(nb.Body, "links")),
		Rationale:  strings.TrimSpace(stripBlocks(nb.Body, "links")),
		Hash:       nb.Node.ContentHash,
	}, nil
}

// SupersedeDecision mutates only the decision's status (active | superseded | reverted) — the single
// case B rewrites an existing record. The diff-validator guarantees the human rationale is untouched.
func SupersedeDecision(v *wavevault.Vault, decID, status, baseHash string) (*wavevault.WriteResult, error) {
	return v.Write(decID, DecisionSpec(), []wavevault.RegionEdit{
		{Kind: wavevault.FrontmatterKey, Name: "status", Value: status},
	}, baseHash)
}
