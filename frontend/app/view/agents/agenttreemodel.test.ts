import { describe, expect, it } from "vitest";
import { buildAgentTree, UNGROUPED_PROJECT } from "./agenttreemodel";
import type { AgentVM } from "./agentsviewmodel";

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
