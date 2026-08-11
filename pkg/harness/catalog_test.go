package harness

import (
	"context"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestListExcludesAPIBackends(t *testing.T) {
	got := List()
	if len(got) != 4 {
		t.Fatalf("len(List()) = %d, want 4", len(got))
	}
	for _, spec := range got {
		if spec.Runtime == "openrouter" {
			t.Fatal("OpenRouter must not be an installed harness")
		}
	}
}

func TestLookupCapabilities(t *testing.T) {
	for _, runtime := range []string{"claude", "codex", "opencode", "antigravity"} {
		spec, ok := Lookup(runtime)
		if !ok || !spec.ConsultCapable || !spec.RunWorkerCapable || spec.Bin == "" {
			t.Fatalf("invalid %s spec: %+v, ok=%v", runtime, spec, ok)
		}
	}
}

func TestValidateInstalled(t *testing.T) {
	old := lookPath
	t.Cleanup(func() { lookPath = old })
	lookPath = func(bin string) (string, error) { return `C:\bin\` + bin, nil }

	if _, err := ValidateInstalled("opencode", OperationRunWorker); err != nil {
		t.Fatal(err)
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
