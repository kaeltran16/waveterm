package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestNewTaskGroup_WithWorkerRoute(t *testing.T) {
	tasks := []waveobj.TaskNode{{ID: "t-1", Label: "a"}}
	workerRoute := &waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}
	g, err := NewTaskGroup("run-1", "ch-1", "title", 2, false, tasks, 0, workerRoute)
	if err != nil {
		t.Fatalf("NewTaskGroup with workerRoute: %v", err)
	}
	if g.WorkerRoute == nil || g.WorkerRoute.Model != "opencode/deepseek-v4-pro" {
		t.Fatalf("workerRoute not persisted: %+v", g.WorkerRoute)
	}
}

func TestNewTaskGroup_RejectsInvalidWorkerRoute(t *testing.T) {
	tasks := []waveobj.TaskNode{{ID: "t-1", Label: "a"}}
	bad := &waveobj.RoutePin{Runtime: "claude", Model: "gpt-5.4"} // claude namespace rejects gpt
	_, err := NewTaskGroup("run-1", "ch-1", "title", 2, false, tasks, 0, bad)
	if err == nil {
		t.Fatal("invalid workerRoute must be rejected")
	}
}
