// Pure view-model logic for the Agents view. No React, no Wave runtime imports.

import { modelLabel } from "@/app/tab/sessionsidebar/sessionviewmodel";

export type AgentState = "asking" | "working" | "idle";

// One item of "previous info": something the agent said, or something it did.
export type AgentEntry =
    | { kind: "message"; text: string }
    | { kind: "user"; text: string }
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
    agent?: string; // coding-agent identity (claude | codex | …) — selects the transcript projector
    model?: string; // short family label (e.g. "opus")
    activity?: string; // working: live activity line; idle: reason
    blockedMs?: number; // asking: how long blocked (sort + age)
    activeMs?: number; // working: elapsed (sort)
    previousInfo?: AgentEntry[]; // asking: messages + actions leading to the question
    ask?: AgentAsk; // present iff state === "asking"
    transcriptPath?: string; // source for on-demand previous-info (not rendered directly)
    blockId?: string; // terminal block OID — target for ControllerInputCommand
    idleSince?: number; // idle: when it went idle (UnixMilli) — drives the keep-as-panel grace window
    usage?: AgentUsage; // latest context %, cost, and plan rate-limit snapshot (from the statusLine reporter)
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

/** Pure: the text of the most recent message-kind entry, or undefined. Drives the working row's
 *  current-activity line and the focus view's accented "now" message. */
export function latestMessageText(entries: AgentEntry[]): string | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind === "message") {
            return e.text;
        }
    }
    return undefined;
}

export type AgentActionEntry = Extract<AgentEntry, { kind: "action" }>;

/** Pure: the last `max` action-kind entries, oldest-first. Drives the working row's steps column. */
export function recentActions(entries: AgentEntry[], max: number): AgentActionEntry[] {
    const actions = entries.filter((e): e is AgentActionEntry => e.kind === "action");
    return max > 0 ? actions.slice(-max) : actions;
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

/** Pure: usage percentage -> threshold band for color (shared by the plan strip and context bars). */
export function usageLevel(pct: number): "ok" | "warn" | "hot" {
    if (pct > 85) {
        return "hot";
    }
    if (pct > 60) {
        return "warn";
    }
    return "ok";
}

/** Pure: a token count -> short label ("38k" / "142k" / "1.0M"). */
export function formatTokens(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1_000) {
        return `${Math.round(n / 1_000)}k`;
    }
    return String(n);
}

/** Pure: an epoch-seconds reset time -> short countdown ("now" / "44m" / "2h 11m"). */
export function formatReset(resetSec: number, now: number): string {
    const mins = Math.floor((resetSec * 1000 - now) / 60_000);
    if (mins <= 0) {
        return "now";
    }
    if (mins < 60) {
        return `${mins}m`;
    }
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const PROVIDER_RANK: Record<string, number> = { claude: 0, codex: 1 };

/** Pure: the freshest plan-limit usage snapshot per provider. Claude (Claude.ai) and Codex (ChatGPT)
 *  bill separate 5h/weekly quotas, so the strip shows one row per provider instead of a single global
 *  figure. Input order is the priority (active-first): the first agent of each provider carrying
 *  rate-limit data wins. Rows come back claude-first, then codex, then any others in first-seen order. */
export function providerPlanUsage(agents: AgentVM[]): { provider: string; usage: AgentUsage }[] {
    const byProvider = new Map<string, AgentUsage>();
    for (const a of agents) {
        const u = a.usage;
        if (!u || (u.fivehourpct == null && u.weekpct == null)) {
            continue;
        }
        const provider = a.agent || "claude";
        if (!byProvider.has(provider)) {
            byProvider.set(provider, u);
        }
    }
    return [...byProvider.entries()]
        .map(([provider, usage]) => ({ provider, usage }))
        .sort((a, b) => (PROVIDER_RANK[a.provider] ?? 99) - (PROVIDER_RANK[b.provider] ?? 99));
}

/** Minimal per-agent inputs the live roster feeds the pure mapping. `status` is the sidebar's
 *  SessionStatus string ("working" | "waiting" | "idle"); `ts` is the status event's UnixMilli. */
export interface LiveAgentInput {
    id: string; // tabId — open target + stable key
    name: string;
    status: string;
    detail?: string;
    agent?: string; // coding-agent identity (claude | codex | …)
    model?: string; // raw model id
    ts?: number; // last status change (UnixMilli)
    transcriptPath?: string;
    blockId?: string;
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
        agent: input.agent,
        model: modelLabel(input.model),
        activity: input.detail,
        transcriptPath: input.transcriptPath,
        blockId: input.blockId,
    };
    if (state === "asking") {
        vm.blockedMs = age;
    } else if (state === "working") {
        vm.activeMs = age;
    } else if (input.ts != null) {
        vm.idleSince = input.ts;
    }
    return vm;
}

/** Pure: reconcile a stable order list against the current id set. Kept ids retain their existing
 *  slot regardless of `ids` order (anchored ordering); new ids append in `ids` order; absent ids
 *  drop. This is why a working->asking transition never moves a panel: the id stays in the set. */
export function mergeOrder(prev: string[], ids: string[]): string[] {
    const present = new Set(ids);
    const kept = prev.filter((id) => present.has(id));
    const keptSet = new Set(kept);
    const added = ids.filter((id) => !keptSet.has(id));
    return [...kept, ...added];
}

/** Pure: the ask to jump to after `current`, cycling with wrap. Defaults to the first ask when
 *  `current` is absent or no longer in the list. Undefined for an empty list. */
export function nextAskId(ids: string[], current?: string): string | undefined {
    if (ids.length === 0) {
        return undefined;
    }
    const idx = current != null ? ids.indexOf(current) : -1;
    return ids[(idx + 1) % ids.length];
}

/** Pure: the id `delta` steps from `current` in `ids`, clamped at both ends (no wrap). Falls back to
 *  the first id when `current` is absent/unknown. Undefined for an empty list. Drives j/k cursor moves. */
export function moveCursor(ids: string[], current: string | undefined, delta: number): string | undefined {
    if (ids.length === 0) {
        return undefined;
    }
    const idx = current != null ? ids.indexOf(current) : -1;
    if (idx === -1) {
        return ids[0];
    }
    return ids[Math.max(0, Math.min(ids.length - 1, idx + delta))];
}

/** Pure: one AgentAnswerItem per question, carrying that question's selected option indexes (ascending). */
export function buildAskAnswers(questions: AgentAskQuestion[], selections: Record<number, Set<number>>): AgentAnswerItem[] {
    return questions.map((_, qi) => ({ selectedindexes: Array.from(selections[qi] ?? []).sort((a, b) => a - b) }));
}

/** Pure: submittable only when every question has at least one selected option. */
export function canSubmitAsk(questions: AgentAskQuestion[], selections: Record<number, Set<number>>): boolean {
    return questions.length > 0 && questions.every((_, qi) => (selections[qi]?.size ?? 0) >= 1);
}

/** Pure: a working agent is "quiet" when no new narration has arrived for thresholdMs. */
export function isQuiet(lastActivityMs: number | undefined, now: number, thresholdMs = 45_000): boolean {
    return lastActivityMs != null && now - lastActivityMs > thresholdMs;
}

/** Single source of truth for how long a just-finished agent keeps its full panel (so you can
 *  reply) before it collapses into the Idle list. */
export const IDLE_GRACE_MS = 300_000;

/** Pure: a just-finished idle agent still warrants a full panel until graceMs after it went idle.
 *  False for non-idle agents, those past the window, or those with no idleSince. */
export function isRecentlyIdle(agent: AgentVM, now: number, graceMs = IDLE_GRACE_MS): boolean {
    return agent.state === "idle" && agent.idleSince != null && now - agent.idleSince < graceMs;
}


/** Pure: overlay a pending ask onto an agent. A live ask makes the agent `asking` regardless of
 *  the reporter's status (a blocked AskCommand RPC may still report "working"); blockedMs is
 *  derived from now - ask.ts. A null/cleared ask leaves the agent untouched. */
/** Pure: a pending ask is stale once the agent has demonstrably resumed — a newer status update
 *  (statusTs > askTs) reporting working/idle. A blocked agent emits no fresh working/idle status
 *  until it resumes, so this only fires after the question was resolved by some path (terminal,
 *  panel, or the agent moving on). The PostToolUse clear hook is the fast path; this is the fallback. */
export function isAskStale(askTs: number | undefined, statusTs: number | undefined, statusState: string): boolean {
    if (askTs == null || statusTs == null) {
        return false;
    }
    if (statusState !== "working" && statusState !== "idle") {
        return false;
    }
    return statusTs > askTs;
}

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
