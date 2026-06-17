import { describe, expect, it } from "vitest";
import { sortAgents, askingCount, groupAgents, formatAge, agentVMFromInput, type AgentVM, type LiveAgentInput } from "./agentsviewmodel";

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
