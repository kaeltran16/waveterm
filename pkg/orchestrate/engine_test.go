package orchestrate

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// captureClient records broker events so tests can assert engine event publishing.
type captureClient struct {
	mu     sync.Mutex
	events []wps.WaveEvent
}

func (c *captureClient) SendEvent(_ string, event wps.WaveEvent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, event)
}

func (c *captureClient) saw(kind, scope string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.events {
		if e.Event == kind && e.HasScope(scope) {
			return true
		}
	}
	return false
}

func TestTaskPromptCarriesDescriptionAndContract(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	desc := "pin: date-only format (Aug 16)"
	p := taskPrompt(&waveobj.TaskNode{ID: "t-1", Label: "add fmtDate", Description: desc}, &owner)
	if !strings.Contains(p, "add fmtDate") {
		t.Fatalf("label missing from prompt: %q", p)
	}
	if !strings.Contains(p, desc) {
		t.Fatalf("description missing from prompt: %q", p)
	}
	if !strings.Contains(p, HeadlessContract) {
		t.Fatalf("headless contract missing from prompt: %q", p)
	}
}

func TestTaskPromptLabelOnlyStillHasContract(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	p := taskPrompt(&waveobj.TaskNode{ID: "t-1", Label: "plain"}, &owner)
	if !strings.Contains(p, HeadlessContract) {
		t.Fatalf("contract missing from prompt: %q", p)
	}
	if strings.Contains(p, "description") {
		t.Fatalf("no description should appear for a label-only task: %q", p)
	}
}

func TestTaskPromptRunSpecGoalWins(t *testing.T) {
	owner := jarvis.NewRun("owner", "ws-1", "/p", nil, jarvis.RunMode_Orchestrator, nil, 1)
	p := taskPrompt(&waveobj.TaskNode{ID: "t-1", Label: "label", RunSpec: waveobj.RunSpec{Goal: "explicit goal"}}, &owner)
	if !strings.Contains(p, "explicit goal") {
		t.Fatalf("runspec goal missing from prompt: %q", p)
	}
	if strings.Contains(p, "label") {
		t.Fatalf("label must not appear when runspec goal is set: %q", p)
	}
}

func TestScheduleOnceSpawnsUpToCap(t *testing.T) {
	ctx := context.Background()
	ch, err := wstore.CreateChannel(ctx, "engine-test", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 2, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "c", Deps: []string{"t-0"}},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}

	var spawned []string
	old := spawnWorker
	spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string) (string, error) {
		spawned = append(spawned, prompt)
		return "tab:worker", nil
	}
	defer func() { spawnWorker = old }()

	// first step: only t-0 is ready (no deps), so exactly one spawn despite cap 2
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if len(spawned) != 1 {
		t.Fatalf("want 1 spawn (t-0), got %d", len(spawned))
	}
	if g.Tasks[0].State != TaskState_Running || g.Tasks[0].RunID == "" {
		t.Fatalf("t-0 must be running with a child run: %+v", g.Tasks[0])
	}
	child0 := g.Tasks[0].RunID

	// child t-0 completes; the next step derives done and spawns t-1 and t-2 (cap 2)
	if err := wstore.UpdateRun(ctx, ch.OID, child0, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if len(spawned) != 3 {
		t.Fatalf("want 2 more spawns (t-1, t-2), got %d total", len(spawned))
	}
	if g.Tasks[0].State != TaskState_Done {
		t.Fatalf("t-0 must derive done, got %s", g.Tasks[0].State)
	}

	// third step: two running, nothing ready -> no spawns
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if len(spawned) != 3 {
		t.Fatalf("no new spawns expected, got %d", len(spawned))
	}
}

func TestScheduleOncePublishesChildDone(t *testing.T) {
	ctx := context.Background()
	cc := &captureClient{}
	prevClient := wps.Broker.GetClient()
	wps.Broker.SetClient(cc)
	defer wps.Broker.SetClient(prevClient)
	wps.Broker.Subscribe("engine-events-test", wps.SubscriptionRequest{Event: DagEventTaskSpawned, AllScopes: true})
	wps.Broker.Subscribe("engine-events-test", wps.SubscriptionRequest{Event: DagEventChildDone, AllScopes: true})
	defer wps.Broker.Unsubscribe("engine-events-test", DagEventTaskSpawned)
	defer wps.Broker.Unsubscribe("engine-events-test", DagEventChildDone)

	ch, err := wstore.CreateChannel(ctx, "engine-events", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	owner := jarvis.NewRun("owner goal", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
	if err := wstore.AppendRun(ctx, ch.OID, owner); err != nil {
		t.Fatal(err)
	}
	g, err := NewTaskGroup(owner.ID, ch.OID, "g", 2, []waveobj.TaskNode{
		{ID: "t-0", Label: "a"},
		{ID: "t-1", Label: "b", Deps: []string{"t-0"}},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := wstore.AppendDag(ctx, &g); err != nil {
		t.Fatal(err)
	}

	old := spawnWorker
	spawnWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string) (string, error) {
		return "tab:worker", nil
	}
	defer func() { spawnWorker = old }()

	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	child0 := g.Tasks[0].RunID
	scope := waveobj.MakeORef(waveobj.OType_Dag, g.OID).String()
	if !cc.saw(DagEventTaskSpawned, scope) {
		t.Fatal("task-spawned event not published")
	}
	// the spawn also lands on the owning run's lifecycle log, so its card timeline shows the task.
	events, err := wstore.QueryRunEvents(ctx, ch.OID, owner.ID, 50)
	if err != nil {
		t.Fatalf("query run events: %v", err)
	}
	var sawSpawn bool
	for _, e := range events {
		if e.Kind == waveobj.RunEventKindTaskSpawned {
			sawSpawn = true
		}
	}
	if !sawSpawn {
		t.Fatalf("expected task-spawned event on the owning run's log, got %+v", events)
	}

	if err := wstore.UpdateRun(ctx, ch.OID, child0, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := ScheduleOnce(ctx, &g); err != nil {
		t.Fatal(err)
	}
	if !cc.saw(DagEventChildDone, scope) {
		t.Fatal("child-done event not published on running->done transition")
	}
	if g.Tasks[0].State != TaskState_Done {
		t.Fatalf("t-0 must derive done, got %s", g.Tasks[0].State)
	}
}
