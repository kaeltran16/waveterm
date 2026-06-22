import { describe, expect, it } from "vitest";
import { sortAgents, askingCount, groupAgents, formatAge, agentVMFromInput, withAsk, buildAskAnswers, canSubmitAsk, isQuiet, isRecentlyIdle, isAskStale, reorderList, snapToPreset, mergeOrder, nextAskId, usageLevel, formatTokens, formatReset, type AgentVM, type LiveAgentInput, type AgentAskQuestion } from "./agentsviewmodel";

const mk = (id: string, state: AgentVM["state"], extra: Partial<AgentVM> = {}): AgentVM => ({
    id,
    name: id,
    task: "",
    state,
    ...extra,
});

describe("sortAgents", () => {
    it("orders asking before working before idle", () => {
        const out = sortAgents([mk("a", "idle"), mk("b", "working"), mk("c", "asking")]);
        expect(out.map((a) => a.id)).toEqual(["c", "b", "a"]);
    });
    it("within asking, longest-blocked first", () => {
        const out = sortAgents([mk("a", "asking", { blockedMs: 60_000 }), mk("b", "asking", { blockedMs: 240_000 })]);
        expect(out.map((a) => a.id)).toEqual(["b", "a"]);
    });
    it("does not mutate the input array", () => {
        const input = [mk("a", "idle"), mk("b", "asking")];
        sortAgents(input);
        expect(input.map((a) => a.id)).toEqual(["a", "b"]);
    });
});

describe("askingCount", () => {
    it("counts only asking agents", () => {
        expect(askingCount([mk("a", "asking"), mk("b", "working"), mk("c", "asking")])).toBe(2);
    });
    it("is zero when none are asking", () => {
        expect(askingCount([mk("a", "idle"), mk("b", "working")])).toBe(0);
    });
});

describe("groupAgents", () => {
    it("splits into asking/working/idle, each sorted", () => {
        const s = groupAgents([mk("a", "idle"), mk("b", "asking", { blockedMs: 1_000 }), mk("c", "working"), mk("d", "asking", { blockedMs: 9_000 })]);
        expect(s.asking.map((a) => a.id)).toEqual(["d", "b"]);
        expect(s.working.map((a) => a.id)).toEqual(["c"]);
        expect(s.idle.map((a) => a.id)).toEqual(["a"]);
    });
});

describe("formatAge", () => {
    it("under a minute is 'just now'", () => {
        expect(formatAge(5_000)).toBe("just now");
        expect(formatAge(undefined)).toBe("just now");
    });
    it("minutes then hours", () => {
        expect(formatAge(240_000)).toBe("4m");
        expect(formatAge(7_200_000)).toBe("2h");
    });
});

describe("agentVMFromInput", () => {
    const NOW = 1_000_000;

    it("maps a working row: status->working, model label, activeMs from ts", () => {
        const input: LiveAgentInput = {
            id: "tab-1",
            name: "waveterm",
            status: "working",
            detail: "go test ./pkg/wconfig/…",
            model: "claude-sonnet-4-6",
            ts: NOW - 120_000,
            transcriptPath: "/p/t.jsonl",
        };
        expect(agentVMFromInput(input, NOW)).toEqual({
            id: "tab-1",
            name: "waveterm",
            task: "",
            state: "working",
            model: "sonnet",
            activity: "go test ./pkg/wconfig/…",
            activeMs: 120_000,
            transcriptPath: "/p/t.jsonl",
        });
    });

    it("maps a waiting row to the asking state with blockedMs", () => {
        const input: LiveAgentInput = { id: "tab-2", name: "loom", status: "waiting", model: "claude-opus-4-8", ts: NOW - 240_000 };
        const vm = agentVMFromInput(input, NOW);
        expect(vm.state).toBe("asking");
        expect(vm.blockedMs).toBe(240_000);
        expect(vm.activeMs).toBeUndefined();
        expect(vm.model).toBe("opus");
    });

    it("carries the agent identity through to the vm (drives projector selection)", () => {
        const vm = agentVMFromInput({ id: "tab-c", name: "siem", status: "working", agent: "codex", ts: NOW }, NOW);
        expect(vm.agent).toBe("codex");
    });

    it("maps anything else to idle, with no age field, and tolerates a missing ts", () => {
        const vm = agentVMFromInput({ id: "tab-3", name: "obsidian", status: "idle", detail: "stopped without asking" }, NOW);
        expect(vm.state).toBe("idle");
        expect(vm.activeMs).toBeUndefined();
        expect(vm.blockedMs).toBeUndefined();
        expect(vm.activity).toBe("stopped without asking");
        expect(vm.model).toBe("");
        expect(vm.idleSince).toBeUndefined();
    });

    it("stamps idleSince from ts for an idle row", () => {
        const vm = agentVMFromInput({ id: "tab-3", name: "obsidian", status: "idle", ts: NOW - 30_000 }, NOW);
        expect(vm.idleSince).toBe(NOW - 30_000);
    });

    it("carries the terminal blockId", () => {
        const vm = agentVMFromInput({ id: "tab-1", name: "x", status: "working", blockId: "uuid-1" }, NOW);
        expect(vm.blockId).toBe("uuid-1");
    });
});

describe("withAsk", () => {
    const NOW = 1_000_000;
    const baseWorking = (): AgentVM => ({
        id: "tab-1",
        name: "waveterm",
        task: "",
        state: "working",
        activity: "go test ./…",
        activeMs: 5_000,
    });

    it("flips a working agent to asking, clears activeMs, sets blockedMs from ts, maps questions", () => {
        const ask: AgentAskData = {
            oref: "block:abc",
            askid: "ask-1",
            questions: [
                {
                    question: "Guard the nil case?",
                    header: "Safety",
                    multiselect: false,
                    options: [{ label: "Yes" }, { label: "No", description: "risky" }],
                },
            ],
            ts: NOW - 60_000,
        };
        const vm = withAsk(baseWorking(), ask, NOW);
        expect(vm.state).toBe("asking");
        expect(vm.blockedMs).toBe(60_000);
        expect(vm.activeMs).toBeUndefined();
        expect(vm.ask?.askId).toBe("ask-1");
        expect(vm.ask?.questions).toHaveLength(1);
        expect(vm.ask?.questions[0].question).toBe("Guard the nil case?");
        expect(vm.ask?.questions[0].header).toBe("Safety");
        // multiselect (lowercase Go json tag) maps to multiSelect (camelCase)
        expect(vm.ask?.questions[0].multiSelect).toBe(false);
        expect(vm.ask?.questions[0].options).toEqual([{ label: "Yes", description: undefined }, { label: "No", description: "risky" }]);
    });

    it("carries an empty questions array when questions is absent", () => {
        const ask: AgentAskData = { oref: "block:abc", askid: "ask-2", ts: NOW - 10_000 };
        const vm = withAsk(baseWorking(), ask, NOW);
        expect(vm.state).toBe("asking");
        expect(vm.ask?.questions).toEqual([]);
    });

    it("returns the vm unchanged when ask is null or cleared", () => {
        expect(withAsk(baseWorking(), null, NOW)).toEqual(baseWorking());
        const cleared: AgentAskData = { oref: "block:abc", askid: "ask-1", cleared: true };
        expect(withAsk(baseWorking(), cleared, NOW)).toEqual(baseWorking());
    });
});

describe("buildAskAnswers", () => {
    const q = (multiSelect = false): AgentAskQuestion => ({
        question: "q",
        multiSelect,
        options: [{ label: "a" }, { label: "b" }, { label: "c" }],
    });

    it("emits one answer item per question, indexes sorted ascending", () => {
        const questions = [q(false), q(true)];
        const selections = { 0: new Set([1]), 1: new Set([2, 0]) };
        expect(buildAskAnswers(questions, selections)).toEqual([
            { selectedindexes: [1] },
            { selectedindexes: [0, 2] },
        ]);
    });

    it("emits empty indexes for an unanswered question", () => {
        expect(buildAskAnswers([q()], {})).toEqual([{ selectedindexes: [] }]);
    });
});

describe("canSubmitAsk", () => {
    const q = (): AgentAskQuestion => ({ question: "q", options: [{ label: "a" }] });

    it("true only when every question has at least one selection", () => {
        expect(canSubmitAsk([q(), q()], { 0: new Set([0]), 1: new Set([0]) })).toBe(true);
        expect(canSubmitAsk([q(), q()], { 0: new Set([0]) })).toBe(false);
        expect(canSubmitAsk([], {})).toBe(false);
    });
});

describe("isQuiet", () => {
    it("true past the threshold, false within it or when activity is unknown", () => {
        expect(isQuiet(1_000, 1_000 + 46_000)).toBe(true);
        expect(isQuiet(1_000, 1_000 + 10_000)).toBe(false);
        expect(isQuiet(undefined, 99_999)).toBe(false);
    });
});

describe("isRecentlyIdle", () => {
    const NOW = 1_000_000;

    it("true for an idle agent within the grace window", () => {
        expect(isRecentlyIdle(mk("a", "idle", { idleSince: NOW - 60_000 }), NOW)).toBe(true);
    });
    it("false once past the grace window", () => {
        expect(isRecentlyIdle(mk("a", "idle", { idleSince: NOW - 360_000 }), NOW)).toBe(false);
    });
    it("false for non-idle agents regardless of idleSince", () => {
        expect(isRecentlyIdle(mk("a", "working", { idleSince: NOW }), NOW)).toBe(false);
        expect(isRecentlyIdle(mk("a", "asking", { idleSince: NOW }), NOW)).toBe(false);
    });
    it("false when idleSince is missing", () => {
        expect(isRecentlyIdle(mk("a", "idle"), NOW)).toBe(false);
    });
    it("honors a custom grace window (boundary exclusive)", () => {
        expect(isRecentlyIdle(mk("a", "idle", { idleSince: NOW - 1_000 }), NOW, 1_000)).toBe(false);
        expect(isRecentlyIdle(mk("a", "idle", { idleSince: NOW - 999 }), NOW, 1_000)).toBe(true);
    });
});

describe("reorderList", () => {
    it("moves an id before/after a target", () => {
        expect(reorderList(["a", "b", "c"], "a", "c", false)).toEqual(["b", "c", "a"]);
        expect(reorderList(["a", "b", "c"], "c", "a", true)).toEqual(["c", "a", "b"]);
    });
    it("no-ops on self, or when an id is absent", () => {
        expect(reorderList(["a", "b"], "a", "a", true)).toEqual(["a", "b"]);
        expect(reorderList(["a", "b"], "z", "a", true)).toEqual(["a", "b"]);
    });
});

describe("isAskStale", () => {
    it("stale when a newer working/idle status supersedes the ask", () => {
        expect(isAskStale(1_000, 2_000, "working")).toBe(true);
        expect(isAskStale(1_000, 2_000, "idle")).toBe(true);
    });
    it("not stale while waiting, when status is not newer, or when a ts is missing", () => {
        expect(isAskStale(1_000, 2_000, "waiting")).toBe(false);
        expect(isAskStale(1_000, 1_000, "working")).toBe(false);
        expect(isAskStale(1_000, 500, "working")).toBe(false);
        expect(isAskStale(undefined, 2_000, "working")).toBe(false);
        expect(isAskStale(1_000, undefined, "working")).toBe(false);
    });
});

describe("mergeOrder", () => {
    it("seeds from ids when prev is empty", () => {
        expect(mergeOrder([], ["a", "b"])).toEqual(["a", "b"]);
    });
    it("keeps existing slots even when ids reorders them (the anchor)", () => {
        // 'a' jumped to the front of ids (e.g. it started asking) — it must NOT move slot
        expect(mergeOrder(["a", "b", "c"], ["b", "a", "c"])).toEqual(["a", "b", "c"]);
    });
    it("appends genuinely-new ids after the kept ones", () => {
        expect(mergeOrder(["a", "b"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    });
    it("drops ids no longer present", () => {
        expect(mergeOrder(["a", "b", "c"], ["a", "c"])).toEqual(["a", "c"]);
    });
    it("is a no-op when the set is unchanged", () => {
        expect(mergeOrder(["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
    });
});

describe("snapToPreset", () => {
    const ONE = 300;
    const TWO = 610; // 300*2 + 10 gap
    const FILL = 900; // measured viewport height feeding the "full" preset

    it("one-column widths snap to s (short) or m (tall) by nearest height", () => {
        expect(snapToPreset(ONE, 240, ONE, TWO, FILL)).toBe("s");
        expect(snapToPreset(ONE, 360, ONE, TWO, FILL)).toBe("m");
        expect(snapToPreset(ONE, 250, ONE, TWO, FILL)).toBe("s");
        expect(snapToPreset(ONE, 340, ONE, TWO, FILL)).toBe("m");
    });
    it("two-column widths snap to l when shorter than halfway to the viewport height", () => {
        expect(snapToPreset(TWO, 360, ONE, TWO, FILL)).toBe("l");
        expect(snapToPreset(TWO, 240, ONE, TWO, FILL)).toBe("l");
    });
    it("two-column widths snap to full when dragged near the viewport height", () => {
        expect(snapToPreset(TWO, FILL, ONE, TWO, FILL)).toBe("full");
        expect(snapToPreset(TWO, 800, ONE, TWO, FILL)).toBe("full"); // past the 630 midpoint
    });
    it("column span follows whichever of one-/two-column width is closer", () => {
        expect(snapToPreset(380, 240, ONE, TWO, FILL)).toBe("s"); // closer to one column
        expect(snapToPreset(540, 360, ONE, TWO, FILL)).toBe("l"); // closer to two columns
    });
});

describe("nextAskId", () => {
    it("returns the first when current is undefined", () => {
        expect(nextAskId(["x", "y", "z"], undefined)).toBe("x");
    });
    it("advances to the id after current", () => {
        expect(nextAskId(["x", "y", "z"], "x")).toBe("y");
    });
    it("wraps from the last back to the first", () => {
        expect(nextAskId(["x", "y", "z"], "z")).toBe("x");
    });
    it("returns the first when current is no longer present", () => {
        expect(nextAskId(["x", "y", "z"], "gone")).toBe("x");
    });
    it("returns undefined for an empty list", () => {
        expect(nextAskId([], "x")).toBeUndefined();
    });
});

describe("usageLevel", () => {
    it("bands by threshold (boundaries inclusive toward ok/warn)", () => {
        expect(usageLevel(0)).toBe("ok");
        expect(usageLevel(60)).toBe("ok");
        expect(usageLevel(60.1)).toBe("warn");
        expect(usageLevel(85)).toBe("warn");
        expect(usageLevel(85.1)).toBe("hot");
        expect(usageLevel(100)).toBe("hot");
    });
});

describe("formatTokens", () => {
    it("formats by magnitude", () => {
        expect(formatTokens(512)).toBe("512");
        expect(formatTokens(38_000)).toBe("38k");
        expect(formatTokens(142_000)).toBe("142k");
        expect(formatTokens(2_100_000)).toBe("2.1M");
        expect(formatTokens(1_000_000)).toBe("1.0M");
    });
});

describe("formatReset", () => {
    const NOW = 1_000_000_000_000; // ms
    const inMins = (m: number) => Math.floor(NOW / 1000) + m * 60;

    it("'now' at or past the reset", () => {
        expect(formatReset(Math.floor(NOW / 1000), NOW)).toBe("now");
        expect(formatReset(Math.floor(NOW / 1000) - 60, NOW)).toBe("now");
    });
    it("minutes under an hour", () => {
        expect(formatReset(inMins(44), NOW)).toBe("44m");
    });
    it("hours and minutes past an hour", () => {
        expect(formatReset(inMins(131), NOW)).toBe("2h 11m");
    });
});
