// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Dedup: surface semantic near-duplicate notes for human-confirmed merge. Flag-only (never auto-merged
// or archived) because exact-content dups are already blocked at write time (existingHashes) and
// judgment-heavy near-dups are too risky to auto-merge. One LLM cluster call per project, gated by a
// content fingerprint persisted across restarts; every proposed cluster is then verified against the
// full note bodies before anything is flagged — a single cheap pass over one-line summaries
// over-clusters distinct notes (observed 2026-08-13: 53 false "duplicate" flags from one sweep, and
// again 2026-08-14: 54 more in one sweep). Flagging is capped per pass and clusters verify in small
// groups so one run cannot mass-stamp the queue. Already-flagged notes are excluded from the corpus so
// a wrong flag can't breed more. See
// docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memgarden

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

const dedupPrompt = "You are finding semantic near-duplicate project memory notes. Input: a list of " +
	"notes as `slug: first line`. Group notes that say essentially the same thing (near-duplicates), " +
	`ignoring notes that are merely related. Output ONLY JSON: {"clusters": [["slugA","slugB"], ...]}. ` +
	"Only include clusters of 2+ genuinely redundant notes. If none, return {\"clusters\": []}."

// verifyPrompt is the per-group second pass: the full note bodies, so the model judges actual content
// rather than truncated summaries. A "same" verdict is required before any flag is stamped.
const verifyPrompt = "You are checking whether memory notes are near-duplicates: they make essentially " +
	"the same point, so keeping both would be redundant. Input: 2+ notes separated by --- lines, each " +
	`headed "--- NOTE: <id> ---". Output ONLY JSON: {"same": bool, "reason": string}. ` +
	"Set same=true only if the notes are genuinely redundant restatements. Notes that are merely " +
	"related, or cover different aspects of the same topic, are same=false."

// verifyBodyMax caps each note's body in the verification corpus; the opening carries the point.
const verifyBodyMax = 1200

// maxVerifyGroup caps each verification call's member count. A 55-member cluster verified as one
// wall of look-alike text passes trivially (observed 2026-08-14); small groups force pairwise
// judgment. The cluster's canonical note heads every group.
const maxVerifyGroup = 4

// maxFlagsPerDedupPass caps duplicate flags per scope per pass. A single sweep must not be able to
// mass-stamp the cleanup queue; unprocessed clusters wait for a later pass (the fingerprint gate
// means that happens only when the note set actually changes).
const maxFlagsPerDedupPass = 5

// parseClusters extracts {"clusters":[[...],...]} from an LLM response. Fail-safe: empty on any problem.
func parseClusters(raw string) [][]string {
	i := strings.IndexByte(raw, '{')
	j := strings.LastIndexByte(raw, '}')
	if i < 0 || j <= i {
		return nil
	}
	var v struct {
		Clusters [][]string `json:"clusters"`
	}
	if json.Unmarshal([]byte(raw[i:j+1]), &v) != nil {
		return nil
	}
	return v.Clusters
}

// dedupCorpus renders `slug: first line` for each note.
func dedupCorpus(notes []memvault.NoteWithBody) string {
	var b strings.Builder
	for _, n := range notes {
		fmt.Fprintf(&b, "%s: %s\n", n.Note.ID, firstLine(n.Body))
	}
	return b.String()
}

// firstLine is the first non-empty trimmed line of a body.
func firstLine(body string) string {
	for _, l := range strings.Split(body, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			return t
		}
	}
	return ""
}

// noteSetFingerprint hashes the sorted (id:bodyhash) set so dedup re-runs only when a note is added,
// removed, or its body changes. Content-based rather than mtime-based on purpose: a gardener_flag
// stamp rewrites only the frontmatter, so flagging must not re-arm the next sweep — an mtime
// fingerprint re-ran dedup after every flag batch and stamped 54 more in one sweep (observed
// 2026-08-14). Computed over ALL notes (flagged or not): a flag clearing via expiry is also invisible
// to the fingerprint, so decayed flags do not immediately re-flag.
func noteSetFingerprint(notes []memvault.NoteWithBody) string {
	parts := make([]string, 0, len(notes))
	for _, n := range notes {
		h := sha256.Sum256([]byte(n.Body))
		parts = append(parts, fmt.Sprintf("%s:%x", n.Note.ID, h[:8]))
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:])
}

// verifyCorpus renders each group member's full (capped) body for the verification call.
func verifyCorpus(members []string, byID map[string]memvault.NoteWithBody) string {
	var b strings.Builder
	for _, id := range members {
		b.WriteString("--- NOTE: " + id + " ---\n")
		b.WriteString(truncate(byID[id].Body, verifyBodyMax))
		b.WriteString("\n")
	}
	return b.String()
}

// parseSameVerdict extracts {"same": bool} from an LLM response. Fail-safe: false on any problem, so
// a note is never flagged on garbage output.
func parseSameVerdict(raw string) bool {
	i := strings.IndexByte(raw, '{')
	j := strings.LastIndexByte(raw, '}')
	if i < 0 || j <= i {
		return false
	}
	var v struct {
		Same bool `json:"same"`
	}
	if json.Unmarshal([]byte(raw[i:j+1]), &v) != nil {
		return false
	}
	return v.Same
}

// splitCluster chunks a cluster into verification groups of at most maxVerifyGroup members, each
// headed by the cluster's canonical note (the first slug). Clusters at or under the cap pass through
// whole.
func splitCluster(members []string) [][]string {
	if len(members) <= maxVerifyGroup {
		return [][]string{members}
	}
	var out [][]string
	rest := members[1:]
	for len(rest) > 0 {
		n := maxVerifyGroup - 1
		if len(rest) < n {
			n = len(rest)
		}
		group := make([]string, 0, n+1)
		group = append(group, members[0])
		group = append(group, rest[:n]...)
		out = append(out, group)
		rest = rest[n:]
	}
	return out
}

// checkDedup flags every non-canonical note in each near-dup cluster (the first slug is canonical),
// capped per pass. Already-flagged notes are excluded from the corpus — they are already surfaced,
// and re-clustering them only breeds more flags. Each proposed cluster must survive a verification
// pass (full bodies, "same" verdict) before anything is flagged; an unverified or rejected cluster is
// dropped. Gated by the persisted content fingerprint, so neither a flag batch nor a server restart
// re-arms the next pass.
func (g *gardener) checkDedup(hubDir string, notes []memvault.NoteWithBody) {
	active := make([]memvault.NoteWithBody, 0, len(notes))
	for _, n := range notes {
		if n.Note.GardenerFlag == "" {
			active = append(active, n)
		}
	}
	if len(active) < 2 {
		return
	}
	st := g.loadState()
	fp := noteSetFingerprint(notes)
	if st.DedupFP[hubDir] == fp {
		return
	}
	corpus := dedupCorpus(active)
	raw, ok := g.llmFn(pickModel(corpus), dedupPrompt, corpus)
	if !ok {
		return // retain state, retry next sweep
	}
	g.mu.Lock()
	st.DedupFP[hubDir] = fp
	g.mu.Unlock()

	byID := map[string]memvault.NoteWithBody{}
	for _, n := range active {
		byID[n.Note.ID] = n
	}
	flags := 0
	for _, cluster := range parseClusters(raw) {
		if flags >= maxFlagsPerDedupPass {
			break
		}
		// keep only members that are live un-flagged notes; a group needs 2+ to flag anything
		members := make([]string, 0, len(cluster))
		for _, slug := range cluster {
			if _, ok := byID[slug]; ok {
				members = append(members, slug)
			}
		}
		if len(members) < 2 {
			continue
		}
		for _, group := range splitCluster(members) {
			if flags >= maxFlagsPerDedupPass {
				break
			}
			vcorpus := verifyCorpus(group, byID)
			raw, ok := g.llmFn(pickModel(vcorpus), verifyPrompt, vcorpus)
			if !ok || !parseSameVerdict(raw) {
				continue // unverified groups are dropped, never flagged
			}
			for _, slug := range group[1:] {
				if flags >= maxFlagsPerDedupPass {
					break
				}
				p := byID[slug].Note.Path
				if err := g.flagFn(p, "duplicate"); err != nil {
					log.Printf("[memgarden] flag duplicate %s: %v\n", p, err)
					continue
				}
				flags++
			}
		}
	}
	g.saveState()
}
