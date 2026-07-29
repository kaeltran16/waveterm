import { describe, expect, it } from "vitest";
import type { GroundingCard, JarvisConversation } from "./jarviscontract";
import {
    buildSubjectGroups,
    filterSubjectGroups,
    runGoalMatches,
    subjectMark,
    type SubjectInput,
} from "./subjects";

function ch(oid: string, name: string, project: string, archived = false, goals: string[] = []): Channel {
    return {
        oid,
        name,
        projectpath: "/p/" + project,
        meta: archived ? { archived: true } : {},
        runs: goals.map((goal, i) => ({ id: `${oid}-r${i}`, goal })),
    } as unknown as Channel;
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

describe("runGoalMatches", () => {
    it("matches a run by its goal, case-insensitively", () => {
        const c = ch("c1", "checkout", "payments", false, ["Fix the coupon rounding", "bump deps"]);
        expect(runGoalMatches(c, "COUPON").map((r) => r.goal)).toEqual(["Fix the coupon rounding"]);
    });

    it("matches nothing for an empty query — an empty filter is not a match-all run list", () => {
        expect(runGoalMatches(ch("c1", "checkout", "payments", false, ["anything"]), "  ")).toEqual([]);
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

    it("scopes records and threads to nothing when the Space has no dossier id, rather than leaking the global lists", () => {
        const groups = buildSubjectGroups({
            ...BASE,
            spaceScope: { channeloids: ["c1"], tabids: [], runorefs: [] } as unknown as SpaceScope,
            spaceDossierId: null,
        });
        expect(groups.map((g) => g.key)).toEqual(["project:payments"]);
    });

    it("moves archived channels out of their project group into one trailing Archived group", () => {
        const groups = buildSubjectGroups({
            ...BASE,
            channels: [ch("c1", "checkout-revamp", "payments"), ch("c2", "rate-limits", "platform", true)],
        });
        expect(groups.map((g) => g.key)).toEqual(["project:payments", "dossiers", "threads", "archived"]);
        expect(groups.at(-1)!.items.map((i) => i.id)).toEqual(["c2"]);
        expect(groups.at(-1)!.label).toBe("Archived · 1");
    });

    it("omits the Archived group when nothing is archived", () => {
        expect(buildSubjectGroups(BASE).map((g) => g.key)).not.toContain("archived");
    });

    it("keeps a channel whose run goal matches, even when its own label does not", () => {
        const channels = [
            ch("c1", "checkout-revamp", "payments", false, ["fix the coupon rounding"]),
            ch("c2", "rate-limits", "platform"),
        ];
        const groups = buildSubjectGroups({ ...BASE, channels });
        const shown = filterSubjectGroups(groups, "coupon rounding", channels);
        expect(shown.flatMap((g) => g.items.map((i) => i.id))).toEqual(["c1"]);
    });

    it("still matches subject labels, and drops a channel matching neither", () => {
        const channels = [ch("c1", "checkout-revamp", "payments", false, ["fix the coupon rounding"])];
        const groups = buildSubjectGroups({ ...BASE, channels });
        expect(filterSubjectGroups(groups, "checkout", channels).flatMap((g) => g.items.map((i) => i.id))).toContain(
            "c1"
        );
        expect(filterSubjectGroups(groups, "zzz", channels)).toEqual([]);
    });

    it("returns the groups untouched for an empty query", () => {
        const groups = buildSubjectGroups(BASE);
        expect(filterSubjectGroups(groups, "   ", BASE.channels)).toBe(groups);
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
