import { describe, expect, it } from "vitest";
import { buildAgentTree, treeAgentCount, UNGROUPED_PROJECT, type AgentTreeRow } from "./agenttreemodel";
import type { AgentVM } from "./agentsviewmodel";
import type { Lineage, RunInfo } from "./runlineage";

function vm(id: string, state: AgentVM["state"], path?: string): AgentVM {
    return { id, name: id, task: "", state, transcriptPath: path };
}

// transcript paths whose project segment (after "projects/") is the repo dir
const WAVE = "/home/u/.claude/projects/home-u-waveterm/abc.jsonl"; // -> "waveterm"
const LOOM = "/home/u/.claude/projects/home-u-loom/def.jsonl"; // -> "loom"

describe("buildAgentTree", () => {
    it("returns [] for no agents", () => {
        expect(buildAgentTree([], [])).toEqual([]);
    });

    it("emits one group header then its parents", () => {
        const agents = [vm("a", "working", WAVE), vm("b", "idle", WAVE)];
        const rows = buildAgentTree(agents, ["a", "b"]);
        expect(rows.map((r) => r.kind)).toEqual(["group", "parent", "parent"]);
        expect(rows[0]).toMatchObject({ kind: "group", project: "waveterm", count: 2, attn: 0 });
    });

    it("counts asking agents in the group's attn", () => {
        const agents = [vm("a", "asking", WAVE), vm("b", "working", WAVE)];
        const rows = buildAgentTree(agents, ["a", "b"]);
        expect(rows[0]).toMatchObject({ kind: "group", attn: 1 });
    });

    it("groups by project in first-seen order of `order`", () => {
        const agents = [vm("w", "working", WAVE), vm("l", "working", LOOM)];
        const rows = buildAgentTree(agents, ["l", "w"]); // loom first by order
        const groups = rows.filter((r) => r.kind === "group");
        expect(groups.map((g: any) => g.project)).toEqual(["loom", "waveterm"]);
    });

    it("orders parents within a group by `order`; ids absent from order sort last", () => {
        const agents = [vm("a", "working", WAVE), vm("b", "working", WAVE), vm("c", "working", WAVE)];
        const rows = buildAgentTree(agents, ["b", "a"]); // c missing
        const parents = rows.filter((r) => r.kind === "parent") as any[];
        expect(parents.map((p) => p.agent.id)).toEqual(["b", "a", "c"]);
    });

    it("falls back to UNGROUPED_PROJECT when no transcript path", () => {
        const rows = buildAgentTree([vm("a", "idle")], ["a"]);
        expect(rows[0]).toMatchObject({ kind: "group", project: UNGROUPED_PROJECT });
    });
});

describe("buildAgentTree with run lineage", () => {
    const task = (id: string, state: string): TaskNode => ({ id, label: id, state }) as TaskNode;
    const run = (runId: string, tasks: TaskNode[], digest?: DagStatusDigest): RunInfo => ({
        runId,
        channelId: "ch",
        title: "Resource linking",
        project: "waveterm",
        dag: { oid: "dag-1", runid: runId, tasks } as TaskGroup,
        digest,
    });
    // a worker's own project is the engine's empty spawn name, so nesting must not depend on it
    const agent = (id: string, state: AgentVM["state"], project = "waveterm"): AgentVM => ({
        id,
        name: id,
        task: "",
        state,
        project,
        transcriptPath: project ? undefined : LOOM,
    });
    const lineage = (runs: RunInfo[], roles: Lineage["roles"]): Lineage => ({
        roles,
        runs: Object.fromEntries(runs.map((r) => [r.runId, r])),
    });
    const shape = (rows: AgentTreeRow[]) =>
        rows.map((r) => {
            switch (r.kind) {
                case "group":
                    return `group:${r.project}:${r.count}:${r.attn}`;
                case "worker":
                    return `worker:${r.task.id}:${r.agent?.id ?? "-"}`;
                case "done":
                    return `done:${r.count}:${r.open}`;
                case "parent":
                    return `parent:${r.agent.id}`;
                default:
                    return `${r.kind}:${r.run.runId}:${r.live}`;
            }
        });

    it("nests the done fold, then live workers in plan order, then queued tasks under their lead", () => {
        const r = run("run-1", [
            task("t-1", "done"),
            task("t-2", "running"),
            task("t-3", "running"),
            task("t-4", "pending"),
        ]);
        const agents = [
            agent("w3", "working", ""),
            agent("lead", "working"),
            agent("solo", "idle"),
            agent("w2", "working", ""),
        ];
        const rows = buildAgentTree(
            agents,
            ["w3", "lead", "solo", "w2"],
            lineage([r], {
                lead: { kind: "lead", runId: "run-1" },
                w2: { kind: "worker", leadRunId: "run-1", taskId: "t-2" },
                w3: { kind: "worker", leadRunId: "run-1", taskId: "t-3" },
            })
        );
        expect(shape(rows)).toEqual([
            "group:waveterm:4:0",
            "lead:run-1:2",
            "done:1:false",
            "worker:t-2:w2",
            "worker:t-3:w3",
            "worker:t-4:-",
            "parent:solo",
        ]);
        // a queued task has no session, so it is not counted as an agent
        expect(treeAgentCount(rows)).toBe(4);
    });

    it("lists done workers when their fold is open, including ones whose session is gone", () => {
        const r = run("run-1", [task("t-1", "done"), task("t-2", "done")]);
        const rows = buildAgentTree(
            [agent("lead", "idle"), agent("w1", "idle", "")],
            ["lead", "w1"],
            lineage([r], {
                lead: { kind: "lead", runId: "run-1" },
                w1: { kind: "worker", leadRunId: "run-1", taskId: "t-1" },
            }),
            { collapsed: new Set(), doneOpen: new Set(["run-1"]) }
        );
        expect(shape(rows)).toEqual(["group:waveterm:1:0", "lead:run-1:0", "done:2:true", "worker:t-1:w1", "worker:t-2:-"]);
        // the header's total agrees with the group's, so a done worker's open session is counted in neither
        expect(treeAgentCount(rows)).toBe(1);
    });

    it("hides a collapsed run's workers but still counts them", () => {
        const r = run("run-1", [task("t-1", "running")]);
        const rows = buildAgentTree(
            [agent("lead", "working"), agent("w1", "working", "")],
            ["lead", "w1"],
            lineage([r], {
                lead: { kind: "lead", runId: "run-1" },
                w1: { kind: "worker", leadRunId: "run-1", taskId: "t-1" },
            }),
            { collapsed: new Set(["run-1"]), doneOpen: new Set() }
        );
        expect(shape(rows)).toEqual(["group:waveterm:2:0", "lead:run-1:1"]);
    });

    it("puts a run with no lead in the roster where its first worker would be, in the run's project", () => {
        const r = { ...run("run-2", [task("t-1", "running"), task("t-2", "running")]), project: "accept-ask" };
        const rows = buildAgentTree(
            [agent("solo", "idle"), agent("g2", "working", ""), agent("g1", "working", "")],
            ["solo", "g2", "g1"],
            lineage([r], {
                g1: { kind: "worker", leadRunId: "run-2", taskId: "t-1" },
                g2: { kind: "worker", leadRunId: "run-2", taskId: "t-2" },
            })
        );
        expect(shape(rows)).toEqual([
            "group:waveterm:1:0",
            "parent:solo",
            "group:accept-ask:2:0",
            "run:run-2:2",
            "worker:t-1:g1",
            "worker:t-2:g2",
        ]);
    });

    it("counts a worker as needing you only when the human holds its question", () => {
        const digest = {
            tasks: [
                { taskid: "t-1", waitreason: "lead-ask" },
                { taskid: "t-2", waitreason: "ask" },
            ],
        } as DagStatusDigest;
        const r = run("run-1", [task("t-1", "running"), task("t-2", "running")], digest);
        const rows = buildAgentTree(
            [agent("lead", "working"), agent("w1", "asking", ""), agent("w2", "asking", "")],
            ["lead", "w1", "w2"],
            lineage([r], {
                lead: { kind: "lead", runId: "run-1" },
                w1: { kind: "worker", leadRunId: "run-1", taskId: "t-1" },
                w2: { kind: "worker", leadRunId: "run-1", taskId: "t-2" },
            })
        );
        expect(rows[0]).toMatchObject({ kind: "group", count: 3, attn: 1 });
    });

    it("keeps a tab left on a task by an earlier attempt under the run, behind the task's current agent", () => {
        const r = run("run-1", [{ id: "t-1", label: "t-1", state: "running", runid: "new-run" } as TaskNode]);
        const rows = buildAgentTree(
            [
                agent("lead", "working"),
                { ...agent("old", "idle", ""), runId: "old-run" },
                { ...agent("new", "working", ""), runId: "new-run" },
            ],
            ["lead", "old", "new"],
            lineage([r], {
                lead: { kind: "lead", runId: "run-1" },
                old: { kind: "worker", leadRunId: "run-1", taskId: "t-1" },
                new: { kind: "worker", leadRunId: "run-1", taskId: "t-1" },
            })
        );
        expect(shape(rows)).toEqual(["group:waveterm:2:0", "lead:run-1:1", "worker:t-1:new", "worker:t-1:old"]);
    });

    it("folds a finished reviewer's tab into its done task", () => {
        const r = run("run-1", [{ id: "t-1", label: "t-1", state: "done", runid: "work-run" } as TaskNode]);
        const rows = buildAgentTree(
            [{ ...agent("reviewer", "idle", ""), runId: "review-run" }, agent("lead", "idle")],
            ["reviewer", "lead"],
            lineage([r], {
                lead: { kind: "lead", runId: "run-1" },
                reviewer: { kind: "worker", leadRunId: "run-1", taskId: "t-1" },
            }),
            { collapsed: new Set(), doneOpen: new Set(["run-1"]) }
        );
        expect(shape(rows)).toEqual(["group:waveterm:1:0", "lead:run-1:0", "done:1:true", "worker:t-1:reviewer"]);
    });

    it("keeps an agent whose run is not loaded as a plain row", () => {
        const rows = buildAgentTree(
            [agent("w1", "working")],
            ["w1"],
            lineage([], { w1: { kind: "worker", leadRunId: "gone", taskId: "t-1" } })
        );
        expect(shape(rows)).toEqual(["group:waveterm:1:0", "parent:w1"]);
    });
});
