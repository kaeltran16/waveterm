import { describe, expect, it } from "vitest";
import { leadModelsPayload, pickRows, picksBanner, setModelPayload } from "./modelpicks";

const lead = { runtime: "claude", model: "claude-opus-5-5" } as Run;
const sonnet = { runtime: "claude", model: "sonnet" };

function task(id: string, over: Partial<TaskNode> = {}): TaskNode {
    return { id, label: `task ${id}`, state: "pending", ...over } as TaskNode;
}

function group(tasks: TaskNode[], reviewerpicks = true): TaskGroup {
    return { channelid: "ch-1", runid: "run-1", reviewerpicks, tasks } as unknown as TaskGroup;
}

const waitingSonnet = task("t-1", { runspec: sonnet, modelsource: "reviewer", pickreason: "mechanical" });
const startedSonnet = task("t-2", {
    state: "running",
    runid: "child-2",
    runspec: sonnet,
    modelsource: "reviewer",
    pickreason: "copies a sibling",
});
const leadPick = task("t-3", { modelsource: "reviewer", pickreason: "needs judgment" });
const ownerChanged = task("t-4", { modelsource: "owner", pickreason: "wiring only" });
const unpicked = task("t-5");

describe("pickRows", () => {
    it("is empty on a group that is not on Reviewer picks", () => {
        expect(pickRows(group([waitingSonnet, ownerChanged], false), lead)).toEqual([]);
    });

    it("lists light picks and owner changes, not the reviewer's lead picks", () => {
        const rows = pickRows(group([waitingSonnet, startedSonnet, leadPick, ownerChanged, unpicked]), lead);
        expect(rows.map((r) => r.id)).toEqual(["t-1", "t-2", "t-4"]);
    });

    it("describes a waiting sonnet pick", () => {
        const [row] = pickRows(group([waitingSonnet]), lead);
        expect(row).toEqual({
            id: "t-1",
            title: "task t-1",
            reason: "mechanical",
            model: "sonnet",
            waiting: true,
            changed: false,
            runningModel: "",
        });
    });

    it("names the model a started pick runs on", () => {
        const [row] = pickRows(group([startedSonnet]), lead);
        expect(row.waiting).toBe(false);
        expect(row.runningModel).toBe("sonnet");
    });

    it("marks a task the owner put back on the lead as changed", () => {
        const [row] = pickRows(group([ownerChanged]), lead);
        expect(row.model).toBe("lead");
        expect(row.changed).toBe(true);
        expect(row.waiting).toBe(true);
    });

    it("keeps a task the owner put on sonnet as a sonnet row", () => {
        const [row] = pickRows(group([task("t-6", { runspec: sonnet, modelsource: "owner" })]), lead);
        expect(row.model).toBe("sonnet");
        expect(row.changed).toBe(true);
    });
});

describe("picksBanner", () => {
    it("counts the rows on sonnet against every task", () => {
        const g = group([waitingSonnet, startedSonnet, leadPick, ownerChanged, unpicked]);
        expect(picksBanner(g, lead)).toEqual({ onLight: 2, total: 5 });
    });

    it("is null once no listed task is waiting", () => {
        expect(picksBanner(group([startedSonnet, leadPick, unpicked]), lead)).toBeNull();
    });

    it("is null on a group that is not on Reviewer picks", () => {
        expect(picksBanner(group([waitingSonnet], false), lead)).toBeNull();
    });
});

describe("payloads", () => {
    const g = group([waitingSonnet]);

    it("puts a task on the light pick", () => {
        expect(setModelPayload(g, "t-1", "sonnet")).toEqual({
            channelid: "ch-1",
            runid: "run-1",
            taskid: "t-1",
            action: "setmodel",
            runtime: "claude",
            model: "sonnet",
        });
    });

    it("puts a task back on the lead with an empty target", () => {
        expect(setModelPayload(g, "t-1", "lead")).toEqual({
            channelid: "ch-1",
            runid: "run-1",
            taskid: "t-1",
            action: "setmodel",
            runtime: "",
            model: "",
        });
    });

    it("puts every waiting task back on the lead in one action", () => {
        expect(leadModelsPayload(g)).toEqual({ channelid: "ch-1", runid: "run-1", taskid: "", action: "leadmodels" });
    });
});
