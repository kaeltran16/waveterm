// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The process-running half of pkg/consult: stream a headless CLI's reply to a callback while
// capturing the full text, and probe whether a runtime's binary is installed. Three read strategies,
// selected by RuntimeSpec: raw stdout, JSONL-parsed stdout, or a pty (see RuntimeSpec docs).

package consult

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/creack/pty"
)

// Run executes the runtime in one-shot mode with the given prompt and cwd, calling emit for each
// reply fragment as it arrives, and returns the complete captured reply.
func Run(ctx context.Context, spec RuntimeSpec, cwd, prompt string, emit func(string)) (string, error) {
	if spec.UsePty {
		return runPty(ctx, spec, cwd, prompt, emit)
	}
	return runPipe(ctx, spec, cwd, prompt, emit)
}

// runPipe spawns the CLI with stdout piped. With a ParseLine it reads JSONL events line-by-line and
// emits the text each reply event carries; without one it emits raw stdout chunks verbatim.
func runPipe(ctx context.Context, spec RuntimeSpec, cwd, prompt string, emit func(string)) (string, error) {
	cmd, stderr, err := startCmd(ctx, spec, cwd, prompt)
	if err != nil {
		return "", err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("starting %s: %w", spec.Bin, err)
	}
	// Grandchildren (e.g. codex hook subprocesses) can inherit and hold the stdout pipe open after the
	// CLI itself exits, so an EOF-driven read loop would block forever; and a ctx-killed process's pipe
	// may never EOF either. Closing stdout when ctx fires guarantees the read loop ends.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			stdout.Close()
		case <-stop:
		}
	}()
	var full strings.Builder
	if spec.ParseLine != nil {
		// claude/codex hook and init events can be far larger than bufio.Scanner's 64KB token cap,
		// so read with a growing Reader instead.
		r := bufio.NewReader(stdout)
		for {
			line, rerr := r.ReadBytes('\n')
			if len(line) > 0 {
				if text, isReply := spec.ParseLine(line); isReply {
					full.WriteString(text)
					emit(text)
				}
			}
			if rerr != nil {
				break
			}
		}
	} else {
		buf := make([]byte, 4096)
		for {
			n, rerr := stdout.Read(buf)
			if n > 0 {
				chunk := string(buf[:n])
				full.WriteString(chunk)
				emit(chunk)
			}
			if rerr != nil {
				break
			}
		}
	}
	if werr := waitCmd(ctx, cmd); werr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = werr.Error()
		}
		return full.String(), fmt.Errorf("%s", msg)
	}
	return full.String(), nil
}

// waitCmd reaps the process but never blocks past ctx: a killed CLI whose grandchildren hold its
// stderr pipe open can make cmd.Wait hang, so on ctx cancellation we return without waiting (the
// process was already killed by exec.CommandContext).
func waitCmd(ctx context.Context, cmd *exec.Cmd) error {
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// runPty spawns the CLI under a pseudo-terminal so a TUI-only CLI (agy) actually emits output, then
// cleans the raw terminal stream. The fully-cleaned capture is authoritative; per-chunk emits are
// best-effort liveness (the persisted consult-reply supersedes the live stream on the FE).
func runPty(ctx context.Context, spec RuntimeSpec, cwd, prompt string, emit func(string)) (string, error) {
	cmd, _, err := startCmd(ctx, spec, cwd, prompt)
	if err != nil {
		return "", err
	}
	// a wide, tall window minimizes the CLI wrapping/repainting its output
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 200, Cols: 220})
	if err != nil {
		return "", fmt.Errorf("starting %s under pty: %w", spec.Bin, err)
	}
	defer f.Close()
	// closing the pty master when ctx fires unblocks a stuck Read (e.g. agy leaves a language-server
	// child that holds the pty open after the print run finishes)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			f.Close()
		case <-stop:
		}
	}()
	var raw bytes.Buffer
	buf := make([]byte, 4096)
	for {
		n, rerr := f.Read(buf)
		if n > 0 {
			raw.Write(buf[:n])
			if cleaned := cleanTUI(string(buf[:n])); cleaned != "" {
				emit(cleaned)
			}
		}
		if rerr != nil {
			break
		}
	}
	// A pty master read commonly ends in EIO once the child exits; that is not a real failure. Only
	// surface a Wait error when the context was cancelled (timeout) so the caller can report it.
	werr := waitCmd(ctx, cmd)
	final := cleanTUI(raw.String())
	if ctx.Err() != nil {
		if final != "" {
			return final, nil
		}
		return "", ctx.Err()
	}
	if werr != nil && final == "" {
		return "", fmt.Errorf("%s produced no output", spec.Bin)
	}
	return final, nil
}

func startCmd(ctx context.Context, spec RuntimeSpec, cwd, prompt string) (*exec.Cmd, *bytes.Buffer, error) {
	args := append([]string{}, spec.BaseArgs...)
	if !spec.PromptViaStdin {
		args = append(args, prompt)
	}
	cmd := exec.CommandContext(ctx, spec.Bin, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	if spec.PromptViaStdin {
		cmd.Stdin = strings.NewReader(prompt)
	}
	// pty runtimes get their stderr merged onto the pty; only pipe runtimes capture it separately.
	var stderr *bytes.Buffer
	if !spec.UsePty {
		stderr = &bytes.Buffer{}
		cmd.Stderr = stderr
	}
	if _, err := exec.LookPath(spec.Bin); err != nil {
		return nil, nil, fmt.Errorf("starting %s: %w", spec.Bin, err)
	}
	return cmd, stderr, nil
}

var (
	ansiCSI = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
	ansiOSC = regexp.MustCompile("\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)?")
	ansiEsc = regexp.MustCompile(`\x1b[@-Z\\-_]`)
)

// cleanTUI turns a raw pty/terminal stream into plain text: strip ANSI escapes, resolve carriage-
// return repaints (keep the last-drawn content of each line), drop box-drawing chrome, and collapse
// blank runs. Best-effort — enough to recover the model's answer from a repainting TUI.
func cleanTUI(s string) string {
	s = ansiCSI.ReplaceAllString(s, "")
	s = ansiOSC.ReplaceAllString(s, "")
	s = ansiEsc.ReplaceAllString(s, "")
	var out []string
	for _, line := range strings.Split(s, "\n") {
		// a \r repaints the line in place; keep the last non-empty segment
		if strings.ContainsRune(line, '\r') {
			segs := strings.Split(line, "\r")
			line = ""
			for i := len(segs) - 1; i >= 0; i-- {
				if strings.TrimSpace(segs[i]) != "" {
					line = segs[i]
					break
				}
			}
		}
		line = stripBoxDrawing(line)
		if strings.TrimSpace(line) != "" {
			out = append(out, strings.TrimRight(line, " \t"))
		}
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func stripBoxDrawing(s string) string {
	return strings.Map(func(r rune) rune {
		// box drawing (U+2500–U+257F) + block elements (U+2580–U+259F) are TUI chrome, not content
		if (r >= 0x2500 && r <= 0x259F) || r == '\x00' {
			return -1
		}
		return r
	}, s)
}

// probe reports whether bin resolves on PATH and its best-effort --version output.
func probe(ctx context.Context, bin string) (bool, string) {
	if _, err := exec.LookPath(bin); err != nil {
		return false, ""
	}
	vctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(vctx, bin, "--version").CombinedOutput()
	return true, strings.TrimSpace(string(out))
}

// ProbeInstalled reports install state + version for a known runtime identifier.
func ProbeInstalled(ctx context.Context, runtime string) (bool, string) {
	spec, ok := runtimeSpecs[runtime]
	if !ok {
		return false, ""
	}
	return probe(ctx, spec.Bin)
}
