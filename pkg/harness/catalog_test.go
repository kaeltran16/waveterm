package harness

import (
	"context"
	"os/exec"
	"path/filepath"
	"reflect"
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
	for _, runtime := range []string{"pi", "claude", "codex", "opencode"} {
		spec, ok := Lookup(runtime)
		if !ok || !spec.ConsultCapable || !spec.RunWorkerCapable || spec.Bin == "" {
			t.Fatalf("invalid %s spec: %+v, ok=%v", runtime, spec, ok)
		}
	}
}

func TestCatalogOrderAndPiCapabilities(t *testing.T) {
	var runtimes []string
	for _, spec := range List() {
		runtimes = append(runtimes, spec.Runtime)
	}
	want := []string{"pi", "claude", "codex", "opencode"}
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

func TestConfigSurfacePaths(t *testing.T) {
	home := filepath.Join("C:", "Users", "k")
	cases := []struct{ runtime, steering, skills string }{
		{"claude", filepath.Join(home, ".claude", "CLAUDE.md"), filepath.Join(home, ".claude", "skills")},
		{"codex", filepath.Join(home, ".codex", "AGENTS.md"), filepath.Join(home, ".codex", "skills")},
		{"opencode", filepath.Join(home, ".config", "opencode", "AGENTS.md"), filepath.Join(home, ".config", "opencode", "skills")},
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
		{"opencode", filepath.Join(home, ".config", "opencode")},
	} {
		spec, _ := Lookup(c.runtime)
		if got := spec.ConfigRoot(home); got != c.want {
			t.Errorf("%s ConfigRoot = %q, want %q", c.runtime, got, c.want)
		}
	}
}
