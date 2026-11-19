import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { sentPromptsAtom } from "@/app/view/agents/agentsend";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { channelsAtom } from "@/app/view/agents/channelsstore";
import { liveEntriesByIdAtom } from "@/app/view/agents/livetranscriptatoms";
import type { ProjectRow } from "@/app/view/agents/projectsstore";
import { getAgentStatusAtom } from "@/app/view/agents/session-models/agentstatusstore";
import { shellTasksByIdAtom } from "@/app/view/agents/shelltasksstore";
import { PI_STOP_SETTLE_MS, stopAgent } from "@/app/view/agents/stopsend";
import { openBoardAsk } from "@/app/view/jarvis/openref";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_KIND, type AgentThing } from "./agent";
import { actionsFor } from "./types";

// the current project comes from the registered projects, which read config atoms tests never initialize
vi.mock("@/app/view/agents/projectsstore", async (orig) => {
    const { atom } = await import("jotai");
    return { ...(await orig<object>()), projectListAtom: atom<ProjectRow[]>([]) };
});

// the action's target is what it hands the router
vi.mock("@/app/view/jarvis/openref", async (orig) => ({ ...(await orig<object>()), openBoardAsk: vi.fn() }));

const vm = (over: Partial<AgentVM> = {}): AgentVM => ({
    id: "tab1",
    name: "loom",
    task: "",
    state: "working",
    blockId: "blk1",
    ...over,
});
const thing = (over: Partial<AgentVM> = {}, rest: Partial<Omit<AgentThing, "agent">> = {}): AgentThing => ({
    agent: vm(over),
    contextLevel: null,
    hasDiff: false,
    ...rest,
});
const applies = (id: string, t: AgentThing) => AGENT_KIND.actions.find((a) => a.id === id)!.applies(t);
const available = (t: AgentThing) =>
    Object.values(actionsFor(AGENT_KIND.actions, t).available)
        .flat()
        .map((a) => a.id);

describe("agent actions", () => {
    it("offers Answer only while asking", () => {
        expect(applies("agent:answer", thing({ state: "asking" }))).toBe(true);
        expect(applies("agent:answer", thing({ state: "working" }))).toBe(false);
        expect(applies("agent:answer", thing({ state: "idle" }))).toBe(false);
    });
    it("cannot interrupt, nudge or close a card without a terminal block", () => {
        const t = thing({ state: "idle", blockId: undefined });
        expect(applies("agent:interrupt", t)).toBe(false);
        expect(applies("agent:nudge", t)).toBe(false);
        expect(applies("agent:close", t)).toBe(false);
        expect(applies("agent:interrupt", thing())).toBe(true);
    });
    it("nudge applies only after an interrupted turn", () => {
        try {
            // no entries: nothing says the turn was cut short
            expect(applies("agent:nudge", thing({ state: "idle" }))).toBe(false);
            globalStore.set(liveEntriesByIdAtom, { tab1: [{ kind: "user", text: "go" }, { kind: "interrupted" }] });
            expect(applies("agent:nudge", thing({ state: "idle" }))).toBe(true);
            expect(applies("agent:nudge", thing({ state: "working" }))).toBe(false);
            expect(applies("agent:nudge", thing({ state: "asking" }))).toBe(false);
            globalStore.set(liveEntriesByIdAtom, {
                tab1: [{ kind: "interrupted" }, { kind: "user", text: "again" }, { kind: "message", text: "done" }],
            });
            expect(applies("agent:nudge", thing({ state: "idle" }))).toBe(false);
        } finally {
            globalStore.set(liveEntriesByIdAtom, {});
        }
    });
    it("reads an interrupt from the agent's previous info when nothing streams", () => {
        expect(applies("agent:nudge", thing({ state: "idle", previousInfo: [{ kind: "interrupted" }] }))).toBe(true);
    });
    it("does not nudge an idle agent standing by on a running shell task", () => {
        globalStore.set(shellTasksByIdAtom, { tab1: [{ id: "b1", kind: "shell", description: "dev server" }] });
        globalStore.set(liveEntriesByIdAtom, { tab1: [{ kind: "interrupted" }] });
        try {
            expect(applies("agent:nudge", thing({ state: "idle" }))).toBe(false);
        } finally {
            globalStore.set(shellTasksByIdAtom, {});
            globalStore.set(liveEntriesByIdAtom, {});
        }
    });
    it("backgrounds a working or asking agent and dismisses an idle one", () => {
        expect(available(thing({ state: "working" }))).toContain("agent:background");
        expect(available(thing({ state: "working" }))).not.toContain("agent:dismiss");
        expect(available(thing({ state: "asking" }))).toContain("agent:background");
        expect(available(thing({ state: "idle" }))).toContain("agent:dismiss");
        expect(available(thing({ state: "idle" }))).not.toContain("agent:background");
        const labels = Object.fromEntries(AGENT_KIND.actions.map((a) => [a.id, a.label]));
        expect(labels["agent:background"]).toBe("Move to background");
        expect(labels["agent:dismiss"]).toBe("Dismiss");
    });
    it("offers Compact and Clear only when the context level offers a reset", () => {
        const idle = { state: "idle" as const };
        expect(applies("agent:compact", thing(idle, { contextLevel: "warn" }))).toBe(true);
        expect(applies("agent:clear", thing(idle, { contextLevel: "hot" }))).toBe(true);
        expect(applies("agent:compact", thing(idle, { contextLevel: "ok" }))).toBe(false);
        // no usage reported yet: the rail shows no context line, so no reset
        expect(applies("agent:compact", thing(idle, { contextLevel: null }))).toBe(false);
        expect(applies("agent:compact", thing({ state: "working" }, { contextLevel: "hot" }))).toBe(false);
        expect(applies("agent:compact", thing({ ...idle, agent: "pi" }, { contextLevel: "hot" }))).toBe(false);
        expect(applies("agent:compact", thing({ ...idle, blockId: undefined }, { contextLevel: "hot" }))).toBe(false);
    });
    it("offers Review changes only when the card has a diff", () => {
        expect(applies("agent:review", thing({}, { hasDiff: true }))).toBe(true);
        expect(applies("agent:review", thing())).toBe(false);
    });
    it("lists what does not apply now", () => {
        const notNow = actionsFor(AGENT_KIND.actions, thing({ state: "working" })).notNow.map((a) => a.id);
        expect(notNow).toContain("agent:answer");
        expect(notNow).toContain("agent:nudge");
        expect(notNow).not.toContain("agent:open");
    });
    it("builds entries keyed and titled as the palette's agent rows", () => {
        const agents = [vm(), vm({ id: "tab2", name: "fern", task: "Fix race", usage: { contextpct: 90 } as any })];
        const get = ((a: unknown) => (a === model.agentsAtom ? agents : {})) as any;
        const model = { agentsAtom: {} } as any;
        const entries = AGENT_KIND.entries(get, model);
        expect(entries.map((e) => [e.key, e.title])).toEqual([
            ["agent:tab1", "loom"],
            ["agent:tab2", "fern — Fix race"],
        ]);
        expect(entries[0].thing.contextLevel).toBeNull();
        expect(entries[1].thing.contextLevel).toBe("hot");
    });
});

describe("agent Ask a board about this…", () => {
    const ask = AGENT_KIND.actions.find((a) => a.id === "agent:ask-board")!;
    const target = (t: AgentThing) => {
        vi.mocked(openBoardAsk).mockClear();
        void ask.run(t, { model: {} as any });
        const [, channelId, about] = vi.mocked(openBoardAsk).mock.calls[0] ?? [];
        return channelId == null ? null : { channelId, about };
    };
    const withChannels = (fn: () => void) => {
        globalStore.set(channelsAtom, [
            {
                oid: "ch-wt",
                otype: "channel",
                version: 1,
                name: "waveterm",
                projectpath: "C:\\work\\waveterm",
                createdts: 0,
            },
            { oid: "ch-siem", otype: "channel", version: 1, name: "siem", projectpath: "C:/work/siem", createdts: 0 },
        ] as Channel[]);
        try {
            fn();
        } finally {
            globalStore.set(channelsAtom, null);
        }
    };
    it("is listed under Open, labelled Ask a board about this…", () => {
        withChannels(() => {
            expect(ask.label).toBe("Ask a board about this…");
            expect(actionsFor(AGENT_KIND.actions, thing({ cwd: "C:/work/waveterm" })).available.open).toContain(ask);
        });
    });
    it("asks about the agent's own tab, carrying its runtime", () => {
        withChannels(() => {
            const t = (agent?: string) => thing({ cwd: "C:/work/waveterm", name: "claude · waveterm", agent });
            expect(target(t("codex"))).toEqual({
                channelId: "ch-wt",
                about: { kind: "agent", ref: "tab1", title: "claude · waveterm", runtime: "codex" },
            });
            expect(target(t())?.about.runtime).toBe("claude");
        });
    });
    it("finds the project by name when the cwd matches none", () => {
        withChannels(() => {
            expect(target(thing({ project: "siem" }))?.channelId).toBe("ch-siem");
        });
    });
    it("does not apply to a plain shell, a tabless agent, or with no project to ask in", () => {
        withChannels(() => {
            expect(ask.applies(thing({ cwd: "C:/work/waveterm", kind: "terminal" }))).toBe(false);
            expect(ask.applies(thing({ cwd: "C:/work/waveterm", blockId: undefined }))).toBe(false);
        });
        expect(ask.applies(thing({ cwd: "C:/work/waveterm" }))).toBe(false);
    });
});

describe("agent Interrupt", () => {
    const interrupt = AGENT_KIND.actions.find((a) => a.id === "agent:interrupt")!;
    const status = getAgentStatusAtom("block:blk1");
    let typed: string[];
    const report = (state: string) => globalStore.set(status, { state } as AgentStatusData);

    beforeEach(() => {
        vi.useFakeTimers();
        typed = [];
        vi.spyOn(RpcApi, "ControllerInputCommand").mockImplementation(async (_client, data) => {
            typed.push(atob(data.inputdata64));
        });
        report("working");
    });
    afterEach(() => {
        // ends any stop still waiting, so it cannot type into the next test
        vi.advanceTimersByTime(PI_STOP_SETTLE_MS);
        vi.useRealTimers();
        vi.restoreAllMocks();
        globalStore.set(sentPromptsAtom("blk1"), []);
    });
    const queueSteer = () =>
        globalStore.set(sentPromptsAtom("blk1"), [{ text: "also the call sites", ts: Date.now() }]);

    it("on a pi agent with a queued foot types Esc, then Enter once after its idle report", () => {
        queueSteer();
        void interrupt.run(thing({ agent: "pi" }), { model: {} as any });
        expect(typed).toEqual(["\x1b"]);
        report("idle");
        expect(typed).toEqual(["\x1b", "\r"]);
        report("working");
        report("idle");
        expect(typed).toEqual(["\x1b", "\r"]);
    });
    it("on a pi agent with an empty foot types Esc alone", () => {
        void interrupt.run(thing({ agent: "pi" }), { model: {} as any });
        report("idle");
        expect(typed).toEqual(["\x1b"]);
    });
    it("on a pi agent no longer working types Esc alone, its sends no longer waiting", () => {
        queueSteer();
        void interrupt.run(thing({ agent: "pi", state: "idle" }), { model: {} as any });
        report("idle");
        expect(typed).toEqual(["\x1b"]);
    });
    it("on a Claude agent types Esc alone, whatever the box sent", () => {
        queueSteer();
        void interrupt.run(thing({ agent: "claude" }), { model: {} as any });
        report("idle");
        expect(typed).toEqual(["\x1b"]);
    });
    it("a second Stop while the first waits leads to one Enter, from the palette or the shared stop", () => {
        queueSteer();
        const pi = thing({ agent: "pi" });
        void interrupt.run(pi, { model: {} as any });
        stopAgent(pi.agent);
        void interrupt.run(pi, { model: {} as any });
        expect(typed).toEqual(["\x1b", "\x1b", "\x1b"]);
        report("idle");
        expect(typed).toEqual(["\x1b", "\x1b", "\x1b", "\r"]);
    });
});
