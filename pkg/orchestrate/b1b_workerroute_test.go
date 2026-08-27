package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestEffectiveTaskRoute_WorkerRouteFallback(t *testing.T) {
	owner := &waveobj.Run{Runtime: "claude", Tier: "capable", Model: ""}
	group := &waveobj.TaskGroup{WorkerRoute: &waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}}
	task := &waveobj.TaskNode{}
	got := effectiveTaskRoute(task, owner, group)
	if got.Model != "opencode/deepseek-v4-pro" || got.Runtime != "pi" {
		t.Fatalf("group workerRoute fallback: got %+v", got)
	}
}

func TestEffectiveTaskRoute_TaskPinWinsOverWorkerRoute(t *testing.T) {
	owner := &waveobj.Run{Runtime: "claude", Tier: "capable"}
	group := &waveobj.TaskGroup{WorkerRoute: &waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}}
	task := &waveobj.TaskNode{RunSpec: waveobj.RunSpec{Model: "opencode/claude-opus-4-8", Runtime: "opencode"}}
	got := effectiveTaskRoute(task, owner, group)
	if got.Model != "opencode/claude-opus-4-8" {
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

func TestEffectiveTaskRoute_WorkerRouteTierFallback(t *testing.T) {
	owner := &waveobj.Run{Runtime: "claude", Tier: "capable"}
	group := &waveobj.TaskGroup{WorkerRoute: &waveobj.RoutePin{Runtime: "pi", Tier: "cheap"}}
	got := effectiveTaskRoute(&waveobj.TaskNode{}, owner, group)
	if got.Tier != "cheap" || got.Runtime != "pi" {
		t.Fatalf("workerRoute tier fallback: got %+v", got)
	}
}
