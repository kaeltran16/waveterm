// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build liveprobe

// Live probe for J8's unexecuted Verify. J8 repointed the user-facing "fast" sharpen mode from the
// `fable` alias to `haiku` on a cost argument, then marked itself resolved without running either
// model — so the claim that "a fast sharpen still produces a usable rewrite" was never tested, and
// neither was the cost/latency delta that motivated the change. This runs the real Sharpen path
// against a real claude CLI on three aliases and reports both.
//
//	go test -tags liveprobe -run TestLiveSharpenModelComparison -v -timeout 20m ./pkg/tasksharpen/
//
// Needs `claude` on PATH and spends real tokens (9 bounded, tool-less prompt rewrites).
package tasksharpen

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
)

// probeModels are the aliases under comparison: the current "fast" mode, the value it replaced, and
// the untouched "sonnet" mode as a control. Prices are per MTok input/output, for the cost column.
var probeModels = []struct {
	alias      string
	role       string
	inPerMTok  float64
	outPerMTok float64
}{
	{consult.CheapModel, "fast (current)", 1, 5}, // Haiku 4.5
	{"fable", "fast (pre-J8)", 10, 50},           // Claude Fable 5
	{"sonnet", "sonnet (control)", 3, 15},        // Claude Sonnet 5
}

// probeTasks are rough New-Agent inputs of the shape the sharpener exists for: terse, vague, and
// multi-part. A rewrite is "usable" if it preserves intent and adds no invented facts.
var probeTasks = []struct {
	name string
	task string
}{
	{"terse", "fix the flaky login test"},
	{"vague", "the memory tab gets slow when there are lots of notes, make it faster"},
	{"multipart", "add a setting to pick the accent color, persist it, and make sure the titlebar picks it up too"},
}

type probeResult struct {
	model   string
	task    string
	elapsed time.Duration
	usage   tokenUsage
	costUSD float64
	output  string
	err     error
}

func TestLiveSharpenModelComparison(t *testing.T) {
	if _, ok := consult.SpecFor("claude"); !ok {
		t.Skip("claude runtime spec unavailable")
	}
	only := strings.Split(os.Getenv("PROBE_MODELS"), ",") // e.g. PROBE_MODELS=haiku to re-run one
	var results []probeResult
	for _, m := range probeModels {
		if os.Getenv("PROBE_MODELS") != "" && !slices.Contains(only, m.alias) {
			continue
		}
		for _, tc := range probeTasks {
			usage := forceModel(t, m.alias)
			start := time.Now()
			res, err := Sharpen(context.Background(), Input{
				Task:        tc.task,
				ProjectName: "waveterm",
				Runtime:     "claude",
				Mode:        "fast",
			})
			r := probeResult{
				model:   m.alias,
				task:    tc.name,
				elapsed: time.Since(start),
				usage:   *usage,
				output:  res.Task,
				err:     err,
			}
			r.costUSD = r.usage.cost(m.inPerMTok, m.outPerMTok)
			results = append(results, r)
			if err != nil {
				t.Errorf("%s/%s: %v", m.alias, tc.name, err)
				continue
			}
			t.Logf("\n=== %s / %s (%s) ===\nprompt: %s\n%s\n--- %.1fs | in %d + write %d (%dh/%dm) + read %d | out %d | $%.5f",
				m.alias, tc.name, m.role, tc.task, res.Task, r.elapsed.Seconds(),
				r.usage.in, r.usage.cacheWrite, r.usage.write1h, r.usage.write5m, r.usage.cacheRead,
				r.usage.out, r.costUSD)
		}
	}

	t.Log("\n" + summarize(results))
}

// summarize prints per-model totals so the cost and latency delta is readable without arithmetic.
func summarize(results []probeResult) string {
	var b strings.Builder
	b.WriteString("model   | runs | ok | median s | prompt tok (write/read) | out tok | out $ | total $\n")
	for _, m := range probeModels {
		var runs, ok int
		var tot tokenUsage
		var cost float64
		var secs []float64
		for _, r := range results {
			if r.model != m.alias {
				continue
			}
			runs++
			if r.err == nil {
				ok++
			}
			tot = tot.add(r.usage)
			cost += r.costUSD
			secs = append(secs, r.elapsed.Seconds())
		}
		outOnly := float64(tot.out) * m.outPerMTok / 1e6
		b.WriteString(fmt.Sprintf("%-7s | %4d | %2d | %8.1f | %8d / %-8d | %7d | $%.4f | $%.4f\n",
			m.alias, runs, ok, median(secs), tot.cacheWrite, tot.cacheRead, tot.out, outOnly, cost))
	}
	return b.String()
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && xs[j] < xs[j-1]; j-- {
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
	return xs[len(xs)/2]
}

// tokenUsage is the full billable picture for one call, not just input_tokens/output_tokens — see
// sniffUsage for why the cache fields are load-bearing.
type tokenUsage struct {
	in, out          int
	cacheWrite       int // total, == write1h + write5m
	write1h, write5m int
	cacheRead        int
}

// forceModel rewrites the --model alias on the spec as it reaches the process runner, so the whole
// real Sharpen path runs (validation, prompt, spec clone, timeout, normalize) and only the alias
// differs. It also wraps ParseLine to sniff token usage off the stream-json events — the wrapper
// delegates to the production parser for reply text, so capture is a side effect, not a substitute.
func forceModel(t *testing.T, model string) *tokenUsage {
	t.Helper()
	var usage tokenUsage
	prev := runFn
	runFn = func(ctx context.Context, spec consult.RuntimeSpec, cwd, prompt string, emit func(string)) (string, error) {
		args := append([]string{}, spec.BaseArgs...)
		found := false
		for i, a := range args {
			if a == "--model" && i+1 < len(args) {
				args[i+1], found = model, true
			}
		}
		if !found {
			t.Fatalf("no --model pair in spec args %v; the probe would measure the wrong model", args)
		}
		spec.BaseArgs = args
		inner := spec.ParseLine
		spec.ParseLine = func(line []byte) (string, bool) {
			if got, ok := sniffUsage(line); ok {
				usage = got
			}
			return inner(line)
		}
		return consult.Run(ctx, spec, cwd, prompt, emit)
	}
	t.Cleanup(func() { runFn = prev })
	return &usage
}

// sniffUsage pulls token counts off any stream-json event carrying a usage object. The final result
// event is authoritative and arrives last, so last-write-wins is correct.
//
// Reading `input_tokens` alone is a trap and was this probe's first bug: the claude CLI caches its
// own ~18k-token system prompt, so `input_tokens` is only the *uncached remainder* (single digits
// here) and the real prompt cost sits in the two cache fields. Ignoring them made the input side
// round to zero, turning the cost column into an output-only comparison — which reversed the
// haiku-vs-sonnet verdict, because the cached prefix dominates and is priced per-model.
func sniffUsage(line []byte) (tokenUsage, bool) {
	type usageObj struct {
		InputTokens    int `json:"input_tokens"`
		OutputTokens   int `json:"output_tokens"`
		CacheCreation  int `json:"cache_creation_input_tokens"`
		CacheRead      int `json:"cache_read_input_tokens"`
		CacheCreateTTL struct {
			OneHour int `json:"ephemeral_1h_input_tokens"`
			FiveMin int `json:"ephemeral_5m_input_tokens"`
		} `json:"cache_creation"`
	}
	var ev struct {
		Usage   *usageObj `json:"usage"`
		Message *struct {
			Usage *usageObj `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return tokenUsage{}, false
	}
	u := ev.Usage
	if u == nil && ev.Message != nil {
		u = ev.Message.Usage
	}
	if u == nil {
		return tokenUsage{}, false
	}
	got := tokenUsage{
		in:         u.InputTokens,
		out:        u.OutputTokens,
		cacheWrite: u.CacheCreation,
		write1h:    u.CacheCreateTTL.OneHour,
		write5m:    u.CacheCreateTTL.FiveMin,
		cacheRead:  u.CacheRead,
	}
	if got == (tokenUsage{}) {
		return tokenUsage{}, false
	}
	return got, true
}

// cost applies the published multipliers: a 1h cache write bills at 2x the base input rate, a 5m
// write at 1.25x, and a cache read at 0.1x. write1h+write5m should equal cacheWrite; if the CLI ever
// reports a write with no TTL breakdown, fall back to the cheaper 5m rate rather than over-billing.
func (u tokenUsage) cost(inPerMTok, outPerMTok float64) float64 {
	w1h, w5m := float64(u.write1h), float64(u.write5m)
	if u.write1h+u.write5m == 0 {
		w5m = float64(u.cacheWrite)
	}
	inputUSD := (float64(u.in) + w1h*2 + w5m*1.25 + float64(u.cacheRead)*0.1) * inPerMTok
	return (inputUSD + float64(u.out)*outPerMTok) / 1e6
}

func (u tokenUsage) add(o tokenUsage) tokenUsage {
	return tokenUsage{
		in: u.in + o.in, out: u.out + o.out,
		cacheWrite: u.cacheWrite + o.cacheWrite,
		write1h:    u.write1h + o.write1h,
		write5m:    u.write5m + o.write5m,
		cacheRead:  u.cacheRead + o.cacheRead,
	}
}
