// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    eventFromActivity,
    eventFromResume,
    eventFromVolunteer,
    indexSignal,
    passFromActivity,
    passLine,
    recallLine,
} from "./petjoin";

function status(over: Partial<EmbedIndexStatus>): EmbedIndexStatus {
    return { state: "ok", enabled: true, haskey: true, indexednodes: 0, vaultnodes: 0, stalenodes: 0, ...over };
}

function activity(over: Partial<MemoryActivityData>): MemoryActivityData {
    return { kind: "sweep", id: "a1", ts: 1_700_000_000_000, ...over };
}

describe("indexSignal", () => {
    it("narrows each state the backend can report", () => {
        expect(indexSignal(status({ state: "ok" }))).toEqual({ state: "ok" });
        expect(indexSignal(status({ state: "off" }))).toEqual({ state: "off" });
        expect(indexSignal(status({ state: "stale" }))).toEqual({ state: "stale" });
    });

    // the important one: an unknown state must not read as healthy, or a future backend state would
    // silently present as "recall is fine" — the exact failure rank 1 exists to expose.
    it("yields no signal for an unrecognised state rather than defaulting to ok", () => {
        expect(indexSignal(status({ state: "rebuilding" }))).toBeUndefined();
        expect(indexSignal(status({ state: "" }))).toBeUndefined();
    });

    it("yields no signal when the read failed entirely", () => {
        expect(indexSignal(null)).toBeUndefined();
        expect(indexSignal(undefined)).toBeUndefined();
    });
});

describe("recallLine", () => {
    it("distinguishes never-read from read-and-healthy", () => {
        expect(recallLine(null)).toEqual({ text: "not read yet", dim: true });
        expect(recallLine(status({ state: "ok", indexednodes: 373 }))).toEqual({
            text: "ok · 373 indexed",
            dim: false,
        });
    });

    it("names why recall is degraded, which is the diagnostic the register exists for", () => {
        expect(recallLine(status({ state: "off", reason: "disabled" })).text).toBe("off — embeddings are turned off");
        expect(recallLine(status({ state: "off", reason: "no-key" })).text).toBe("off — no API key configured");
        expect(recallLine(status({ state: "stale", reason: "model-mismatch" })).text).toBe(
            "stale — indexed with a different model"
        );
    });

    it("carries the drift count when staleness is measurable", () => {
        expect(recallLine(status({ state: "stale", reason: "content-drift", stalenodes: 7 })).text).toBe(
            "stale — notes have changed since indexing (7)"
        );
    });

    // a reason this build has never been taught is still more useful than silence
    it("falls through to the raw reason rather than swallowing an unknown one", () => {
        expect(recallLine(status({ state: "off", reason: "quota-exhausted" })).text).toBe("off — quota-exhausted");
    });

    it("reports a bare state when no reason came back", () => {
        expect(recallLine(status({ state: "stale" })).text).toBe("stale");
    });
});

describe("eventFromActivity — a pass carries its products or is not said", () => {
    it("maps a gardener sweep, carrying the archived count", () => {
        const e = eventFromActivity(activity({ kind: "sweep", archived: 12 }));
        expect(e).toMatchObject({ id: "a1", at: 1_700_000_000_000, kind: "sweep" });
        expect(e?.text).toBe("I tidied the vault — 12 notes archived.");
    });

    it("names what a pass wrote and offers each note as a source", () => {
        const ev = eventFromActivity(
            activity({
                kind: "distill-batch",
                sessions: 8,
                committed: 3,
                notes: [
                    { id: "prefer-tailwind-ab12", title: "prefer tailwind over scss" },
                    { id: "cgo-header-path-cd34", title: "cgo needs a windows include path" },
                    { id: "no-jsdom-tests-ef56", title: "no jsdom render tests" },
                ],
            })
        );
        expect(ev?.text).toBe("I went back over 8 sessions and wrote down 3 things.");
        expect(ev?.sources?.map((s) => s.ref)).toEqual([
            "memnote:prefer-tailwind-ab12",
            "memnote:cgo-header-path-cd34",
            "memnote:no-jsdom-tests-ef56",
        ]);
        expect(ev?.sources?.[0].title).toBe("prefer tailwind over scss");
        expect(ev?.sources?.[0].sourceType).toBe("memory");
    });

    // the pass is still REPORTED — petsources records it for the peek's last-pass row — it just does not
    // become an utterance, because "I did some work" carries nothing to open
    it("says nothing at all for a pass that wrote nothing", () => {
        expect(eventFromActivity(activity({ kind: "distill-batch", sessions: 8, notes: [] }))).toBeNull();
        expect(eventFromActivity(activity({ kind: "distill-batch", sessions: 8 }))).toBeNull();
    });

    it("singularises a count of one", () => {
        expect(eventFromActivity(activity({ kind: "sweep", archived: 1 }))?.text).toContain("1 note ");
        const one = eventFromActivity(
            activity({ kind: "distill-batch", sessions: 1, notes: [{ id: "x-ab12", title: "x" }] })
        );
        expect(one?.text).toBe("I went back over 1 session and wrote down 1 thing.");
    });

    it("falls back to unnumbered wording when the pass reports no session count", () => {
        const e = eventFromActivity(activity({ kind: "distill-batch", notes: [{ id: "x", title: "x" }] }));
        expect(e?.text).toBe("I went back over your recent sessions and wrote down 1 thing.");
    });

    it("rejects a kind the creature has no register for, including the retired notes-written", () => {
        expect(eventFromActivity(activity({ kind: "reindexed" }))).toBeNull();
        expect(eventFromActivity(activity({ kind: "notes-written", committed: 3 }))).toBeNull();
    });

    // without both, the watermark cannot order the event, so it would either re-speak forever or
    // suppress everything after it.
    it("rejects an event with no stable id or no timestamp", () => {
        expect(eventFromActivity(activity({ id: "" }))).toBeNull();
        expect(eventFromActivity(activity({ ts: 0 }))).toBeNull();
        expect(eventFromActivity(null)).toBeNull();
    });

    it("does not mark activity as already reported by the condition register", () => {
        expect(eventFromActivity(activity({ kind: "sweep", archived: 4 }))?.reportedAsCondition).toBeUndefined();
    });
});

describe("eventFromResume", () => {
    const card: ResumeCardData = {
        taskId: "t1",
        summary: "  paused at the migration step  ",
        status: "blocked",
        updated: 1_700_000_000_500,
    };

    it("speaks the narrative, trimmed", () => {
        const e = eventFromResume({ card, runoref: "run:abc" });
        expect(e?.kind).toBe("resume");
        expect(e?.at).toBe(1_700_000_000_500);
        expect(e?.text).toBe("Where we were — paused at the migration step");
    });

    // stability is the whole point: an id derived from the read time would re-say the same narrative on
    // every launch, which is the opposite of push-once.
    it("derives an id that is stable across reads and changes only with a new narrative", () => {
        const a = eventFromResume({ card, runoref: "run:abc" });
        const b = eventFromResume({ card, runoref: "run:abc" });
        expect(a?.id).toBe(b?.id);
        const later = eventFromResume({ card: { ...card, updated: 1_700_000_001_000 }, runoref: "run:abc" });
        expect(later?.id).not.toBe(a?.id);
    });

    it("falls back to the task id when no run oref came back", () => {
        expect(eventFromResume({ card })?.id).toContain("t1");
    });

    it("stays silent on an absent, empty or undatable narrative", () => {
        expect(eventFromResume({})).toBeNull();
        expect(eventFromResume(null)).toBeNull();
        expect(eventFromResume({ card: { ...card, summary: "   " } })).toBeNull();
        expect(eventFromResume({ card: { ...card, updated: 0 } })).toBeNull();
    });
});

describe("eventFromVolunteer", () => {
    const base: VolunteerData = {
        class: "loose-end",
        id: "loose-end:task-a:900",
        at: 900,
        title: "Finish the migration",
        text: "untouched for 21 days",
        sourcetype: "dossier",
        ref: "task:task-a",
    };

    // volunteered knowledge points at exactly one thing, so its `sources` list has exactly one entry — the
    // field is a list because a distillation pass carries several, not because this register ever does
    it("maps a payload to an utterance carrying its one source", () => {
        const ev = eventFromVolunteer(base);
        expect(ev).not.toBeNull();
        expect(ev!.kind).toBe("loose-end");
        expect(ev!.at).toBe(900);
        expect(ev!.text).toContain("Finish the migration");
        expect(ev!.sources).toEqual([
            {
                ref: "task:task-a",
                anchor: undefined,
                title: "Finish the migration",
                sourceType: "dossier",
            },
        ]);
    });

    it("carries an anchor through so a decision can name its card", () => {
        const ev = eventFromVolunteer({ ...base, class: "recall", ref: "task:task-p", anchor: "dec-abc123" });
        expect(ev!.sources?.[0].anchor).toBe("dec-abc123");
    });

    // a payload the backend could not address is still worth saying; it just grows no Open button
    it("keeps an utterance with no ref but leaves it sourceless", () => {
        const ev = eventFromVolunteer({ ...base, ref: "" });
        expect(ev).not.toBeNull();
        expect(ev!.sources).toBeUndefined();
    });

    it("rejects an unknown class rather than inventing a label", () => {
        expect(eventFromVolunteer({ ...base, class: "made-up" })).toBeNull();
    });

    it("rejects a payload with no stable id or no timestamp", () => {
        expect(eventFromVolunteer({ ...base, id: "" })).toBeNull();
        expect(eventFromVolunteer({ ...base, at: 0 })).toBeNull();
    });

    it("rejects an empty payload rather than speaking a blank bubble", () => {
        expect(eventFromVolunteer({ ...base, title: "  ", text: "  " })).toBeNull();
        expect(eventFromVolunteer(null)).toBeNull();
        expect(eventFromVolunteer(undefined)).toBeNull();
    });

    // the ledger register reports the state of your work, so its payload carries a run source
    it("maps the ledger class to an utterance with a run source", () => {
        const ev = eventFromVolunteer({
            class: "ledger",
            id: "shipped:run-1",
            at: 900,
            title: "shipped: ask bridge",
            text: "landed, changed 12 files",
            sourcetype: "run",
            ref: "run:run-1",
        });
        expect(ev?.kind).toBe("ledger");
        expect(ev?.text).toBe("shipped: ask bridge - landed, changed 12 files");
        expect(ev?.sources?.[0].ref).toBe("run:run-1");
    });
});

describe("passFromActivity", () => {
    it("records a pass with what it covered and what it wrote", () => {
        expect(
            passFromActivity(
                activity({ kind: "distill-batch", ts: 1000, sessions: 8, notes: [{ id: "x", title: "x" }] })
            )
        ).toEqual({ at: 1000, sessions: 8, written: 1 });
    });

    it("records a barren pass rather than dropping it — that is the whole point of the row", () => {
        expect(passFromActivity(activity({ kind: "distill-batch", ts: 1000, sessions: 8 }))).toEqual({
            at: 1000,
            sessions: 8,
            written: 0,
        });
    });

    it("ignores a sweep, which is a different pass with its own utterance", () => {
        expect(passFromActivity(activity({ kind: "sweep", ts: 1, archived: 2 }))).toBeNull();
        expect(passFromActivity(null)).toBeNull();
    });
});

describe("passLine", () => {
    it("says so plainly when a pass wrote nothing", () => {
        expect(passLine({ at: 1_000_000, sessions: 8, written: 0 }, 1_000_000 + 18 * 60_000)).toBe(
            "18m ago · 8 sessions · nothing written"
        );
    });

    it("counts what a productive pass wrote", () => {
        expect(passLine({ at: 1_000_000, sessions: 8, written: 3 }, 1_000_000 + 18 * 60_000)).toBe(
            "18m ago · 8 sessions · 3 notes written"
        );
    });

    it("singularises one session and one note", () => {
        expect(passLine({ at: 1_000_000, sessions: 1, written: 1 }, 1_000_000 + 18 * 60_000)).toBe(
            "18m ago · 1 session · 1 note written"
        );
    });

    it("reads as not-read-yet when no pass has been seen", () => {
        expect(passLine(null, 0)).toBe("not read yet");
    });
});

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import {
    agentFinishedFromDiff,
    askAgent,
    eventFromAsk,
    eventFromNotify,
    shouldSpeakAsk,
    type AskGateCtx,
} from "./petjoin";

function notify(over: Partial<NotifyCommandData> = {}): NotifyCommandData {
    return { title: "build finished", message: "all 214 tests green", level: "info", ...over };
}

describe("eventFromNotify", () => {
    it("turns a notification into an event: title is the utterance, message is the detail", () => {
        const e = eventFromNotify(notify(), 1000, 1);
        expect(e).toEqual({
            id: "notify:1000:1",
            at: 1000,
            kind: "notify",
            text: "build finished",
            detail: "all 214 tests green",
        });
    });

    it("ignores a missing or empty title", () => {
        expect(eventFromNotify(null, 1000, 1)).toBeNull();
        expect(eventFromNotify(notify({ title: "" }), 1000, 1)).toBeNull();
    });

    it("leaves detail unset when there is no message", () => {
        expect(eventFromNotify(notify({ message: "" }), 1000, 2)?.detail).toBeUndefined();
    });
});

function ask(over: Partial<AgentAskData> = {}): AgentAskData {
    return {
        oref: "block:abc",
        askid: "ask-1",
        ts: 2000,
        questions: [{ question: "which rollout approach?", header: "Rollout", options: [] }],
        ...over,
    };
}

describe("eventFromAsk", () => {
    it("turns a raised ask into an event keyed by askid", () => {
        expect(eventFromAsk(ask())).toEqual({
            event: { id: "ask:ask-1", at: 2000, kind: "ask", text: "which rollout approach?", ref: "block:abc" },
        });
    });

    it("a cleared ask yields a cancel id, never an event", () => {
        expect(eventFromAsk(ask({ cleared: true }))).toEqual({ cancelId: "ask:ask-1" });
    });

    it("an ask with no questions, or no data at all, yields nothing", () => {
        expect(eventFromAsk(ask({ questions: [] }))).toEqual({});
        expect(eventFromAsk(null)).toEqual({});
    });
});

describe("askAgent", () => {
    it("finds the roster agent whose block matches the ask oref", () => {
        const agents = [{ id: "tab1", name: "radar-triage", blockId: "abc" } as unknown as AgentVM];
        expect(askAgent(agents, "block:abc")?.id).toBe("tab1");
    });

    it("yields undefined when nothing matches", () => {
        expect(askAgent([], "block:abc")).toBeUndefined();
    });
});

function gateCtx(over: Partial<AskGateCtx> = {}): AskGateCtx {
    return { surface: "jarvis", focusTabId: undefined, askTabId: undefined, focusedBlockId: null, ...over };
}

describe("shouldSpeakAsk", () => {
    it("suppresses when keyboard focus is inside the ask's block", () => {
        expect(shouldSpeakAsk("block:abc", gateCtx({ focusedBlockId: "abc" }))).toBe(false);
    });

    it("suppresses on the agent surface when that agent is focused", () => {
        expect(shouldSpeakAsk("block:abc", gateCtx({ surface: "agent", focusTabId: "tab1", askTabId: "tab1" }))).toBe(
            false
        );
    });

    it("speaks when a different agent is focused", () => {
        expect(shouldSpeakAsk("block:abc", gateCtx({ surface: "agent", focusTabId: "tab2", askTabId: "tab1" }))).toBe(
            true
        );
    });

    it("speaks when the ask's agent is not on the roster", () => {
        expect(
            shouldSpeakAsk("block:abc", gateCtx({ surface: "agent", focusTabId: "tab1", askTabId: undefined }))
        ).toBe(true);
    });

    it("speaks when there is no oref to match against", () => {
        expect(shouldSpeakAsk(undefined, gateCtx({ focusedBlockId: "abc" }))).toBe(true);
    });
});

function bg(over: Partial<BackgroundAgentData> = {}): BackgroundAgentData {
    return {
        sessionid: "s1",
        cwd: "/x",
        kind: "background",
        name: "radar-triage",
        state: "working",
        startedts: 1,
        ...over,
    };
}

describe("agentFinishedFromDiff", () => {
    it("reports a background agent that disappeared between polls", () => {
        expect(agentFinishedFromDiff([bg()], [], new Set(), 3000)).toEqual([
            { id: "bgdone:s1:3000", at: 3000, kind: "bg-agent-done", text: "radar-triage finished" },
        ]);
    });

    it("ignores agents still present", () => {
        expect(agentFinishedFromDiff([bg()], [bg()], new Set(), 3000)).toEqual([]);
    });

    it("ignores dismissed ids", () => {
        expect(agentFinishedFromDiff([bg()], [], new Set(["s1"]), 3000)).toEqual([]);
    });

    it("ignores non-background entries", () => {
        expect(agentFinishedFromDiff([bg({ kind: "agent" })], [], new Set(), 3000)).toEqual([]);
    });

    it("never reports on a first load (empty prev)", () => {
        expect(agentFinishedFromDiff([], [bg()], new Set(), 3000)).toEqual([]);
    });

    it("falls back to a generic name when the agent has none", () => {
        expect(agentFinishedFromDiff([bg({ name: "" })], [], new Set(), 3000)[0]?.text).toBe(
            "A background agent finished"
        );
    });
});
