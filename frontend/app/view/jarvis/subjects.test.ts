import { describe, expect, it } from "vitest";
import type { GroundingCard, JarvisConversation } from "./jarviscontract";
import { buildSubjectGroups, subjectMark, type SubjectInput } from "./subjects";

function ch(oid: string, name: string, project: string): Channel {
    return { oid, name, projectpath: "/p/" + project } as unknown as Channel;
}

function dos(id: string, objective: string, status: string): SpaceSummary {
    return { id, objective, status } as unknown as SpaceSummary;
}

function convo(id: string, title: string, taskIds: string[]): JarvisConversation {
    const grounding: GroundingCard[] = taskIds.map((t, i) => ({
        n: i + 1,
        sourceType: "task",
        title: t,
        project: "p",
        ageMs: 0,
        freshness: "fresh",
        navTarget: t,
    }));
    return {
        id,
        title,
        scope: { mode: "all", chips: [], attached: [] },
        turns: [{ role: "jarvis", workingSteps: [], segments: [{ text: "a" }], grounding, terminal: "answered" }],
    };
}

const BASE: SubjectInput = {
    channels: [ch("c1", "checkout-revamp", "payments"), ch("c2", "rate-limits", "platform")],
    dossiers: [dos("task-418", "Coupon abuse guardrails", "active"), dos("task-402", "Idempotent refunds", "paused")],
    conversations: [convo("v1", "Why the Redis counter?", ["task-418"]), convo("v2", "Week 30", [])],
    projectNameFor: (c) => (c.oid === "c1" ? "payments" : "platform"),
    spaceScope: null,
    spaceDossierId: null,
    revealed: false,
};

describe("subjectMark", () => {
    it("gives each kind its own glyph", () => {
        expect(subjectMark("channel")).toBe("#");
        expect(subjectMark("dossier")).toBe("▤");
        expect(subjectMark("conversation")).toBe("~");
    });
});

describe("buildSubjectGroups", () => {
    it("groups channels by project, then records, then threads", () => {
        const groups = buildSubjectGroups(BASE);
        expect(groups.map((g) => g.label)).toEqual(["payments", "platform", "Records · dossiers", "Threads"]);
    });

    it("tags every item with its kind and a stable id", () => {
        const groups = buildSubjectGroups(BASE);
        const records = groups.find((g) => g.key === "dossiers")!;
        expect(records.items.map((i) => i.kind)).toEqual(["dossier", "dossier"]);
        expect(records.items.map((i) => i.id)).toEqual(["task-418", "task-402"]);
    });

    it("labels a dossier by its objective and a conversation by its title", () => {
        const groups = buildSubjectGroups(BASE);
        expect(groups.find((g) => g.key === "dossiers")!.items[0].label).toBe("Coupon abuse guardrails");
        expect(groups.find((g) => g.key === "threads")!.items[0].label).toBe("Why the Redis counter?");
    });

    it("omits a group with no items rather than rendering an empty heading", () => {
        const groups = buildSubjectGroups({ ...BASE, dossiers: [], conversations: [] });
        expect(groups.map((g) => g.key)).toEqual(["project:payments", "project:platform"]);
    });

    it("treats a null channel list as no channels, not a crash", () => {
        const groups = buildSubjectGroups({ ...BASE, channels: null });
        expect(groups.map((g) => g.key)).toEqual(["dossiers", "threads"]);
    });

    it("scopes all three kinds to an active Space", () => {
        const groups = buildSubjectGroups({
            ...BASE,
            spaceScope: { channeloids: ["c1"], tabids: [], runorefs: [] } as unknown as SpaceScope,
            spaceDossierId: "task-418",
        });
        expect(groups.find((g) => g.key.startsWith("project:"))!.items.map((i) => i.id)).toEqual(["c1"]);
        expect(groups.find((g) => g.key === "dossiers")!.items.map((i) => i.id)).toEqual(["task-418"]);
        expect(groups.find((g) => g.key === "threads")!.items.map((i) => i.id)).toEqual(["v1"]);
    });

    it("passes everything through when the Space is revealed — the show-all escape hatch", () => {
        const groups = buildSubjectGroups({
            ...BASE,
            spaceScope: { channeloids: ["c1"], tabids: [], runorefs: [] } as unknown as SpaceScope,
            spaceDossierId: "task-418",
            revealed: true,
        });
        expect(groups.find((g) => g.key === "dossiers")!.items).toHaveLength(2);
        expect(groups.find((g) => g.key === "threads")!.items).toHaveLength(2);
    });
});
