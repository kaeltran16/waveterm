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
    model?: string; // short family label (e.g. "opus")
    activity?: string; // working: live activity line; idle: reason
    blockedMs?: number; // asking: how long blocked (sort + age)
    activeMs?: number; // working: elapsed (sort)
    previousInfo?: AgentEntry[]; // asking: messages + actions leading to the question
    ask?: AgentAsk; // present iff state === "asking"
    transcriptPath?: string; // source for on-demand previous-info (not rendered directly)
    blockId?: string; // terminal block OID — target for ControllerInputCommand
    idleSince?: number; // idle: when it went idle (UnixMilli) — drives the keep-as-panel grace window
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

export type PanelPreset = "s" | "m" | "l" | "full";

/** Pre-determined working-panel sizes in the 2-col grid: `cols` = column span, `height` in px (or
 *  "fill" = the live viewport height, resolved at render). S/M grow height within one column; L spans
 *  the full row; full spans the row and fills the viewport. Single source of truth for sizing + snapping. */
export const PANEL_PRESETS: Record<PanelPreset, { cols: 1 | 2; height: number | "fill" }> = {
    s: { cols: 1, height: 240 },
    m: { cols: 1, height: 360 },
    l: { cols: 2, height: 360 },
    full: { cols: 2, height: "fill" },
};

export const DEFAULT_PANEL_PRESET: PanelPreset = "s";

/** Resolve a preset's height to pixels: "fill" becomes the live viewport height (fillPx). */
export function resolveHeight(preset: PanelPreset, fillPx: number): number {
    const h = PANEL_PRESETS[preset].height;
    return h === "fill" ? fillPx : h;
}

/** Pure: map a freely-dragged width/height to the nearest preset. Column span is chosen by whichever
 *  of one-/two-column width is closer; among presets with that span, the nearest height wins. fillPx
 *  resolves the "fill" preset's height so it can be compared like any fixed preset. */
export function snapToPreset(width: number, height: number, oneColW: number, twoColW: number, fillPx: number): PanelPreset {
    const cols: 1 | 2 = Math.abs(width - twoColW) < Math.abs(width - oneColW) ? 2 : 1;
    const all = Object.keys(PANEL_PRESETS) as PanelPreset[];
    const pool = all.filter((p) => PANEL_PRESETS[p].cols === cols);
    const candidates = pool.length > 0 ? pool : all;
    return candidates.reduce((best, p) =>
        Math.abs(resolveHeight(p, fillPx) - height) < Math.abs(resolveHeight(best, fillPx) - height) ? p : best
    );
}

/** Pure: move draggedId before/after targetId in a flat id list. Returns the input on a no-op
 *  (self-drop, or either id absent). Never mutates the input. */
export function reorderList(ids: string[], draggedId: string, targetId: string, placeBefore: boolean): string[] {
    if (draggedId === targetId || !ids.includes(draggedId) || !ids.includes(targetId)) {
        return ids;
    }
    const without = ids.filter((id) => id !== draggedId);
    const idx = without.indexOf(targetId);
    const at = placeBefore ? idx : idx + 1;
    return [...without.slice(0, at), draggedId, ...without.slice(at)];
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
