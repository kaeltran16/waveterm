// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The gardener loop: per-project sweep that auto-archives provably-unused machine notes and dead-ref
// notes (deterministic, 0 tokens) and flags judgment calls into the cleanup queue. Rides the memdistill
// coordinator's single hourly ticker (registered in main-server.go). Single-flight per project;
// per-pass archive cap. See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memgarden

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memdistill"
	"github.com/wavetermdev/waveterm/pkg/memvault"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	maxArchivesPerPass = 20
	haikuModel         = "claude-haiku-4-5"
	sonnetModel        = "claude-sonnet-5"
)

type gardener struct {
	mu       sync.Mutex
	inflight map[string]bool

	now         func() time.Time
	staleDays   int
	maxArchives int

	hubDirsFn   func() []string
	hubNotesFn  func(hubDir string) []memvault.NoteWithBody
	repoPathFn  func(hubDir string) string
	repoIndexFn func(repoPath string) map[string]bool
	archiveFn   func(path, reason string, now time.Time) (string, error)
	flagFn      func(path, reason string) error

	gardenFn func(hubDir string)                               // indirection so sweep single-flight tests in isolation
	llmFn    func(model, prompt, corpus string) (string, bool) // used by Tasks 11-12
}

func newGardener() *gardener {
	g := &gardener{
		inflight:    map[string]bool{},
		now:         time.Now,
		staleDays:   gardenerStaleDays(),
		maxArchives: maxArchivesPerPass,
		hubDirsFn:   memvault.ClaudeHubDirs,
		hubNotesFn:  memvault.HubNotes,
		repoPathFn:  memvault.RepoPathForHubDir,
		repoIndexFn: buildRepoIndex,
		archiveFn:   memvault.Archive,
		flagFn:      memvault.FlagNote,
		llmFn:       runGardenLLM,
	}
	g.gardenFn = g.gardenProject
	return g
}

// gardenerStaleDays resolves N from config, falling back to memvault.StaleDays (30).
func gardenerStaleDays() int {
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.MemoryGardenerStaleDays > 0 {
		return cfg.Settings.MemoryGardenerStaleDays
	}
	return memvault.StaleDays
}

// gardenProject runs the pillars for one hub, honoring the per-pass archive cap. Every auto-action is
// logged (the visible action log; the Archived view is the reversibility surface).
func (g *gardener) gardenProject(hubDir string) {
	notes := g.hubNotesFn(hubDir)
	plain := make([]memvault.Note, len(notes))
	for i, n := range notes {
		plain[i] = n.Note
	}
	now := g.now()
	archivedThisPass := 0
	archivedPaths := map[string]bool{}

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
		log.Printf("[memgarden] archived %s reason=%s hub=%s\n", path, reason, hubDir)
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
	repoPath := g.repoPathFn(hubDir)
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

	g.runLLMPillars(hubDir, notes, repoPath) // no-op until Tasks 11-12
}

// runLLMPillars runs the flag-only LLM pillars: soft-drift (freshness) + near-dup (dedup).
func (g *gardener) runLLMPillars(hubDir string, notes []memvault.NoteWithBody, repoPath string) {
	g.checkSoftDrift(repoPath, notes)
	g.checkDedup(hubDir, notes)
}

const (
	combinedBudget = 400 * 1024 // mirror memdistill: at/above this, use the 1M-context model
	llmTimeout     = 110 * time.Second
)

// pickModel escalates to sonnet on a large corpus, mirroring the distiller convention.
func pickModel(corpus string) string {
	if len(corpus) >= combinedBudget {
		return sonnetModel
	}
	return haikuModel
}

// runGardenLLM is the injectable seam wired in newGardener.
func runGardenLLM(model, prompt, corpus string) (string, bool) {
	return runClaudeHeadless(model, prompt, corpus)
}

// runClaudeHeadless runs a `claude -p` pass. The distill guard env marks it as a headless sub-session
// so its own SessionEnd hook no-ops (no self-enqueue, no recall pollution). Mirrors memdistill.runDistill.
func runClaudeHeadless(model, prompt, corpus string) (string, bool) {
	exe := "claude"
	if p, err := exec.LookPath("claude"); err == nil {
		exe = p
	}
	ctx, cancel := context.WithTimeout(context.Background(), llmTimeout)
	defer cancel()
	c := exec.CommandContext(ctx, exe, "-p", "--model", model, prompt)
	c.Stdin = strings.NewReader(corpus)
	c.Env = append(os.Environ(), memdistill.DistillGuardVar+"=1")
	out, err := c.Output()
	if err != nil {
		log.Printf("[memgarden] llm exec failed (model %s): %v\n", model, err)
		return "", false
	}
	return string(out), true
}

// sweep enumerates hubs and launches a single-flight background garden per project.
func (g *gardener) sweep() {
	for _, hub := range g.hubDirsFn() {
		g.mu.Lock()
		busy := g.inflight[hub]
		if !busy {
			g.inflight[hub] = true
		}
		g.mu.Unlock()
		if busy {
			continue
		}
		go func(h string) {
			defer func() {
				panichandler.PanicHandler("memgarden.gardenProject", recover())
				g.mu.Lock()
				delete(g.inflight, h)
				g.mu.Unlock()
			}()
			g.gardenFn(h)
		}(hub)
	}
}

var (
	defaultGardener *gardener
	startOnce       sync.Once
)

func ensure() {
	startOnce.Do(func() { defaultGardener = newGardener() })
}

// Sweep is the coordinator hook entry: garden every project hub once (single-flight, non-blocking).
func Sweep() {
	ensure()
	defaultGardener.sweep()
}
