import { describe, expect, it } from "vitest";
import {
    canSend,
    copyText,
    ctaLabel,
    picksPayload,
    scanButton,
    scanHead,
    workflowView,
    type PickDraft,
    type WorkflowCard,
    type WorkflowView,
} from "./workflowlens";

const DAY_MS = 24 * 60 * 60 * 1000;
const OCT_26 = new Date(2026, 9, 26, 12).getTime();

function quote(n: number): WorkflowScanQuote {
    return { runid: `run${n}-0000-0000`, project: "waveterm", date: "2026-10-2" + (n % 10), text: `quote number ${n}` };
}

function pattern(id: string, runs: number, quotes = 3): WorkflowScanPattern {
    return {
        id,
        title: `pattern ${id}`,
        fixtarget: "AGENTS.md · Plans",
        runs,
        days: 2,
        projects: [{ name: "waveterm", runs }],
        quotes: Array.from({ length: quotes }, (_, i) => quote(i + 1)),
    };
}

function suggest(id: string, extra: Partial<WorkflowScanVerdict> = {}): WorkflowScanVerdict {
    return {
        id,
        verdict: "suggest",
        file: "AGENTS.md",
        where: "Plans the engine runs",
        fixproject: "waveterm",
        edit: "+ add this line",
        ...extra,
    };
}

function scan(extra: Partial<WorkflowScan> = {}): WorkflowScan {
    return {
        state: "picking",
        stage: "checking",
        project: "waveterm",
        windowdays: 14,
        fromts: OCT_26 - 14 * DAY_MS,
        tots: OCT_26,
        runs: 47,
        projects: 4,
        candidates: 7,
        kept: 3,
        dropped: 0,
        survivors: [pattern("p1", 11), pattern("p2", 4), pattern("p3", 4)],
        underfloor: [pattern("u1", 2)],
        verdicts: [suggest("p1"), { id: "p2", verdict: "covered", note: "8bc284e7" }, suggest("p3")],
        ...extra,
    };
}

function run(ws: WorkflowScan | undefined, status = "executing", extra: Partial<Run> = {}): Run {
    return {
        otype: "run",
        oid: "scan-run",
        version: 1,
        meta: {},
        id: "scan-run",
        goal: "Workflow scan",
        workspaceid: "ws",
        projectpath: "C:/repo",
        status,
        phases: [],
        createdts: OCT_26,
        channeloid: "chan-1",
        workflowscan: ws,
        ...extra,
    };
}

function home(name = "waveterm"): Channel {
    return { otype: "channel", oid: "chan-1", version: 1, meta: {}, name, createdts: 0 };
}

function picking(v: WorkflowView): Extract<WorkflowView, { kind: "picking" }> {
    if (v.kind !== "picking") {
        throw new Error(`expected picking, got ${v.kind}`);
    }
    return v;
}

describe("workflowView: the state mapping", () => {
    it("is idle with no last line when there is no scan run", () => {
        expect(workflowView(null, {})).toEqual({ kind: "idle" });
        expect(workflowView(run(undefined), {})).toEqual({ kind: "idle" });
    });

    it("maps each record state of a live run", () => {
        expect(workflowView(run(scan({ state: "scanning", stage: "read" })), {}).kind).toBe("scanning");
        expect(workflowView(run(scan({ state: "picking" })), {}).kind).toBe("picking");
        expect(workflowView(run(scan({ state: "applying" })), {}).kind).toBe("applying");
    });

    it("shows a failed scan as idle with its last line and error", () => {
        const v = workflowView(run(scan({ state: "failed", error: "no json block" }), "done"), {});
        expect(v).toEqual({ kind: "idle", last: { date: "10-26", outcome: "failed", error: "no json block" } });
    });

    it("shows a cancelled run as idle whatever its record state", () => {
        for (const state of ["scanning", "picking", "applying"]) {
            const v = workflowView(run(scan({ state }), "cancelled"), {});
            expect(v).toEqual({ kind: "idle", last: { date: "10-26", outcome: "cancelled" } });
        }
    });

    it("shows a run that died mid-scan as failed, not scanning", () => {
        const v = workflowView(run(scan({ state: "scanning", stage: "patterns" }), "failed"), {});
        expect(v).toEqual({ kind: "idle", last: { date: "10-26", outcome: "failed" } });
    });

    it("dates the last line from the run's completion when it has one", () => {
        const v = workflowView(run(scan(), "cancelled", { completedts: OCT_26 + DAY_MS }), {});
        expect(v).toEqual({ kind: "idle", last: { date: "10-27", outcome: "cancelled" } });
    });

    it("is done with one row per pick and the run's commit", () => {
        const ws = scan({
            state: "applying",
            picks: [
                { id: "p1", pick: "apply" },
                { id: "p3", pick: "drop", reason: "noise" },
            ],
        });
        const v = workflowView(run(ws, "done", { endcommit: "abc123def456" }), {});
        expect(v).toEqual({
            kind: "done",
            commit: "abc123def456",
            rows: [
                { tag: "applied", title: "pattern p1", file: "AGENTS.md" },
                { tag: "declined", title: "pattern p3", file: "docs/deferred.md" },
            ],
        });
    });

    it("is nothing-to-suggest when a done run has no suggest verdict", () => {
        const ws = scan({
            verdicts: [
                { id: "p1", verdict: "covered", note: "f93850e9" },
                { id: "p2", verdict: "declined", declinedat: 4 },
                { id: "p3", verdict: "covered", note: "AGENTS.md" },
            ],
        });
        const v = workflowView(run(ws, "done"), {});
        expect(v).toEqual({
            kind: "nothing",
            covered: [
                { tag: "covered", title: "pattern p1", fact: "11 runs · f93850e9" },
                { tag: "covered", title: "pattern p3", fact: "4 runs · AGENTS.md" },
            ],
            declined: [{ tag: "declined", title: "pattern p2", fact: "4 runs · not past 4" }],
            underFloor: [{ tag: "under", title: "pattern u1", fact: "2 runs · 2 days" }],
        });
    });

    it("gives picking the covered, declined and under-floor rows beside the cards", () => {
        const v = picking(workflowView(run(scan()), {}));
        expect(v.cards.map((c) => c.id)).toEqual(["p1", "p3"]);
        expect(v.covered).toEqual([{ tag: "covered", title: "pattern p2", fact: "4 runs · 8bc284e7" }]);
        expect(v.declined).toEqual([]);
        expect(v.underFloor).toHaveLength(1);
    });
});

describe("workflowView: stage phases", () => {
    const phases = (stage: string) => {
        const v = workflowView(run(scan({ state: "scanning", stage })), {});
        return v.kind === "scanning" ? v.stages : [];
    };

    it("has the five rows of the Running board", () => {
        expect(phases("read").map((s) => s.label)).toEqual([
            "Read runs",
            "Sonnet patterns",
            "Recount",
            "Opus checks files",
            "Your picks",
        ]);
    });

    it("marks every row before the stage done, the stage now, and the rest todo", () => {
        expect(phases("read").map((s) => s.phase)).toEqual(["now", "todo", "todo", "todo", "todo"]);
        expect(phases("patterns").map((s) => s.phase)).toEqual(["done", "now", "todo", "todo", "todo"]);
        expect(phases("recount").map((s) => s.phase)).toEqual(["done", "done", "now", "todo", "todo"]);
        expect(phases("checking").map((s) => s.phase)).toEqual(["done", "done", "done", "now", "todo"]);
    });

    it("shows a row's count once it is done", () => {
        expect(phases("checking").map((s) => s.fact)).toEqual(["47 runs · 4 projects", "7", "3 kept", "", ""]);
        expect(phases("patterns")[1].fact).toBe("");
    });

    it("names the blocks cut for size on the read row", () => {
        const v = workflowView(run(scan({ state: "scanning", stage: "patterns", dropped: 5 })), {});
        expect(v.kind === "scanning" && v.stages[0].fact).toBe("47 runs · 4 projects · 5 cut for size");
    });

    it("has every row done while the agent applies the picks", () => {
        const v = workflowView(run(scan({ state: "applying" })), {});
        expect(v.kind === "applying" && v.stages.map((s) => s.phase)).toEqual(["done", "done", "done", "done", "done"]);
    });
});

describe("workflowView: cards", () => {
    it("shows the first 2 quotes and keeps the rest behind more", () => {
        const v = picking(workflowView(run(scan({ survivors: [pattern("p1", 5, 5), pattern("p3", 3, 2)] })), {}));
        expect(v.cards[0].quotes.map((q) => q.text)).toEqual(["quote number 1", "quote number 2"]);
        expect(v.cards[0].more.map((q) => q.text)).toEqual(["quote number 3", "quote number 4", "quote number 5"]);
        expect(v.cards[1].quotes).toHaveLength(2);
        expect(v.cards[1].more).toEqual([]);
    });

    it("sets elsewhere only when the fix project is not the scan's", () => {
        const ws = scan({ verdicts: [suggest("p1"), suggest("p3", { fixproject: "cyber_assistant" })] });
        const v = picking(workflowView(run(ws), {}));
        expect(v.cards[0].elsewhere).toBeUndefined();
        expect(v.cards[1].elsewhere).toBe("cyber_assistant");
    });

    it("compares projects as the server does, ignoring case and outer spaces", () => {
        const ws = scan({ verdicts: [suggest("p1", { fixproject: " WaveTerm " }), suggest("p3")] });
        expect(picking(workflowView(run(ws), {})).cards[0].elsewhere).toBeUndefined();
    });

    it("tags a declined pattern raised again with its old and new counts", () => {
        const ws = scan({ verdicts: [suggest("p1", { declinedat: 4 }), suggest("p3")] });
        const v = picking(workflowView(run(ws), {}));
        expect(v.cards[0].raisedAgain).toEqual({ declinedAt: 4, now: 11 });
        expect(v.cards[1].raisedAgain).toBeUndefined();
    });

    it("splits the drafted edit into signed lines", () => {
        const ws = scan({ verdicts: [suggest("p1", { edit: "- old line\n+ new line\n+second\n" }), suggest("p3")] });
        const v = picking(workflowView(run(ws), {}));
        expect(v.cards[0].edit).toEqual([
            { sign: "-", text: "old line" },
            { sign: "+", text: "new line" },
            { sign: "+", text: "second" },
        ]);
    });

    it("carries the drafted picks in picking and the stored picks in applying", () => {
        const drafts: Record<string, PickDraft> = { p1: { pick: "drop", reason: "noise" } };
        expect(picking(workflowView(run(scan()), drafts)).cards[0]).toMatchObject({ pick: "drop", reason: "noise" });
        const applying = workflowView(run(scan({ state: "applying", picks: [{ id: "p3", pick: "apply" }] })), drafts);
        expect(applying.kind === "applying" && applying.cards.map((c) => c.pick)).toEqual([undefined, "apply"]);
    });
});

describe("scanHead", () => {
    it("names the scan's day, window, runs and projects", () => {
        expect(scanHead(run(scan()))).toEqual({ title: "Scan of 10-26", span: "10-12 → 10-26 · 47 runs · 4 projects" });
    });
});

function cards(): WorkflowCard[] {
    const ws = scan({
        survivors: [pattern("p1", 11), pattern("p2", 4), pattern("p3", 4)],
        verdicts: [suggest("p1"), suggest("p2"), suggest("p3", { fixproject: "cyber_assistant" })],
    });
    return picking(workflowView(run(ws), {})).cards;
}

describe("ctaLabel", () => {
    it("reads as the board's for 2 apply and 1 drop", () => {
        const picks: Record<string, PickDraft> = {
            p1: { pick: "apply", reason: "" },
            p2: { pick: "apply", reason: "" },
            p3: { pick: "drop", reason: "" },
        };
        expect(ctaLabel(cards(), picks)).toBe("Apply 2, decline 1");
    });

    it("leads with the decline when only drops are picked", () => {
        expect(ctaLabel(cards(), { p1: { pick: "drop", reason: "x" } })).toBe("Decline 1");
    });

    it("is empty when nothing is picked", () => {
        expect(ctaLabel(cards(), {})).toBe("");
        expect(ctaLabel(cards(), { p1: { reason: "typed then unpicked" } })).toBe("");
    });

    it("never counts an apply on a fix in another project", () => {
        expect(ctaLabel(cards(), { p3: { pick: "apply", reason: "" } })).toBe("");
    });
});

describe("canSend", () => {
    it("is false while a drop has no reason", () => {
        const picks: Record<string, PickDraft> = {
            p1: { pick: "apply", reason: "" },
            p2: { pick: "drop", reason: "  " },
        };
        expect(canSend(cards(), picks)).toBe(false);
        expect(canSend(cards(), { ...picks, p2: { pick: "drop", reason: "noise" } })).toBe(true);
    });

    it("is false when nothing is picked", () => {
        expect(canSend(cards(), {})).toBe(false);
    });
});

describe("picksPayload", () => {
    it("leaves unpicked cards and applies on another project's fix out", () => {
        const picks: Record<string, PickDraft> = {
            p1: { pick: "apply", reason: "stale" },
            p2: { pick: "drop", reason: " noise " },
            p3: { pick: "apply", reason: "" },
        };
        expect(picksPayload(cards(), picks)).toEqual([
            { id: "p1", pick: "apply" },
            { id: "p2", pick: "drop", reason: "noise" },
        ]);
    });

    it("keeps a drop on another project's fix", () => {
        expect(picksPayload(cards(), { p3: { pick: "drop", reason: "not ours" } })).toEqual([
            { id: "p3", pick: "drop", reason: "not ours" },
        ]);
    });
});

describe("copyText", () => {
    it("holds the file, where, and the edit lines", () => {
        const ws = scan({ verdicts: [suggest("p1", { edit: "- old\n+ new line" }), suggest("p3")] });
        const card = picking(workflowView(run(ws), {})).cards[0];
        expect(copyText(card)).toBe("AGENTS.md · Plans the engine runs\n- old\n+ new line");
    });

    it("leaves where out when the verdict has none", () => {
        const ws = scan({ verdicts: [suggest("p1", { where: "" }), suggest("p3")] });
        expect(copyText(picking(workflowView(run(ws), {})).cards[0])).toBe("AGENTS.md\n+ add this line");
    });
});

describe("scanButton", () => {
    const view = (r: Run | null) => workflowView(r, {});

    it("is enabled on idle, done, nothing and failed", () => {
        const done = run(scan({ picks: [{ id: "p1", pick: "apply" }] }), "done");
        const nothing = run(scan({ verdicts: [] }), "done");
        const failed = run(scan({ state: "failed", error: "x" }));
        for (const r of [null, done, nothing, failed]) {
            expect(scanButton(view(r), home())).toMatchObject({ enabled: true, channelId: "chan-1" });
        }
        expect(view(done).kind).toBe("done");
        expect(view(nothing).kind).toBe("nothing");
    });

    it("is enabled when a cancelled run was left scanning", () => {
        expect(scanButton(view(run(scan({ state: "scanning" }), "cancelled")), home()).enabled).toBe(true);
    });

    it("is disabled on scanning, picking and applying, saying why", () => {
        for (const state of ["scanning", "picking", "applying"]) {
            const b = scanButton(view(run(scan({ state }))), home());
            expect(b.enabled).toBe(false);
            expect(b.channelId).toBeUndefined();
            expect(b.title).not.toBe("");
        }
    });

    it("is disabled with no home project", () => {
        const b = scanButton(view(null), null);
        expect(b.enabled).toBe(false);
        expect(b.title).toMatch(/project/);
    });
});
