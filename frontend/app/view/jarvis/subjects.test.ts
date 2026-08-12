import { describe, expect, it } from "vitest";
import type { GroundingCard, JarvisConversation } from "./jarviscontract";
import {
    buildSubjectGroups,
    filterSubjectGroups,
    firstVisibleChannel,
    recordStatusBucket,
    runGoalMatches,
    subjectMark,
    visibleSubjectGroups,
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

function dos(id: string, objective: string, status: string, updated = 0): SpaceSummary {
    return { id, objective, status, updated } as unknown as SpaceSummary;
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

describe("recordStatusBucket", () => {
    it("keeps active and paused apart, and folds both terminal statuses into one", () => {
        // a row in a long list needs three tones, not four: completed and archived both mean "not now".
        expect(recordStatusBucket("active")).toBe("active");
        expect(recordStatusBucket("paused")).toBe("paused");
        expect(recordStatusBucket("completed")).toBe("done");
        expect(recordStatusBucket("archived")).toBe("done");
    });

    it("treats an unknown status as done rather than shouting about it", () => {
        // a status this build has not heard of must not render as live work
        expect(recordStatusBucket("")).toBe("done");
        expect(recordStatusBucket("wedged")).toBe("done");
    });
});

describe("visibleSubjectGroups", () => {
    const groups = buildSubjectGroups(BASE); // payments, platform, threads, dossiers

    it("keeps the items of an expanded group", () => {
        const shown = visibleSubjectGroups(groups, { threads: false }, false);
        expect(shown.find((g) => g.key === "threads")!.items.map((i) => i.id)).toEqual(["v1", "v2"]);
    });

    it("renders no items for a collapsed group but still reports its true count", () => {
        // the header has to say "17" while showing none of them, or collapsing hides the fact that
        // there is anything there at all.
        const shown = visibleSubjectGroups(groups, { threads: true }, false);
        const threads = shown.find((g) => g.key === "threads")!;
        expect(threads.items).toEqual([]);
        expect(threads.count).toBe(2);
        expect(threads.collapsed).toBe(true);
    });

    it("defaults records and archived to collapsed, and everything else to open", () => {
        const shown = visibleSubjectGroups(groups, {}, false);
        expect(shown.find((g) => g.key === "dossiers")!.collapsed).toBe(true);
        expect(shown.find((g) => g.key === "threads")!.collapsed).toBe(false);
        expect(shown.find((g) => g.key === "project:payments")!.collapsed).toBe(false);
    });

    it("lets an explicit choice beat the default in both directions", () => {
        const shown = visibleSubjectGroups(groups, { dossiers: false, threads: true }, false);
        expect(shown.find((g) => g.key === "dossiers")!.collapsed).toBe(false);
        expect(shown.find((g) => g.key === "threads")!.collapsed).toBe(true);
    });

    it("overrides collapse while filtering, so a query can reach a collapsed group", () => {
        // without this, typing a record's name returns visibly nothing and the search looks broken
        const shown = visibleSubjectGroups(groups, { dossiers: true }, true);
        const records = shown.find((g) => g.key === "dossiers")!;
        expect(records.collapsed).toBe(false);
        expect(records.items).toHaveLength(2);
    });

    it("contributes no items from a collapsed group, so keyboard nav cannot land on a hidden row", () => {
        // j/k walks the flattened item list; a hidden row in it would move the cursor somewhere invisible
        // and the debounced commit would then select it.
        const navIds = visibleSubjectGroups(groups, {}, false).flatMap((g) => g.items.map((i) => i.id));
        expect(navIds).not.toContain("task-418");
        expect(navIds).toEqual(["c1", "c2", "v1", "v2"]);
    });
});

describe("buildSubjectGroups archived threads", () => {
    it("files an archived thread under Archived, not Threads", () => {
        const groups = buildSubjectGroups({
            channels: [],
            dossiers: [],
            conversations: [convo("t1", "live question", []), { ...convo("t2", "put away", []), archived: true }],
            projectNameFor: () => "proj",
            spaceScope: null,
            spaceDossierId: null,
            revealed: false,
        } as SubjectInput);
        expect(groups.find((g) => g.key === "threads")?.items.map((i) => i.id)).toEqual(["t1"]);
        expect(groups.find((g) => g.key === "archived")?.items.map((i) => i.id)).toEqual(["t2"]);
    });

    it("counts archived channels and archived threads in one group", () => {
        // two "Archived" headers for two kinds would read as two different states
        const groups = buildSubjectGroups({
            channels: [ch("c1", "old", "proj", true)],
            dossiers: [],
            conversations: [{ ...convo("t2", "put away", []), archived: true }],
            projectNameFor: () => "proj",
            spaceScope: null,
            spaceDossierId: null,
            revealed: false,
        } as SubjectInput);
        const archived = groups.find((g) => g.key === "archived");
        // the count lives in the header's badge now, so the label stops carrying its own copy
        expect(archived?.label).toBe("Archived");
        expect(archived?.items.map((i) => i.kind)).toEqual(["channel", "conversation"]);
    });
});

describe("buildSubjectGroups", () => {
    it("groups channels by project, then threads, then records", () => {
        const groups = buildSubjectGroups(BASE);
        expect(groups.map((g) => g.label)).toEqual(["payments", "platform", "Threads", "Records"]);
    });

    it("keeps records after threads however many there are — the corpus must not push a fixed list down", () => {
        // the ordering *is* the fix: threads was last, so the one unbounded group sat above it and buried it.
        const many = Array.from({ length: 40 }, (_, i) => dos(`task-${i}`, `objective ${i}`, "completed"));
        const keys = buildSubjectGroups({ ...BASE, dossiers: many }).map((g) => g.key);
        expect(keys.indexOf("threads")).toBeLessThan(keys.indexOf("dossiers"));
    });

    it("tags every item with its kind and a stable id", () => {
        const groups = buildSubjectGroups(BASE);
        const records = groups.find((g) => g.key === "dossiers")!;
        expect(records.items.map((i) => i.kind)).toEqual(["dossier", "dossier"]);
        expect(records.items.map((i) => i.id)).toEqual(["task-418", "task-402"]);
    });

    it("carries a record's status and updated stamp onto its subject", () => {
        // the row draws a status chip and an age from these; the column used to read only .objective and
        // drop both, so a completed record was indistinguishable from an active one.
        const groups = buildSubjectGroups({
            ...BASE,
            dossiers: [dos("task-9", "Ship it", "completed", 1784695815473)],
        });
        expect(groups.find((g) => g.key === "dossiers")!.items[0]).toMatchObject({
            kind: "dossier",
            status: "completed",
            updated: 1784695815473,
        });
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
        expect(groups.map((g) => g.key)).toEqual(["threads", "dossiers"]);
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
        expect(groups.map((g) => g.key)).toEqual(["project:payments", "threads", "dossiers", "archived"]);
        expect(groups.at(-1)!.items.map((i) => i.id)).toEqual(["c2"]);
        expect(groups.at(-1)!.label).toBe("Archived");
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

describe("firstVisibleChannel", () => {
    it("returns null for an unloaded or empty list", () => {
        expect(firstVisibleChannel(null, null, false)).toBeNull();
        expect(firstVisibleChannel([], null, false)).toBeNull();
    });

    it("picks the first non-archived channel, preserving list order", () => {
        const channels = [ch("c2", "rate-limits", "platform", true), ch("c1", "checkout-revamp", "payments")];
        expect(firstVisibleChannel(channels, null, false)?.oid).toBe("c1");
    });

    it("returns null when every channel is archived", () => {
        const channels = [ch("c1", "checkout-revamp", "payments", true), ch("c2", "rate-limits", "platform", true)];
        expect(firstVisibleChannel(channels, null, false)).toBeNull();
    });

    it("honors the Space scope", () => {
        const channels = [ch("c1", "checkout-revamp", "payments"), ch("c2", "rate-limits", "platform")];
        const scope = { channeloids: ["c2"], tabids: [], runorefs: [] } as unknown as SpaceScope;
        expect(firstVisibleChannel(channels, scope, false)?.oid).toBe("c2");
        // scoped out entirely -> nothing visible
        expect(firstVisibleChannel(channels, { ...scope, channeloids: [] }, false)).toBeNull();
    });

    it("passes everything through when the Space is revealed", () => {
        const channels = [ch("c2", "rate-limits", "platform"), ch("c1", "checkout-revamp", "payments")];
        const scope = { channeloids: ["c1"], tabids: [], runorefs: [] } as unknown as SpaceScope;
        // revealed ignores the scope, so the first *active* channel wins, not the scoped-in one
        expect(firstVisibleChannel(channels, scope, true)?.oid).toBe("c2");
    });
});
