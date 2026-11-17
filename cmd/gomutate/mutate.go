// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"io"
	"math/rand/v2"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const toolName = "gomutate"

// go test's own -timeout measures only the test run; this backstop on top of it covers compiling the
// package, which on a cold cache can take longer than the run itself.
const buildAllowance = 5 * time.Minute

// after the context kills `go`, the test binary it spawned may still hold the output pipes.
const waitDelay = 5 * time.Second

type Config struct {
	Dir      string
	Base     string
	Max      int
	Seed     uint64
	Timeout  time.Duration
	Progress io.Writer
}

type FileCounts struct {
	Path     string `json:"path"`
	Killed   int    `json:"killed"`
	TimedOut int    `json:"timedOut"`
	Survived int    `json:"survived"`
}

type Survivor struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Op   string `json:"op"`
}

type Report struct {
	Tool      string       `json:"tool"`
	Base      string       `json:"base"`
	Head      string       `json:"head"`
	Killed    int          `json:"killed"`
	TimedOut  int          `json:"timedOut"`
	Survived  int          `json:"survived"`
	Invalid   int          `json:"invalid"`
	Score     *float64     `json:"score"`
	Files     []FileCounts `json:"files"`
	Survivors []Survivor   `json:"survivors"`
}

type mutant struct {
	path string // slash-separated, relative to the tree
	line int
	op   string
	src  []byte // the whole mutated file
}

type outcome int

const (
	killed outcome = iota
	timedOut
	survived
	invalid
)

var outcomeNames = [...]string{"killed", "timedOut", "survived", "invalid"}

func Run(cfg Config) (Report, error) {
	dir, err := filepath.Abs(cfg.Dir)
	if err != nil {
		return Report{}, err
	}
	base, err := gitOut(dir, "rev-parse", "--verify", cfg.Base+"^{commit}")
	if err != nil {
		return Report{}, err
	}
	head, err := gitOut(dir, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return Report{}, err
	}
	mutants, err := collectMutants(dir, base)
	if err != nil {
		return Report{}, err
	}
	mutants = sample(mutants, cfg.Max, cfg.Seed)

	rep := Report{Tool: toolName, Base: base, Head: head, Files: []FileCounts{}, Survivors: []Survivor{}}
	if len(mutants) == 0 {
		return rep, nil
	}
	tmp, err := os.MkdirTemp("", "gomutate-")
	if err != nil {
		return Report{}, err
	}
	defer os.RemoveAll(tmp)

	if err := checkBaselines(dir, mutants, cfg.Timeout); err != nil {
		return Report{}, err
	}
	fileIdx := map[string]int{}
	for i, m := range mutants {
		res, err := testMutant(dir, tmp, m, cfg.Timeout)
		if err != nil {
			return Report{}, err
		}
		fmt.Fprintf(cfg.Progress, "%d/%d %s:%d %s: %s\n", i+1, len(mutants), m.path, m.line, m.op, outcomeNames[res])
		if res == invalid {
			rep.Invalid++
			continue
		}
		fi, ok := fileIdx[m.path]
		if !ok {
			fi = len(rep.Files)
			fileIdx[m.path] = fi
			rep.Files = append(rep.Files, FileCounts{Path: m.path})
		}
		fc := &rep.Files[fi]
		switch res {
		case killed:
			rep.Killed++
			fc.Killed++
		case timedOut:
			rep.TimedOut++
			fc.TimedOut++
		case survived:
			rep.Survived++
			fc.Survived++
			rep.Survivors = append(rep.Survivors, Survivor{Path: m.path, Line: m.line, Op: m.op})
		}
	}
	if total := rep.Killed + rep.TimedOut + rep.Survived; total > 0 {
		score := float64(rep.Killed+rep.TimedOut) / float64(total)
		rep.Score = &score
	}
	return rep, nil
}

func gitOut(dir string, args ...string) (string, error) {
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return "", fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, bytes.TrimSpace(ee.Stderr))
		}
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(out)), nil
}

var hunkHeader = regexp.MustCompile(`^@@ -\S+ \+(\d+)(?:,(\d+))? @@`)

// changedLines maps each .go file changed in base..HEAD to the line numbers HEAD added or changed in it.
func changedLines(dir, base string) (map[string]map[int]bool, error) {
	diff, err := gitOut(dir, "diff", "--unified=0", "--no-color", "--no-ext-diff",
		"--src-prefix=a/", "--dst-prefix=b/", base, "HEAD", "--", "*.go")
	if err != nil {
		return nil, err
	}
	changed := map[string]map[int]bool{}
	var cur map[int]bool
	sc := bufio.NewScanner(strings.NewReader(diff))
	sc.Buffer(nil, 16*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if rest, ok := strings.CutPrefix(line, "+++ "); ok {
			cur = nil
			if p, ok := strings.CutPrefix(rest, "b/"); ok {
				cur = map[int]bool{}
				changed[p] = cur
			}
			continue
		}
		m := hunkHeader.FindStringSubmatch(line)
		if m == nil || cur == nil {
			continue
		}
		start, _ := strconv.Atoi(m[1])
		count := 1
		if m[2] != "" {
			count, _ = strconv.Atoi(m[2])
		}
		for l := start; l < start+count; l++ {
			cur[l] = true
		}
	}
	return changed, sc.Err()
}

func collectMutants(dir, base string) ([]mutant, error) {
	changed, err := changedLines(dir, base)
	if err != nil {
		return nil, err
	}
	paths := make([]string, 0, len(changed))
	for p, lines := range changed {
		if len(lines) > 0 && mutable(dir, p) {
			paths = append(paths, p)
		}
	}
	slices.Sort(paths)
	var all []mutant
	for _, p := range paths {
		src, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(p)))
		if err != nil {
			return nil, err
		}
		ms, err := fileMutants(p, src, changed[p])
		if err != nil {
			return nil, err
		}
		all = append(all, ms...)
	}
	return all, nil
}

// mutable excludes files whose mutants no package test can see: tests, testdata, and files the build skips.
func mutable(dir, rel string) bool {
	if strings.HasSuffix(rel, "_test.go") || slices.Contains(strings.Split(path.Dir(rel), "/"), "testdata") {
		return false
	}
	full := filepath.Join(dir, filepath.FromSlash(rel))
	ok, err := build.Default.MatchFile(filepath.Dir(full), filepath.Base(full))
	return err == nil && ok
}

var swaps = map[token.Token]token.Token{
	token.LSS: token.LEQ, token.LEQ: token.LSS,
	token.GTR: token.GEQ, token.GEQ: token.GTR,
	token.EQL: token.NEQ, token.NEQ: token.EQL,
	token.LAND: token.LOR, token.LOR: token.LAND,
	token.ADD: token.SUB, token.SUB: token.ADD,
	token.MUL: token.QUO, token.QUO: token.MUL,
}

// fileMutants returns one mutant per operator site on a changed line, in source order. Generated files have none.
func fileMutants(rel string, src []byte, lines map[int]bool) ([]mutant, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, rel, src, parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", rel, err)
	}
	if ast.IsGenerated(f) {
		return nil, nil
	}
	var out []mutant
	add := func(pos token.Pos, op string, start, end int, repl string) {
		line := fset.Position(pos).Line
		if !lines[line] {
			return
		}
		m := make([]byte, 0, len(src)+len(repl))
		m = append(m, src[:start]...)
		m = append(m, repl...)
		m = append(m, src[end:]...)
		out = append(out, mutant{path: rel, line: line, op: op, src: m})
	}
	off := func(p token.Pos) int { return fset.Position(p).Offset }
	ast.Inspect(f, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.BinaryExpr:
			if to, ok := swaps[n.Op]; ok {
				start := off(n.OpPos)
				add(n.OpPos, n.Op.String()+" to "+to.String(), start, start+len(n.Op.String()), to.String())
			}
		case *ast.Ident:
			if n.Name == "true" || n.Name == "false" {
				flip := "true"
				if n.Name == "true" {
					flip = "false"
				}
				add(n.Pos(), n.Name+" to "+flip, off(n.Pos()), off(n.End()), flip)
			}
		case *ast.IfStmt:
			start, end := off(n.Cond.Pos()), off(n.Cond.End())
			add(n.Cond.Pos(), "negate if", start, end, "!("+string(src[start:end])+")")
		}
		return true
	})
	return out, nil
}

// sample keeps a seeded random limit of the mutants, in their original order.
func sample(ms []mutant, limit int, seed uint64) []mutant {
	if limit <= 0 || len(ms) <= limit {
		return ms
	}
	idx := make([]int, len(ms))
	for i := range idx {
		idx[i] = i
	}
	r := rand.New(rand.NewPCG(seed, seed))
	r.Shuffle(len(idx), func(i, j int) { idx[i], idx[j] = idx[j], idx[i] })
	idx = idx[:limit]
	slices.Sort(idx)
	out := make([]mutant, len(idx))
	for i, k := range idx {
		out[i] = ms[k]
	}
	return out
}

func pkgArg(rel string) string {
	return "./" + path.Dir(rel)
}

// checkBaselines refuses to score a package whose unmutated tests already fail: every mutant would count as killed.
func checkBaselines(dir string, ms []mutant, timeout time.Duration) error {
	seen := map[string]bool{}
	for _, m := range ms {
		pkg := pkgArg(m.path)
		if seen[pkg] {
			continue
		}
		seen[pkg] = true
		res, out, err := goTest(dir, pkg, "", timeout)
		if err != nil {
			return err
		}
		if res != survived {
			return fmt.Errorf("baseline tests of %s do not pass (%s):\n%s", pkg, outcomeNames[res], out)
		}
	}
	return nil
}

func testMutant(dir, tmp string, m mutant, timeout time.Duration) (outcome, error) {
	mutFile := filepath.Join(tmp, "mutant.go")
	if err := os.WriteFile(mutFile, m.src, 0o644); err != nil {
		return 0, err
	}
	overlay, err := json.Marshal(map[string]map[string]string{
		"Replace": {filepath.Join(dir, filepath.FromSlash(m.path)): mutFile},
	})
	if err != nil {
		return 0, err
	}
	overlayFile := filepath.Join(tmp, "overlay.json")
	if err := os.WriteFile(overlayFile, overlay, 0o644); err != nil {
		return 0, err
	}
	res, _, err := goTest(dir, pkgArg(m.path), overlayFile, timeout)
	return res, err
}

// goTest runs one package's tests and classifies the result: survived means they passed.
func goTest(dir, pkg, overlayFile string, timeout time.Duration) (outcome, []byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout+buildAllowance)
	defer cancel()
	args := []string{"test", "-count=1", "-vet=off", "-timeout=" + timeout.String()}
	if overlayFile != "" {
		args = append(args, "-overlay="+overlayFile)
	}
	cmd := exec.CommandContext(ctx, "go", append(args, pkg)...)
	cmd.Dir = dir
	cmd.WaitDelay = waitDelay
	out, err := cmd.CombinedOutput()
	switch {
	case err == nil:
		return survived, out, nil
	case ctx.Err() != nil || bytes.Contains(out, []byte("panic: test timed out after")):
		return timedOut, out, nil
	case bytes.Contains(out, []byte("[build failed]")) || bytes.Contains(out, []byte("[setup failed]")):
		return invalid, out, nil
	}
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		return 0, out, fmt.Errorf("go test %s: %w", pkg, err)
	}
	return killed, out, nil
}
