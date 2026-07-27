// pkg/jarvisattrib/store_test.go
package jarvisattrib

import (
	"context"
	"os/exec"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func testVault(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, err := wavevault.OpenVaultAtForTest(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("OpenVaultAtForTest: %v", err)
	}
	return v
}

func TestOverrideLogLatestWins(t *testing.T) {
	v := testVault(t)
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(appendOverride(v, overrideRecord{DossierID: "task-1", RunORef: "run:r1", Action: "detach", Actor: "human", Ts: 1}))
	must(appendOverride(v, overrideRecord{DossierID: "task-1", RunORef: "run:r1", Action: "accept", Actor: "human", Ts: 2}))
	must(appendOverride(v, overrideRecord{DossierID: "task-1", RunORef: "run:r2", Action: "detach", Actor: "human", Ts: 3}))

	ov, err := readOverrides(v)
	if err != nil {
		t.Fatalf("readOverrides: %v", err)
	}
	if ov["task-1|run:r1"] != "accept" {
		t.Fatalf("latest for r1 should be accept, got %q", ov["task-1|run:r1"])
	}
	if ov["task-1|run:r2"] != "detach" {
		t.Fatalf("r2 should be detach, got %q", ov["task-1|run:r2"])
	}
}

func TestReadOverridesMissingFile(t *testing.T) {
	ov, err := readOverrides(testVault(t))
	if err != nil || len(ov) != 0 {
		t.Fatalf("missing log should be empty, not error: %v %v", ov, err)
	}
}

func TestOverrideLogIsCommitted(t *testing.T) {
	v := testVault(t)
	if err := appendOverride(v, overrideRecord{DossierID: "task-1", RunORef: "run:r1", Action: "detach", Actor: "human", Ts: 1}); err != nil {
		t.Fatal(err)
	}
	if err := v.Commit(context.Background(), "test override"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	out, err := exec.Command("git", "-C", v.Root, "ls-files", "attributions/overrides.jsonl").CombinedOutput()
	if err != nil {
		t.Fatalf("git ls-files: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "attributions/overrides.jsonl") {
		t.Fatalf("override log not tracked by git after commit; ls-files=%q", out)
	}
}
