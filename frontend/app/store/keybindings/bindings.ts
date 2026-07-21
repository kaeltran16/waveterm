// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cheatsheetOpenAtom } from "@/app/cockpit/shortcuts-cheatsheet";
import { globalStore } from "@/app/store/jotaiStore";
import { confirmCloseAgent } from "@/app/view/agents/agentactions";
import { AgentsViewModel, SURFACE_ORDER, type SurfaceKey } from "@/app/view/agents/agents";
import { answerDigitTarget, canSubmitAsk, moveCursor, type AgentVM } from "@/app/view/agents/agentsviewmodel";
import type { MutableRefObject } from "react";
import { railVisibleAtom, terminalFullscreenAtom } from "@/app/view/agents/railstore";
import {
    appliedAtom,
    applyReview,
    decide,
    decisionsAtom,
    hunkKey,
    reviewModelAtom,
    reviewSelectedAtom,
    undoLast,
} from "@/app/view/agents/reviewstore";
import { focusSubagentAtom } from "@/app/view/agents/subagentsstore";
import { listNavAtom } from "./listnav";
import type { Binding, KeyContext } from "./types";

const DOUBLE_CTRL_C_MS = 500;

// g-leader surface teleports (collision-free letters; see design spec).
const GO_TARGETS: { letter: string; surface: SurfaceKey; label: string }[] = [
    { letter: "h", surface: "cockpit", label: "Cockpit (home)" },
    { letter: "a", surface: "agent", label: "Agent" },
    { letter: "c", surface: "channels", label: "Channels" },
    { letter: "r", surface: "radar", label: "Radar" },
    { letter: "s", surface: "sessions", label: "Sessions" },
    { letter: "f", surface: "files", label: "Files" },
    { letter: "m", surface: "memory", label: "Memory" },
    { letter: "u", surface: "usage", label: "Usage" },
    { letter: ",", surface: "settings", label: "Settings" },
];

const navigate = (ctx: KeyContext) => !ctx.editable && !ctx.modalOpen;

// Deep (non-home) surfaces whose Escape returns to the Cockpit. Excludes cockpit (already home), agent
// (owns Escape via buildAgentBindings: exit fullscreen / back), and settings.
const ESC_HOME_SURFACES = new Set<SurfaceKey>(["channels", "radar", "sessions", "files", "memory", "usage"]);

// Spec §5 (agent-tab-fixes): the second Ctrl+C closes the *focused* session — agent or plain
// terminal alike (the UI labels both "terminal": "Close terminal — ends the agent"). Returns null
// only when nothing focusable is targeted, so the press falls through to the PTY instead.
export function closeTargetForDoubleCtrlC(agents: AgentVM[], focusId: string | undefined): AgentVM | null {
    if (!focusId) {
        return null;
    }
    return agents.find((x) => x.id === focusId) ?? null;
}

export function buildGlobalBindings(model: AgentsViewModel): Binding[] {
    let lastCtrlC: number | null = null;

    // `[`/`]` cycle the rail order (SURFACE_ORDER). A surface outside the cycle (settings) enters at an end.
    const cycleSurface = (delta: number) => {
        const cur = globalStore.get(model.surfaceAtom);
        const idx = SURFACE_ORDER.indexOf(cur);
        const next =
            idx === -1
                ? SURFACE_ORDER[delta > 0 ? 0 : SURFACE_ORDER.length - 1]
                : SURFACE_ORDER[(idx + delta + SURFACE_ORDER.length) % SURFACE_ORDER.length];
        globalStore.set(model.surfaceAtom, next);
    };

    const surfaceChords: Binding[] = SURFACE_ORDER.slice(0, 8).map((surface, i) => ({
        id: `surface:${surface}`,
        keys: `Ctrl:${i + 1}`,
        group: "Global",
        label: `Jump to ${surface}`,
        run: () => globalStore.set(model.surfaceAtom, surface),
    }));

    const goBindings: Binding[] = GO_TARGETS.map((t) => ({
        id: `go:${t.surface}`,
        keys: `g ${t.letter}`,
        group: "Go to",
        label: t.label,
        when: navigate,
        run: () => globalStore.set(model.surfaceAtom, t.surface),
    }));

    return [
        ...surfaceChords,
        ...goBindings,
        { id: "surface:next", keys: "]", group: "Navigation", label: "Next surface", when: navigate, run: () => cycleSurface(1) },
        { id: "surface:prev", keys: "[", group: "Navigation", label: "Previous surface", when: navigate, run: () => cycleSurface(-1) },
        {
            id: "palette",
            keys: "Ctrl:p",
            group: "Global",
            label: "Command palette",
            run: () => globalStore.set(model.paletteOpenAtom, (v) => !v),
        },
        {
            id: "go:palette",
            keys: "g p",
            group: "Go to",
            label: "Command palette",
            when: navigate,
            run: () => globalStore.set(model.paletteOpenAtom, true),
        },
        {
            id: "new-agent",
            keys: "Ctrl:n",
            group: "Global",
            label: "New agent",
            run: () => globalStore.set(model.newAgentOpenAtom, true),
        },
        {
            id: "cycle-agent-next",
            keys: "Ctrl:Tab",
            group: "Agent",
            label: "Next agent",
            when: (ctx) => ctx.surface === "agent",
            run: () => model.cycleFocus(false),
        },
        {
            id: "cycle-agent-prev",
            keys: "Ctrl:Shift:Tab",
            group: "Agent",
            label: "Previous agent",
            when: (ctx) => ctx.surface === "agent",
            run: () => model.cycleFocus(true),
        },
        {
            id: "close-agent",
            keys: "Ctrl:c",
            group: "Agent",
            label: "Close agent (press twice)",
            // Global chord (allowed while the terminal is focused/editable), Agent surface only.
            when: (ctx) => ctx.surface === "agent",
            run: () => {
                const inTerm = (document.activeElement as HTMLElement | null)?.closest?.(".cockpit-focus-pane") != null;
                if (!inTerm) {
                    return false; // let ^C reach the shell when not in the focus pane
                }
                const now = performance.now();
                if (lastCtrlC != null && now - lastCtrlC < DOUBLE_CTRL_C_MS) {
                    lastCtrlC = null;
                    const agents = [...globalStore.get(model.agentsAtom), ...globalStore.get(model.terminalsAtom)];
                    const fid = globalStore.get(model.focusIdAtom);
                    const a = closeTargetForDoubleCtrlC(agents, fid);
                    if (a) {
                        confirmCloseAgent(a.id, a.name);
                        return true;
                    }
                    return false;
                }
                lastCtrlC = now;
                return false; // first press falls through so the PTY receives ^C
            },
        },
        {
            id: "help",
            keys: "Shift:?",
            group: "Help",
            label: "Keyboard shortcuts",
            when: navigate,
            run: () => globalStore.set(cheatsheetOpenAtom, true),
        },
        {
            id: "surface:back-home",
            keys: "Escape",
            group: "Navigation",
            label: "Back to Cockpit",
            when: (ctx) => navigate(ctx) && ESC_HOME_SURFACES.has(ctx.surface),
            run: () => globalStore.set(model.surfaceAtom, "cockpit"),
        },
    ];
}

// One shared set of list-cursor bindings for the plain master-detail surfaces. Active only when the
// mounted surface has published a controller (listnav.ts) for itself and focus is not in a field.
export function buildListNavBindings(): Binding[] {
    const active = (ctx: KeyContext): boolean => {
        if (ctx.editable || ctx.modalOpen) {
            return false;
        }
        const c = globalStore.get(listNavAtom);
        return c != null && c.surface === ctx.surface;
    };
    const move = (delta: number) => {
        const c = globalStore.get(listNavAtom);
        if (c == null) {
            return;
        }
        const next = moveCursor(c.navigableIds, c.cursorId, delta);
        if (next != null) {
            c.setCursor(next);
        }
    };
    const activate = (): void | boolean => {
        const c = globalStore.get(listNavAtom);
        if (c?.activate == null) {
            return false; // no primary action for this surface — let Enter pass through
        }
        c.activate();
    };
    return [
        { id: "list:next-j", keys: "j", group: "Navigation", label: "Next item", when: active, run: () => move(1) },
        { id: "list:prev-k", keys: "k", group: "Navigation", label: "Previous item", when: active, run: () => move(-1) },
        { id: "list:next", keys: "ArrowDown", group: "Navigation", label: "Next item", when: active, run: () => move(1) },
        { id: "list:prev", keys: "ArrowUp", group: "Navigation", label: "Previous item", when: active, run: () => move(-1) },
        { id: "list:activate", keys: "Enter", group: "Navigation", label: "Open / activate item", when: active, run: activate },
    ];
}

// Files "Review" mode triage keys. Registered by ReviewSurface via useKeybindings, so they exist
// only while review mode is mounted; run() reads the review atoms live. Folds the former ad-hoc
// window keydown listener into the registry (F7) — so it now respects the typing-guard.
export function buildReviewBindings(): Binding[] {
    const ready = (ctx: KeyContext): boolean =>
        ctx.surface === "files" &&
        !ctx.editable &&
        !ctx.modalOpen &&
        globalStore.get(reviewModelAtom) != null &&
        globalStore.get(appliedAtom) == null;
    const files = () => globalStore.get(reviewModelAtom)?.files ?? [];
    const nextPending = (): string | undefined => {
        const sel = globalStore.get(reviewSelectedAtom);
        const d = globalStore.get(decisionsAtom);
        const fs = files();
        const f = fs.find((x) => x.path === sel) ?? fs[0];
        return f?.hunks.map((h) => hunkKey(f.path, h.id)).find((k) => !d[k]);
    };
    const moveSel = (dir: number) => {
        const fs = files();
        if (fs.length === 0) {
            return;
        }
        const sel = globalStore.get(reviewSelectedAtom);
        const i = fs.findIndex((f) => f.path === sel);
        const ni = Math.max(0, Math.min(fs.length - 1, (i < 0 ? 0 : i) + dir));
        globalStore.set(reviewSelectedAtom, fs[ni].path);
    };
    const decideNext = (val: "accept" | "reject") => {
        const k = nextPending();
        if (k == null) {
            return false; // nothing pending — pass the key through
        }
        decide(k, val);
    };
    return [
        { id: "review:accept", keys: "a", group: "Review", label: "Accept next hunk", when: ready, run: () => decideNext("accept") },
        { id: "review:reject", keys: "r", group: "Review", label: "Reject next hunk", when: ready, run: () => decideNext("reject") },
        { id: "review:undo", keys: "u", group: "Review", label: "Undo last decision", when: ready, run: () => undoLast() },
        { id: "review:next", keys: "ArrowDown", group: "Review", label: "Next file", when: ready, run: () => moveSel(1) },
        { id: "review:next-j", keys: "j", group: "Review", label: "Next file", when: ready, run: () => moveSel(1) },
        { id: "review:prev", keys: "ArrowUp", group: "Review", label: "Previous file", when: ready, run: () => moveSel(-1) },
        { id: "review:prev-k", keys: "k", group: "Review", label: "Previous file", when: ready, run: () => moveSel(-1) },
        {
            id: "review:apply",
            keys: "Enter",
            group: "Review",
            label: "Apply review",
            when: ready,
            run: () => {
                const d = globalStore.get(decisionsAtom);
                const pending = files().some((f) => f.hunks.some((h) => !d[hunkKey(f.path, h.id)]));
                if (pending) {
                    return false; // still hunks to decide — do not apply
                }
                void applyReview();
            },
        },
    ];
}

// Channels ask keys: the run body's ask card renders numbered (1-9) answer badges (channelsprimitives
// AskRow), but the digit handler used to be cockpit-only. These bindings make the badges functional on
// the Channels surface, targeting the selected run's asking worker (published live via askAgentRef by
// ChannelsSurface). Reuses answerDigitTarget + model.toggleAnswer/submitAnswer — no duplicated logic.
export function buildChannelsAskBindings(
    model: AgentsViewModel,
    askAgentRef: MutableRefObject<AgentVM | undefined>
): Binding[] {
    const ready = (ctx: KeyContext): boolean =>
        ctx.surface === "channels" && !ctx.editable && !ctx.modalOpen && askAgentRef.current != null;
    const toggleDigit = (n: number): boolean | void => {
        const agent = askAgentRef.current;
        if (agent == null) {
            return false;
        }
        const tab = globalStore.get(model.answerTabAtom)[agent.id] ?? 0;
        const target = answerDigitTarget(agent, tab, n);
        if (target == null) {
            return false; // no such option — let the key pass
        }
        model.toggleAnswer(agent.id, target.qi, target.oi);
    };
    const submit = (): boolean | void => {
        const agent = askAgentRef.current;
        if (agent == null) {
            return false;
        }
        const sel = globalStore.get(model.answerSelAtom)[agent.id] ?? {};
        const txt = globalStore.get(model.answerTextAtom)[agent.id] ?? {};
        if (!canSubmitAsk(agent.ask?.questions ?? [], sel, txt)) {
            return false; // not yet answerable — let Enter pass
        }
        model.submitAnswer(agent.id);
    };
    const digits: Binding[] = Array.from({ length: 9 }, (_, i) => i + 1).map((n) => ({
        id: `channels:answer-${n}`,
        keys: String(n),
        group: "Channels",
        label: `Answer option ${n}`,
        when: ready,
        run: () => toggleDigit(n),
    }));
    return [
        ...digits,
        { id: "channels:submit", keys: "Enter", group: "Channels", label: "Submit answer", when: ready, run: submit },
    ];
}

// Cockpit-grid triage keys. The rich cockpit surface handles these itself (usecockpitkeyboard.ts) —
// they need live cursor + DOM state (scroll-to, focus a row's composer) that the registry has no clean
// hold on. Registered here purely so the ONE cheat sheet (Shift+?) documents them: `run` returns false
// so the dispatcher never consumes the key — it passes through to the surface's own onKeyDown. This is
// the single source of truth for these keys' documentation (the old hand-written help overlay is gone).
export function buildCockpitBindings(): Binding[] {
    const on = (ctx: KeyContext) => ctx.surface === "cockpit" && !ctx.editable && !ctx.modalOpen;
    const doc = (id: string, keys: string, label: string): Binding => ({
        id,
        keys,
        group: "Cockpit",
        label,
        when: on,
        run: () => false, // never consume — usecockpitkeyboard.ts performs the action
    });
    return [
        doc("cockpit:next", "j", "Next agent (↓ / j)"),
        doc("cockpit:prev", "k", "Previous agent (↑ / k)"),
        doc("cockpit:next-ask", "n", "Jump to next ask"),
        doc("cockpit:switch-question", "h", "Switch question (← → / h l)"),
        doc("cockpit:answer", "1", "Select an answer option (1–9)"),
        doc("cockpit:open", "Enter", "Confirm answer, else open focus"),
        doc("cockpit:reply", "r", "Reply inline to the agent"),
        doc("cockpit:terminal", "t", "Open the agent's terminal"),
        doc("cockpit:background", "b", "Background the agent (keeps running)"),
    ];
}

const agentNav = (ctx: KeyContext) => navigate(ctx) && ctx.surface === "agent";

// Agent (Focus) surface bindings. Moved out of agentsurface.tsx so the registry has one home
// and the array is stable: run() reads live atoms instead of closing over per-render focus/order.
// focusIdAtom is kept synced to the resolved focused agent (agentsurface.tsx), so reading it live
// is equivalent to the old closure over `agent.id`.
export function buildAgentBindings(model: AgentsViewModel): Binding[] {
    const step = (delta: number) => {
        const order = globalStore.get(model.orderAtom);
        const fid = globalStore.get(model.focusIdAtom);
        globalStore.set(model.focusIdAtom, moveCursor(order, fid, delta) ?? fid);
        globalStore.set(model.focusReplyAtom, false);
    };
    return [
        {
            id: "subagent:back",
            keys: "Escape",
            group: "Agent",
            label: "Back to parent agent",
            // fires regardless of editable to preserve the old always-on Escape; mutually exclusive
            // with agent:back below (both guarded on focusSubagentAtom), so no key conflict.
            when: (ctx) => ctx.surface === "agent" && globalStore.get(focusSubagentAtom) != null,
            run: () => globalStore.set(focusSubagentAtom, null),
        },
        {
            id: "agent:back",
            keys: "Escape",
            group: "Agent",
            label: "Back to Cockpit (or exit fullscreen)",
            when: (ctx) => agentNav(ctx) && globalStore.get(focusSubagentAtom) == null,
            run: () => {
                if (globalStore.get(terminalFullscreenAtom)) {
                    globalStore.set(terminalFullscreenAtom, false);
                } else {
                    globalStore.set(model.surfaceAtom, "cockpit");
                }
            },
        },
        { id: "agent:prev", keys: "ArrowLeft", group: "Agent", label: "Previous agent", when: agentNav, run: () => step(-1) },
        { id: "agent:next", keys: "ArrowRight", group: "Agent", label: "Next agent", when: agentNav, run: () => step(1) },
        { id: "agent:prev-k", keys: "k", group: "Agent", label: "Previous agent", when: agentNav, run: () => step(-1) },
        { id: "agent:next-j", keys: "j", group: "Agent", label: "Next agent", when: agentNav, run: () => step(1) },
        {
            id: "agent:toggle-rail",
            keys: "d",
            group: "Agent",
            label: "Toggle agent rail",
            when: agentNav,
            run: () => globalStore.set(railVisibleAtom, !globalStore.get(railVisibleAtom)),
        },
        {
            id: "agent:fullscreen",
            keys: "f",
            group: "Agent",
            label: "Toggle terminal fullscreen",
            when: agentNav,
            run: () => globalStore.set(terminalFullscreenAtom, !globalStore.get(terminalFullscreenAtom)),
        },
        {
            id: "agent:return-nav",
            keys: "Shift:Escape",
            group: "Agent",
            label: "Return focus to nav",
            when: (ctx) => ctx.surface === "agent" && ctx.editable, // only while the TUI owns focus
            run: () => {
                (document.activeElement as HTMLElement | null)?.blur?.();
                // refocus the surface wrapper (tabIndex=0) so ↑↓/j/k/d/f resume
                document.querySelector<HTMLElement>("[data-cockpit-surface-wrap]")?.focus();
            },
        },
    ];
}
