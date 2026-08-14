// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The gardener loop: per-project sweep that auto-archives provably-unused machine notes and dead-ref
// notes (deterministic, 0 tokens) and flags judgment calls into the cleanup queue. Rides the memdistill
// coordinator's single hourly ticker (registered in main-server.go). Single-flight per project;
// per-pass archive cap. See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memgarden

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/memdistill"
	"github.com/wavetermdev/waveterm/pkg/memroots"
	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const maxArchivesPerPass = 20

// dedupFlagExpireDays is how long a gardener_flag may sit before the LLM pillars' stamps (drift /
// duplicate) decay out of the cleanup queue on their own. Wrong flags must not pin notes forever;
// the content fingerprint means a cleared flag never re-arms dedup. Deterministic "stale" flags are
// exempt — their condition persists, so clearing them would just re-stamp at the next sweep.
const dedupFlagExpireDays = 14

type gardener struct {
	mu       sync.Mutex
	inflight map[string]bool

	now            func() time.Time
	staleDays      int
	maxArchives    int
	cooldownMins   int
	flagExpireDays int

	vaultNotesFn func() []memvault.NoteWithBody
	repoPathFn   func(scope string) string
	repoIndexFn  func(repoPath string) map[string]bool
	archiveFn    func(path, reason string, now time.Time) (string, error)
	flagFn       func(path, reason string) error
	clearFlagFn  func(path string) error
	loadStateFn  func() (*gardenState, error)
	saveStateFn  func(*gardenState) error
	vaultRootFn  func() string
	state        *gardenState
	stateLoaded  bool

	gardenFn func(scope string, notes []memvault.NoteWithBody) // indirection so sweep single-flight tests in isolation
	llmFn    func(model, prompt, corpus string) (string, bool) // used by Tasks 11-12
}

func newGardener() *gardener {
	g := &gardener{
		inflight:       map[string]bool{},
		now:            time.Now,
		staleDays:      gardenerStaleDays(),
		maxArchives:    maxArchivesPerPass,
		cooldownMins:   gardenerCooldownMins(),
		flagExpireDays: dedupFlagExpireDays,
		vaultNotesFn:   memvault.VaultNotes,
		repoPathFn:     memroots.RegistryPathForLabel,
		repoIndexFn:    buildRepoIndex,
		archiveFn:      memvault.Archive,
		flagFn:         memvault.FlagNote,
		clearFlagFn:    memvault.ClearFlag,
		loadStateFn:    defaultLoadState,
		saveStateFn:    defaultSaveState,
		vaultRootFn:    memroots.MemoryRoot,
		llmFn:          runGardenLLM,
	}
	g.gardenFn = g.gardenScope
	return g
}

// gardenerStaleDays resolves N from config, falling back to memvault.StaleDays (30).
func gardenerStaleDays() int {
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.MemoryGardenerStaleDays > 0 {
		return cfg.Settings.MemoryGardenerStaleDays
	}
	return memvault.StaleDays
}

// gardenerCooldownMins resolves the minimum minutes between LLM-triggered sweeps per hub from config,
// falling back to 120 (2 hours). The deterministic pillars (decay, dead-ref) always run.
func gardenerCooldownMins() int {
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.MemoryGardenerCooldownMins > 0 {
		return cfg.Settings.MemoryGardenerCooldownMins
	}
	return 120
}

// gardenScope runs the pillars for one project scope's vault notes, honoring the per-pass archive
// cap. Every auto-action is logged (the visible action log; the Archived view is the reversibility
// surface).
func (g *gardener) gardenScope(scope string, notes []memvault.NoteWithBody) {
	plain := make([]memvault.Note, len(notes))
	for i, n := range notes {
		plain[i] = n.Note
	}
	now := g.now()
	archivedThisPass := 0
	archivedPaths := map[string]bool{}
	repoPath := g.repoPathFn(scope)

	archive := func(path, reason string) {
		if archivedThisPass >= g.maxArchives {
			return // spread the rest across later sweeps
		}
		if _, err := g.archiveFn(path, reason, now); err != nil {
			log.Printf("[memgarden] archive %s (%s): %v\n", path, reason, err)
			return
		}
		archivedThisPass++
		archivedPaths[path] = true
		log.Printf("[memgarden] archived %s reason=%s scope=%s\n", path, reason, scope)
	}

	// Pillar 0: flag decay. LLM stamps (drift/duplicate) older than flagExpireDays clear themselves:
	// a wrong flag must not pin a note in the cleanup queue forever, and the content fingerprint means
	// clearing one never re-arms dedup. Deterministic "stale" flags are exempt — their condition
	// persists, so the clear would just re-stamp at the next sweep. Flag age is the file mtime: the
	// stamp rewrites the file, and a later body edit (human attention) extending the age is fine.
	if g.flagExpireDays > 0 {
		expireCutoff := now.AddDate(0, 0, -g.flagExpireDays)
		for _, n := range plain {
			if !isLLMFlag(n.GardenerFlag) {
				continue
			}
			info, err := os.Stat(n.Path)
			if err != nil || info.ModTime().After(expireCutoff) {
				continue
			}
			if err := g.clearFlagFn(n.Path); err != nil {
				log.Printf("[memgarden] expire flag %s: %v\n", n.Path, err)
			} else {
				log.Printf("[memgarden] expired flag %s (%s)\n", n.Path, n.GardenerFlag)
			}
		}
	}

	// Pillar 1: decay (recall + age).
	for _, a := range classifyDecay(plain, now, g.staleDays) {
		if a.Archive {
			archive(a.Path, a.Reason)
		} else if err := g.flagFn(a.Path, a.Reason); err != nil {
			log.Printf("[memgarden] flag %s (%s): %v\n", a.Path, a.Reason, err)
		}
	}

	// Pillar 2: dead-ref freshness (deterministic). Machine notes whose refs are all gone -> archive.
	if repoPath != "" {
		index := g.repoIndexFn(repoPath)
		for _, n := range notes {
			if archivedPaths[n.Note.Path] || !isMachine(n.Note.Source) || n.Note.SupersededBy != "" {
				continue
			}
			if allRefsDead(extractRefs(n.Body), index) {
				archive(n.Note.Path, "drift")
			}
		}
	}

	g.runLLMPillars(scope, notes, repoPath)

	// Announce only what this pass actually removed. A pass that changed nothing has nothing to say,
	// and announcing every hourly no-op is how an ambient signal becomes noise. Flags are deliberately
	// not announced: the cleanup queue's depth is a level someone reads, not a transition worth
	// interrupting for — and the LLM pillars flag through g.flagFn directly, so any count here would
	// under-report.
	if archivedThisPass > 0 {
		memdistill.PublishActivity(baseds.MemoryActivityData{
			Kind:     baseds.MemoryActivity_Sweep,
			Cwd:      scope,
			Archived: archivedThisPass,
		})
	}
}

// isLLMFlag reports whether a gardener_flag was stamped by an LLM pillar (decay-eligible) rather
// than the deterministic decay pillar (which re-stamps its own condition every sweep).
func isLLMFlag(reason string) bool {
	return reason == "drift" || reason == "duplicate"
}

// runLLMPillars runs the flag-only LLM pillars: soft-drift (freshness) + near-dup (dedup).
// Gated by a per-scope cooldown so rapid note/file changes during active development don't
// trigger an LLM call on every hourly sweep. The cooldown and the dedup fingerprint live in the
// persisted state: in-memory gates reset on restart, and a restart-triggered sweep re-armed the
// pillars against the full corpus — that is how one vault switch stamped 63 duplicate flags in a
// day (observed 2026-08-14). Deterministic pillars always run unthrottled.
func (g *gardener) runLLMPillars(scope string, notes []memvault.NoteWithBody, repoPath string) {
	now := g.now()
	st := g.loadState()
	if g.cooldownMins > 0 {
		g.mu.Lock()
		lastStr := st.LastLLMSweep[scope]
		g.mu.Unlock()
		if lastStr != "" {
			if last, err := time.Parse(time.RFC3339, lastStr); err == nil && now.Sub(last) < time.Duration(g.cooldownMins)*time.Minute {
				return
			}
		}
	}
	g.checkSoftDrift(repoPath, notes)
	g.checkDedup(scope, notes)
	g.mu.Lock()
	st.LastLLMSweep[scope] = now.UTC().Format(time.RFC3339)
	g.mu.Unlock()
	g.saveState()
}

// gardenState is the persisted gardener state: per-scope dedup fingerprints and last LLM sweep
// times. In-memory only, both reset on every restart, and a restart-triggered sweep re-armed the
// LLM pillars against the full corpus — that is how one vault switch stamped 63 duplicate flags in
// a day (observed 2026-08-14). Keyed by scope (project label / cluster).
type gardenState struct {
	VaultRoot    string            `json:"vaultroot"`
	DedupFP      map[string]string `json:"dedupfp"`      // scope -> corpus fingerprint
	DriftFP      map[string]string `json:"driftfp"`      // note path -> ref-mtime fingerprint
	LastLLMSweep map[string]string `json:"lastllmsweep"` // scope -> RFC3339
}

// loadState returns the persisted gardener state, loading it on first use. A vault-root change
// (memory:vaultpath) invalidates every per-scope entry: scope labels collide across vaults, and a
// stale fingerprint or cooldown from the previous vault would suppress the first sweep here.
func (g *gardener) loadState() *gardenState {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stateLoaded {
		return g.state
	}
	st, err := g.loadStateFn()
	if err != nil || st == nil {
		st = &gardenState{}
	}
	if st.DedupFP == nil {
		st.DedupFP = map[string]string{}
	}
	if st.DriftFP == nil {
		st.DriftFP = map[string]string{}
	}
	if st.LastLLMSweep == nil {
		st.LastLLMSweep = map[string]string{}
	}
	root := g.vaultRootFn()
	if st.VaultRoot != "" && st.VaultRoot != root {
		st.DedupFP = map[string]string{}
		st.DriftFP = map[string]string{}
		st.LastLLMSweep = map[string]string{}
	}
	st.VaultRoot = root
	g.state = st
	g.stateLoaded = true
	return st
}

// saveState persists the in-memory state, serialized under mu: concurrent per-scope sweeps each
// call saveState, and two unsynchronized full-file writes interleave into a corrupt file (observed
// 2026-08-14). Failure is logged, never fatal: the state is advisory, and the worst outcome of a
// lost write is one re-armed sweep.
func (g *gardener) saveState() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.state == nil {
		return
	}
	if err := g.saveStateFn(g.state); err != nil {
		log.Printf("[memgarden] save state: %v\n", err)
	}
}

// gardenStateFile is the persisted gardener state file name inside the Wave data dir.
const gardenStateFile = "memgarden-state.json"

func defaultLoadState() (*gardenState, error) {
	data, err := os.ReadFile(filepath.Join(wavebase.GetWaveDataDir(), gardenStateFile))
	if err != nil {
		return nil, err // missing or unreadable -> fresh state
	}
	var st gardenState
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func defaultSaveState(st *gardenState) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(wavebase.GetWaveDataDir(), gardenStateFile), data, 0o644)
}

const llmTimeout = 110 * time.Second

// pickModel defers to consult, which owns the corpus-size escalation and the two model ids it picks
// between. This package holds no model string and no threshold of its own — the escalation is a
// context-window fact shared with memdistill, not a per-package convention.
func pickModel(corpus string) string {
	return consult.ModelForCorpus(corpus)
}

// runGardenLLM is the injectable seam wired in newGardener.
func runGardenLLM(model, prompt, corpus string) (string, bool) {
	cheap := consult.OpenrouterCheapModel()
	long := consult.OpenrouterLongModel()
	resolvedModel := consult.CorpusModel(cheap, long, corpus)
	spec, _ := consult.SpecForTier("openrouter", consult.TierCheap)
	spec.Model = resolvedModel
	fullPrompt := prompt + "\n\n" + corpus
	return runGardenAPI(spec, fullPrompt)
}

// runGardenAPI runs a consult.Run pass. The distill guard env is no longer needed because the backend
// is an API call, not a claude sub-session.
func runGardenAPI(spec consult.RuntimeSpec, prompt string) (string, bool) {
	full, err := consult.Run(context.Background(), spec, wavebase.HeadlessAgentCwd(), prompt, func(string) {})
	if err != nil {
		log.Printf("[memgarden] llm failed (model %s): %v\n", spec.Model, err)
		return "", false
	}
	return full, true
}

// sweep groups the vault's notes by scope and launches a single-flight background garden per scope.
func (g *gardener) sweep() {
	groups := map[string][]memvault.NoteWithBody{}
	for _, n := range g.vaultNotesFn() {
		scope := n.Note.Scope
		if scope == "" {
			scope = "shared"
		}
		groups[scope] = append(groups[scope], n)
	}
	for scope, notes := range groups {
		g.mu.Lock()
		busy := g.inflight[scope]
		if !busy {
			g.inflight[scope] = true
		}
		g.mu.Unlock()
		if busy {
			continue
		}
		go func(s string, ns []memvault.NoteWithBody) {
			defer func() {
				panichandler.PanicHandler("memgarden.gardenScope", recover())
				g.mu.Lock()
				delete(g.inflight, s)
				g.mu.Unlock()
			}()
			g.gardenFn(s, ns)
		}(scope, notes)
	}
}

var (
	defaultGardener *gardener
	startOnce       sync.Once
)

func ensure() {
	startOnce.Do(func() { defaultGardener = newGardener() })
}

// Sweep is the coordinator hook entry: garden every project scope once (single-flight, non-blocking).
func Sweep() {
	ensure()
	defaultGardener.sweep()
}
