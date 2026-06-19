// Pure view-model logic for the Agents view. No React, no Wave runtime imports.

import { modelLabel } from "@/app/tab/sessionsidebar/sessionviewmodel";

export type AgentState = "asking" | "working" | "idle";

// One item of "previous info": something the agent said, or something it did.
export type AgentEntry =
    | { kind: "message"; text: string }
    | { kind: "action"; verb: string; target: string; outcome?: "ok" | "fail"; note?: string };

export interface AgentAskOption {
    label: string;
    description?: string;
}

export interface AgentAskQuestion {
    question: string;
    header?: string;
    multiSelect?: boolean;
    options?: AgentAskOption[];
}

export interface AgentAsk {
    questions: AgentAskQuestion[];
    askId?: string;
    oref?: string;
}

export interface AgentVM {
    id: string; // tabId — stable key + open/answer target
    name: string; // e.g. "loom"
    task: string; // e.g. "Fix duplicate-session race"
    state: AgentState;
    model?: string; // short family label (e.g. "opus")
    activity?: string; // working: live activity line; idle: reason
    blockedMs?: number; // asking: how long blocked (sort + age)
    activeMs?: number; // working: elapsed (sort)
    previousInfo?: AgentEntry[]; // asking: messages + actions leading to the question
    ask?: AgentAsk; // present iff state === "asking"
    transcriptPath?: string; // source for on-demand previous-info (not rendered directly)
}

const STATE_RANK: Record<AgentState, number> = { asking: 0, working: 1, idle: 2 };

/** Pure: asking -> working -> idle; within asking, longest-blocked first;
 *  within working, longest-running first; idle keeps input order. Never mutates input. */
export function sortAgents(agents: AgentVM[]): AgentVM[] {
    return [...agents].sort((a, b) => {
        const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
        if (rank !== 0) {
            return rank;
        }
        if (a.state === "asking") {
            return (b.blockedMs ?? 0) - (a.blockedMs ?? 0);
        }
        if (a.state === "working") {
            return (b.activeMs ?? 0) - (a.activeMs ?? 0);
        }
        return 0;
    });
}

/** Pure: number of agents currently asking (drives the sidebar badge). */
export function askingCount(agents: AgentVM[]): number {
    return agents.filter((a) => a.state === "asking").length;
}

/** Pure: the agents to render as output panels — asking → working (sortAgents order),
 *  idle excluded (idle agents live in the sidebar, not this view). */
export function outputPanelOrder(agents: AgentVM[]): AgentVM[] {
    return sortAgents(agents).filter((a) => a.state !== "idle");
}

export interface AgentSections {
    asking: AgentVM[];
    working: AgentVM[];
    idle: AgentVM[];
}

/** Pure: the three rendered sections, each already sorted by sortAgents. */
export function groupAgents(agents: AgentVM[]): AgentSections {
    const sorted = sortAgents(agents);
    return {
        asking: sorted.filter((a) => a.state === "asking"),
        working: sorted.filter((a) => a.state === "working"),
        idle: sorted.filter((a) => a.state === "idle"),
    };
}

/** Pure: a millisecond duration -> short age label ("just now" / "4m" / "2h"). */
export function formatAge(ms?: number): string {
    if (ms == null || ms < 60_000) {
        return "just now";
    }
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) {
        return `${mins}m`;
    }
    return `${Math.floor(mins / 60)}h`;
}

/** Minimal per-agent inputs the live roster feeds the pure mapping. `status` is the sidebar's
 *  SessionStatus string ("working" | "waiting" | "idle"); `ts` is the status event's UnixMilli. */
export interface LiveAgentInput {
    id: string; // tabId — open target + stable key
    name: string;
    status: string;
    detail?: string;
    model?: string; // raw model id
    ts?: number; // last status change (UnixMilli)
    transcriptPath?: string;
}

/** Pure: one live row -> an AgentVM. `waiting` becomes `asking`; age is derived from `now - ts`
 *  (asking -> blockedMs, working -> activeMs). previousInfo/ask/task are filled later (async). */
export function agentVMFromInput(input: LiveAgentInput, now: number): AgentVM {
    const state: AgentState = input.status === "waiting" ? "asking" : input.status === "working" ? "working" : "idle";
    const age = input.ts != null ? Math.max(0, now - input.ts) : undefined;
    const vm: AgentVM = {
        id: input.id,
        name: input.name,
        task: "",
        state,
        model: modelLabel(input.model),
        activity: input.detail,
        transcriptPath: input.transcriptPath,
    };
    if (state === "asking") {
        vm.blockedMs = age;
    } else if (state === "working") {
        vm.activeMs = age;
    }
    return vm;
}

/** Pure: overlay a pending ask onto an agent. A live ask makes the agent `asking` regardless of
 *  the reporter's status (a blocked AskCommand RPC may still report "working"); blockedMs is
 *  derived from now - ask.ts. A null/cleared ask leaves the agent untouched. */
export function withAsk(vm: AgentVM, ask: AgentAskData | null, now: number): AgentVM {
    if (ask == null || ask.cleared) {
        return vm;
    }
    return {
        ...vm,
        state: "asking",
        activeMs: undefined,
        blockedMs: ask.ts != null ? Math.max(0, now - ask.ts) : vm.blockedMs,
        ask: {
            questions: (ask.questions ?? []).map((q) => ({
                question: q.question,
                header: q.header,
                multiSelect: q.multiselect,
                options: q.options?.map((o) => ({ label: o.label, description: o.description })),
            })),
            askId: ask.askid,
            oref: ask.oref,
        },
    };
}
