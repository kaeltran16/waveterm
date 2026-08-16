package orchestrate

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/pitasks"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// ImportPitasks maps pi-tasks records onto DAG task nodes. Only pending/in_progress
// records are scheduled; completed work is left out. pitasks itself stays read-only.
func ImportPitasks(tasks []pitasks.Task) ([]waveobj.TaskNode, error) {
	idOf := func(pid string) string { return "t-" + pid }
	var nodes []waveobj.TaskNode
	for _, t := range tasks {
		switch t.Status {
		case "pending", "in_progress":
		default:
			continue
		}
		node := waveobj.TaskNode{ID: idOf(t.ID), Label: t.Subject, Description: t.Description}
		for _, b := range t.BlockedBy {
			node.Deps = append(node.Deps, idOf(b))
		}
		nodes = append(nodes, node)
	}
	if err := ValidateTasks(nodes); err != nil {
		return nil, fmt.Errorf("imported tasks invalid: %w", err)
	}
	return nodes, nil
}
