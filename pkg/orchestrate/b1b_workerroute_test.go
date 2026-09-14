package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestEffectiveTaskRoute_WorkerRouteFallback(t *testing.T) {
	owner := &waveobj.Run{Runtime: "claude", Model: ""}
	group := &waveobj.TaskGroup{WorkerRoute: &waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}}
	task := &waveobj.TaskNode{}
	got := effectiveTaskRoute(task, owner, group)
	if got.Model != "opencode/deepseek-v4-pro" || got.Runtime != "pi" {
		t.Fatalf("group workerRoute fallback: got %+v", got)
	}
}

func TestEffectiveTaskRoute_TaskPinWinsOverWorkerRoute(t *testing.T) {
	owner := &waveobj.Run{Runtime: "claude"}
	group := &waveobj.TaskGroup{WorkerRoute: &waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}}
	task := &waveobj.TaskNode{RunSpec: waveobj.RunSpec{Model: "opencode/claude-opus-4-8", Runtime: "pi"}}
	got := effectiveTaskRoute(task, owner, group)
	if got.Model != "opencode/claude-opus-4-8" || got.Runtime != "pi" {
		t.Fatalf("task pin must win over workerRoute: got %+v", got)
	}
}

func TestEffectiveTaskRoute_InheritOwnerWhenNoWorkerRoute(t *testing.T) {
	owner := &waveobj.Run{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}
	group := &waveobj.TaskGroup{}
	got := effectiveTaskRoute(&waveobj.TaskNode{}, owner, group)
	if got.Model != "opencode/deepseek-v4-pro" {
		t.Fatalf("owner model fallback: got %+v", got)
	}
}
