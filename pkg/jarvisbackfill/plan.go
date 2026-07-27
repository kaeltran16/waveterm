// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisbackfill turns recorded wstore history into a real Wave Vault corpus, so the second
// brain's tuning constants can be calibrated against something other than fabricated data.
//
// It is strict about fidelity: every field it writes was actually recorded. Runs supply the dossier
// (goal, status, window); Radar investigations that reached a terminal state with a worker-written
// summary supply the decisions. Nothing is inferred, summarized or invented — a gap in the history
// stays a gap, and lands in Plan.Skipped rather than being papered over.
//
// This file is the pure planner: history in, a Plan out, no vault, no database, no wall clock.
// apply.go is the only part that writes.
package jarvisbackfill

import (
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// maxObjectiveChars bounds the objective copied out of a run goal. Goals are free text a human typed
// into the dispatch box and occasionally run to paragraphs; the dossier objective is a one-liner.
const maxObjectiveChars = 200

const provRadarInvestigation = "radar-investigation"

// artifactRe matches a referenced markdown artifact in a run goal. Runs that name the same spec or
// plan file are the same piece of work split across dispatches, which is the only grouping signal
// this history actually carries — there are no ticket ids anywhere in it.
var artifactRe = regexp.MustCompile(`[\w./\\-]+\.[mM][dD]\b`)

// attachmentTailRe strips the "Attachments (read these files...)" block the dispatch UI appends to a
// goal. It is transport, not intent, and it would otherwise dominate the objective.
var attachmentTailRe = regexp.MustCompile(`(?is)\n\s*attachments\s*\(read these files.*$`)

var wsRe = regexp.MustCompile(`\s+`)

// PlannedDossier is one dossier the backfill will create, plus the run edges it carries. OwnerRun is
// the run whose ref is written into the dossier's refs block, making it D's layer-1 canonical edge;
// every other run in RunOIDs is deliberately left unreferenced so D infers it structurally (layer 3).
// That split is the whole point: it produces a mixed confirmed/informing graph instead of a
// single-valued one.
type PlannedDossier struct {
	Facts    jarvisdossier.DossierFacts
	Status   string // active | completed | archived
	Updated  int64
	OwnerRun string
	RunOIDs  []string // owner first, then siblings by CreatedTs
}

// PlannedDecision is one decision record derived from a completed Radar investigation. TaskID is left
// empty here and resolved at apply time, once the owning dossier has a real id.
type PlannedDecision struct {
	OwnerRunOID string
	Facts       jarvisdossier.DecisionFacts
}

// Skip records something the history could not support. Reported rather than dropped silently, so a
// thin corpus reads as thin instead of reading as complete.
type Skip struct {
	What string
	Why  string
}

type Plan struct {
	Dossiers  []PlannedDossier
	Decisions []PlannedDecision
	Skipped   []Skip
}

// groupKey returns the normalized markdown artifact a goal references, or "" when it references none
// (in which case the run stands alone). Normalization folds case and path separators so the same file
// typed with Windows and POSIX separators groups together.
func groupKey(goal string) string {
	m := artifactRe.FindString(goal)
	if m == "" {
		return ""
	}
	return strings.ToLower(strings.ReplaceAll(m, `\`, "/"))
}

// normalizeObjective turns a raw run goal into a one-line objective.
func normalizeObjective(goal string) string {
	s := attachmentTailRe.ReplaceAllString(goal, "")
	s = strings.TrimSpace(wsRe.ReplaceAllString(s, " "))
	if len(s) > maxObjectiveChars {
		s = strings.TrimSpace(s[:maxObjectiveChars])
	}
	return s
}

// terminal reports whether a run status means the run is no longer going to change.
func terminal(status string) bool {
	return status == "done" || status == "cancelled"
}

// groupStatus collapses a group's run statuses into a dossier status. An unfinished run anywhere in
// the group keeps the dossier active — a group is not finished just because one of its runs is.
func groupStatus(runs []*waveobj.Run) string {
	allCancelled := true
	for _, r := range runs {
		if !terminal(r.Status) {
			return "active"
		}
		if r.Status != "cancelled" {
			allCancelled = false
		}
	}
	if allCancelled {
		return "archived"
	}
	return "completed"
}

// runEnd is the run's effective end for windowing: its completion, or its creation when it never
// completed. Never "now" — a backfilled window must describe recorded history, not the import time.
func runEnd(r *waveobj.Run) int64 {
	if r.CompletedTs != 0 {
		return r.CompletedTs
	}
	return r.CreatedTs
}

// investigationEnd is when the decision was actually reached: the investigation's completion, or its
// start if it recorded none. Same rule as runEnd — never the import time, so a backfilled decision
// files under the day it was decided instead of claiming to be today's.
func investigationEnd(inv *waveobj.RadarInvestigation) int64 {
	if inv.CompletedTs != 0 {
		return inv.CompletedTs
	}
	return inv.StartedTs
}

// BuildPlan maps recorded history onto a vault corpus. now is accepted for symmetry with the rest of
// the attribution code and to keep the function total; nothing in the plan is stamped with it,
// because a backfilled dossier must carry its run's window rather than the import time. Getting that
// wrong silently disables D's layer-3 inference: windowsOverlap requires the run to end at or after
// the dossier was created, which a dossier stamped "now" can never satisfy for historical work.
func BuildPlan(runs []*waveobj.Run, reports []*waveobj.RadarReport, now int64) Plan {
	var p Plan

	groups := map[string][]*waveobj.Run{}
	var order []string
	for _, r := range runs {
		if strings.TrimSpace(r.Goal) == "" {
			p.Skipped = append(p.Skipped, Skip{What: "run:" + r.OID, Why: "no goal recorded"})
			continue
		}
		// runs naming no artifact are their own group, keyed by oid so they never collide
		k := groupKey(r.Goal)
		if k == "" {
			k = "run:" + r.OID
		}
		if _, seen := groups[k]; !seen {
			order = append(order, k)
		}
		groups[k] = append(groups[k], r)
	}

	runToDossier := map[string]int{}
	for _, k := range order {
		g := groups[k]
		sort.SliceStable(g, func(i, j int) bool {
			if g[i].CreatedTs != g[j].CreatedTs {
				return g[i].CreatedTs < g[j].CreatedTs
			}
			return g[i].OID < g[j].OID
		})
		owner := g[0]
		created, updated := owner.CreatedTs, runEnd(owner)
		oids := make([]string, 0, len(g))
		for _, r := range g {
			oids = append(oids, r.OID)
			if r.CreatedTs < created {
				created = r.CreatedTs
			}
			if e := runEnd(r); e > updated {
				updated = e
			}
		}
		p.Dossiers = append(p.Dossiers, PlannedDossier{
			Facts: jarvisdossier.DossierFacts{
				Objective: normalizeObjective(owner.Goal),
				Created:   created,
				// Ticket, Acceptance and Confidence stay zero: this history recorded none of them,
				// and inventing them is exactly the fabrication the backfill exists to avoid.
			},
			Status:   groupStatus(g),
			Updated:  updated,
			OwnerRun: owner.OID,
			RunOIDs:  oids,
		})
	}

	sort.SliceStable(p.Dossiers, func(i, j int) bool {
		if p.Dossiers[i].Facts.Created != p.Dossiers[j].Facts.Created {
			return p.Dossiers[i].Facts.Created < p.Dossiers[j].Facts.Created
		}
		return p.Dossiers[i].OwnerRun < p.Dossiers[j].OwnerRun
	})
	dedupeDossierIDs(p.Dossiers)
	for i, d := range p.Dossiers {
		for _, oid := range d.RunOIDs {
			runToDossier[oid] = i
		}
	}

	for _, rep := range reports {
		for _, f := range rep.Findings {
			inv := f.Investigation
			if inv == nil {
				continue
			}
			label := "finding:" + f.ID
			if inv.Status != "done" || strings.TrimSpace(inv.Summary) == "" {
				p.Skipped = append(p.Skipped, Skip{What: label, Why: "investigation has no recorded outcome"})
				continue
			}
			if _, ok := runToDossier[inv.RunID]; !ok {
				p.Skipped = append(p.Skipped, Skip{What: label, Why: "investigated run " + inv.RunID + " has no dossier"})
				continue
			}
			p.Decisions = append(p.Decisions, PlannedDecision{
				OwnerRunOID: inv.RunID,
				Facts: jarvisdossier.DecisionFacts{
					Actor:      "radar",
					Provenance: provRadarInvestigation,
					Rationale:  strings.TrimSpace(inv.Summary),
					Summary:    normalizeObjective(f.Risk),
					Links:      []string{"run-" + inv.RunID},
					Created:    investigationEnd(inv),
				},
			})
		}
	}

	sort.SliceStable(p.Decisions, func(i, j int) bool {
		return p.Decisions[i].Facts.Summary < p.Decisions[j].Facts.Summary
	})
	dedupeDecisionSlugs(p.Decisions)
	return p
}

// prefixDiscriminator front-loads a distinguishing token onto a colliding title. It has to go at the
// front: boundedSlug truncates the tail, so a suffix would be cut off and collide anyway. The token
// is always something the history actually recorded — the referenced artifact when there is one,
// otherwise the run's short oid.
func prefixDiscriminator(title, groupHint, oid string) string {
	tok := shortOID(oid)
	if base := artifactBase(groupHint); base != "" {
		tok = base
	}
	return tok + " — " + title
}

func shortOID(oid string) string {
	if len(oid) > 8 {
		return oid[:8]
	}
	return oid
}

// artifactBase is the filename stem of a group key, which is what actually distinguishes two runs
// phrased identically ("execute this plan <path>") against different files.
func artifactBase(groupHint string) string {
	if !strings.HasSuffix(strings.ToLower(groupHint), ".md") {
		return ""
	}
	base := groupHint
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	return strings.TrimSuffix(base, ".md")
}

// uniquify returns a title whose derived key is not already in seen, front-loading the discriminator
// and then a counter if even that collides (several decisions can share both a run and a prefix). It
// records the winning key. Bounded so a pathological input cannot spin.
func uniquify(title, groupHint, oid string, seen map[string]bool, key func(string) string) string {
	if k := key(title); !seen[k] {
		seen[k] = true
		return title
	}
	cand := normalizeObjective(prefixDiscriminator(title, groupHint, oid))
	for n := 2; seen[key(cand)] && n < 100; n++ {
		cand = normalizeObjective(prefixDiscriminator(title, groupHint, oid+"-"+strconv.Itoa(n)))
	}
	seen[key(cand)] = true
	return cand
}

func dedupeDossierIDs(ds []PlannedDossier) {
	seen := map[string]bool{}
	for i := range ds {
		ds[i].Facts.Objective = uniquify(
			ds[i].Facts.Objective, groupKey(ds[i].Facts.Objective), ds[i].OwnerRun, seen,
			func(s string) string {
				return jarvisdossier.DossierID(jarvisdossier.DossierFacts{Ticket: ds[i].Facts.Ticket, Objective: s})
			})
	}
}

func dedupeDecisionSlugs(decs []PlannedDecision) {
	seen := map[string]bool{}
	for i := range decs {
		decs[i].Facts.Summary = uniquify(
			decs[i].Facts.Summary, "", decs[i].OwnerRunOID, seen, jarvisdossier.DecisionSlug)
	}
}

// DossierForRun returns the index of the dossier owning a run, for apply-time TaskID resolution.
func (p Plan) DossierForRun(oid string) (int, bool) {
	for i, d := range p.Dossiers {
		for _, o := range d.RunOIDs {
			if o == oid {
				return i, true
			}
		}
	}
	return 0, false
}
