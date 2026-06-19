import { describe, expect, it } from "vitest";
import { sortAgents, askingCount, groupAgents, formatAge, agentVMFromInput, withAsk, buildAskAnswers, canSubmitAsk, isQuiet, isAskStale, resolveFocusedAskId, type AgentVM, type LiveAgentInput, type AgentAskQuestion } from "./agentsviewmodel";

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

    it("maps anything else to idle, with no age field, and tolerates a missing ts", () => {
        const vm = agentVMFromInput({ id: "tab-3", name: "obsidian", status: "idle", detail: "stopped without asking" }, NOW);
        expect(vm.state).toBe("idle");
        expect(vm.activeMs).toBeUndefined();
        expect(vm.blockedMs).toBeUndefined();
        expect(vm.activity).toBe("stopped without asking");
        expect(vm.model).toBe("");
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

describe("resolveFocusedAskId", () => {
    const a = (id: string): AgentVM => ({ id, name: id, task: "", state: "asking" }) as AgentVM;

    it("keeps the current focus if it's still asking", () => {
        expect(resolveFocusedAskId([a("x"), a("y")], "y")).toBe("y");
    });

    it("falls back to the first (oldest-blocked) asking agent otherwise", () => {
        expect(resolveFocusedAskId([a("x"), a("y")], "gone")).toBe("x");
        expect(resolveFocusedAskId([a("x")], undefined)).toBe("x");
        expect(resolveFocusedAskId([], "x")).toBe(undefined);
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
