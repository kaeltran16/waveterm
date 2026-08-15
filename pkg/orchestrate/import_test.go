package orchestrate

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/pitasks"
)

func TestImportPitasks(t *testing.T) {
	in := []pitasks.Task{
		{ID: "1", Subject: "setup", Status: "in_progress"},
		{ID: "2", Subject: "api", Status: "pending", BlockedBy: []string{"1"}},
		{ID: "3", Subject: "done already", Status: "completed"},
	}
	nodes, err := ImportPitasks(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 {
		t.Fatalf("want 2 nodes, got %d", len(nodes))
	}
	if nodes[0].ID != "t-1" || nodes[0].Label != "setup" {
		t.Fatalf("bad node0: %+v", nodes[0])
	}
	if !reflect.DeepEqual(nodes[1].Deps, []string{"t-1"}) {
		t.Fatalf("bad deps: %+v", nodes[1].Deps)
	}
	if _, err := ImportPitasks(nil); err == nil {
		t.Fatal("empty input must fail validation")
	}
}
