package harness

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestListExcludesAPIBackends(t *testing.T) {
	got := List()
	if len(got) != 3 {
		t.Fatalf("len(List()) = %d, want 3", len(got))
	}
	for _, spec := range got {
		if spec.Runtime == "openrouter" {
			t.Fatal("OpenRouter must not be an installed harness")
		}
	}
}

func TestLookupCapabilities(t *testing.T) {
	for _, runtime := range []string{"pi", "claude", "codex"} {
		spec, ok := Lookup(runtime)
		if !ok || !spec.ConsultCapable || spec.Bin == "" {
			t.Fatalf("invalid %s spec: %+v, ok=%v", runtime, spec, ok)
		}
		// run workers are claude and pi only; codex stays consult-only
		if wantWorker := runtime == "pi" || runtime == "claude"; spec.RunWorkerCapable != wantWorker {
			t.Fatalf("%s RunWorkerCapable = %v, want %v", runtime, spec.RunWorkerCapable, wantWorker)
		}
	}
}

func TestCatalogOrderAndPiCapabilities(t *testing.T) {
	var runtimes []string
	for _, spec := range List() {
		runtimes = append(runtimes, spec.Runtime)
	}
	want := []string{"pi", "claude", "codex"}
	if !reflect.DeepEqual(runtimes, want) {
		t.Fatalf("runtimes = %v, want %v", runtimes, want)
	}
	pi, ok := Lookup("pi")
	if !ok {
		t.Fatal("expected pi to be in the catalog")
	}
	if pi.Bin != "pi" || pi.Label != "Pi" || !pi.ConsultCapable || !pi.RunWorkerCapable {
		t.Fatalf("pi spec = %+v", pi)
	}
}

func TestValidateInstalled(t *testing.T) {
	old := lookPath
	t.Cleanup(func() { lookPath = old })
	lookPath = func(bin string) (string, error) { return `C:\bin\` + bin, nil }

	if _, err := ValidateInstalled("claude", OperationRunWorker); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateInstalled("codex", OperationRunWorker); err == nil || !strings.Contains(err.Error(), "does not support run workers") {
		t.Fatalf("codex run worker error = %v", err)
	}
	if _, err := ValidateInstalled("missing", OperationConsult); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("unknown runtime error = %v", err)
	}
}

func TestValidateInstalledUnavailable(t *testing.T) {
	old := lookPath
	t.Cleanup(func() { lookPath = old })
	lookPath = func(string) (string, error) { return "", exec.ErrNotFound }
	_, err := ValidateInstalled("codex", OperationConsult)
	if err == nil || !strings.Contains(err.Error(), "codex") || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("error = %v", err)
	}
}

// TestProbeAllBoundedConcurrency proves all probes run concurrently: a fake version command that
// blocks on a shared channel only returns once every catalog entry has entered it.
func TestProbeAllBoundedConcurrency(t *testing.T) {
	oldLookPath := lookPath
	oldVersion := versionCommand
	t.Cleanup(func() {
		lookPath = oldLookPath
		versionCommand = oldVersion
	})
	lookPath = func(bin string) (string, error) { return `C:\bin\` + bin, nil }

	entered := make(chan struct{}, len(specs))
	release := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	versionCommand = func(ctx context.Context, bin string) ([]byte, error) {
		entered <- struct{}{}
		<-release
		return []byte("1.0.0"), nil
	}

	go func() {
		defer wg.Done()
		ProbeAll(context.Background())
	}()

	for range len(specs) {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("probe did not enter the version command")
		}
	}
	close(release)
	wg.Wait()
}

func TestConfigSurfacePaths(t *testing.T) {
	home := filepath.Join("C:", "Users", "k")
	cases := []struct{ runtime, steering, skills string }{
		{"claude", filepath.Join(home, ".claude", "CLAUDE.md"), filepath.Join(home, ".claude", "skills")},
		{"codex", filepath.Join(home, ".codex", "AGENTS.md"), filepath.Join(home, ".codex", "skills")},
		{"pi", filepath.Join(home, ".pi", "agent", "AGENTS.md"), ""},
	}
	for _, c := range cases {
		spec, ok := Lookup(c.runtime)
		if !ok {
			t.Fatalf("%s missing from catalog", c.runtime)
		}
		if got := spec.SteeringPath(home); got != c.steering {
			t.Errorf("%s SteeringPath = %q, want %q", c.runtime, got, c.steering)
		}
		if got := spec.SkillsPath(home); got != c.skills {
			t.Errorf("%s SkillsPath = %q, want %q", c.runtime, got, c.skills)
		}
	}
}

func TestConfigRootIsSteeringParent(t *testing.T) {
	home := filepath.Join("C:", "Users", "k")
	for _, c := range []struct{ runtime, want string }{
		{"pi", filepath.Join(home, ".pi", "agent")},
		{"claude", filepath.Join(home, ".claude")},
		{"codex", filepath.Join(home, ".codex")},
	} {
		spec, _ := Lookup(c.runtime)
		if got := spec.ConfigRoot(home); got != c.want {
			t.Errorf("%s ConfigRoot = %q, want %q", c.runtime, got, c.want)
		}
	}
}

// A harness whose --version stalls behind a shim (pi is pi.cmd on Windows) is still listed, just without a
// version: the probe used to wait as long as the stalled child held its output open, and every route picker's
// catalog request waited with it.
func TestProbeVersionReturnsWhenTheHarnessStalls(t *testing.T) {
	old := versionProbeTimeout
	versionProbeTimeout = 300 * time.Millisecond
	t.Cleanup(func() { versionProbeTimeout = old })
	dir := t.TempDir()
	bin := filepath.Join(dir, "stall")
	script := []byte("#!/bin/sh\nsleep 15 &\nwait\n")
	if runtime.GOOS == "windows" {
		bin += ".cmd"
		script = []byte("@echo off\r\nping -n 16 127.0.0.1 >nul\r\n")
	}
	if err := os.WriteFile(bin, script, 0o755); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	_, err := versionCommand(context.Background(), bin)

	if elapsed := time.Since(start); elapsed > versionWaitDelay+5*time.Second {
		t.Fatalf("the version probe returned %v after a 300ms bound", elapsed)
	}
	if err == nil {
		t.Fatal("a version probe cut off at its bound must fail")
	}
}
