// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { launchPiTab } from "@/app/cockpit/cockpit-actions";
import { cheatsheetOpenAtom } from "@/app/cockpit/shortcuts-cheatsheet";
import { globalStore } from "@/app/store/jotaiStore";
import { confirmCloseSession } from "@/app/view/agents/agentactions";
import { AgentsViewModel, SURFACE_ORDER, type SurfaceKey } from "@/app/view/agents/agents";
import { answerDigitTarget, canSubmitAsk, moveCursor, type AgentVM } from "@/app/view/agents/agentsviewmodel";
import { activeChannelRunsAtom } from "@/app/view/agents/channelsstore";
import { sideJumpTarget, type CompareRow } from "@/app/view/agents/comparerows";
import { compareOnAtom, compareSelectionAtom, leaveCompare } from "@/app/view/agents/comparestore";
import { filesStateAtom, reloadChanges } from "@/app/view/agents/filesstore";
import {
    clearHistoryFilters,
    graphOnAtom,
    historyFiltersAtom,
    historyScrollAtom,
} from "@/app/view/agents/githistorystore";
import { anyFilterActive } from "@/app/view/agents/historyquery";
import { dismissPending, keepPending, memPendingAtom, memSearchAtom, selectPending } from "@/app/view/agents/memstore";
import { railVisibleAtom, terminalFullscreenAtom } from "@/app/view/agents/railstore";
import { renamingRowAtom } from "@/app/view/agents/rowrenameatom";
import { resolveActiveRunId } from "@/app/view/agents/runmodel";
import { focusSubagentAtom } from "@/app/view/agents/subagentsstore";
import {
    vaultCursorAtom,
    vaultExpandedAtom,
    vaultFocusAtom,
    vaultReaderAtom,
    vaultScopeAtom,
    vaultTabAtom,
} from "@/app/view/agents/vaultstore";
import { filterQueue, moveCursor as moveQueueCursor } from "@/app/view/agents/vaulttriage";
import { codeSearchModeAtom } from "@/app/view/code/codesearchstore";
import {
    codeCursorAtom,
    codeFinderOpenAtom,
    codeRowsAtom,
    codeTreeFocusedAtom,
    codeViewModeAtom,
    confirmDelete,
    goBack,
    goForward,
    openPath,
    refreshIndex,
    saveCurrent,
    startCreate,
    startRename,
    toggleDir,
} from "@/app/view/code/codestore";
import { treeKeyAction, type TreeKey } from "@/app/view/code/codetreekeys";
import { autonomyPanelOpenAtom } from "@/app/view/jarvis/autonomyladder";
import { briefPeekRecordAtom, graphPeekOpenAtom } from "@/app/view/jarvis/jarvisstore";
import {
    activeRunIdAtom,
    activeSubjectAtom,
    setActiveRunId,
    startJarvisThread,
} from "@/app/view/jarvis/jarvissubjectstore";
import { petPeekOpenAtom } from "@/app/view/jarvis/petstore";
import { dagModalStateAtom } from "@/app/view/orchestrate/dagmodalstate";
import type { MutableRefObject } from "react";
import { listNavAtom } from "./listnav";
import type { Binding, KeyContext } from "./types";

const DOUBLE_CTRL_C_MS = 500;

function focusCodeSidebarOpener(): boolean {
    const opener = document.querySelector<HTMLButtonElement>('button[aria-label^="Expand Code sidebar"]');
    if (opener == null || opener.classList.contains("hidden")) {
        return false;
    }
    opener.focus();
    opener.click();
    return true;
}

function focusCodeTree(): void {
    const tree = document.querySelector<HTMLElement>("[data-code-tree]");
    if (tree != null && tree.closest(".hidden") == null) {
        tree.focus();
    }
}

// g-leader surface teleports (collision-free letters; see design spec).
const GO_TARGETS: { letter: string; surface: SurfaceKey; label: string }[] = [
    { letter: "h", surface: "cockpit", label: "Cockpit (home)" },
    { letter: "a", surface: "agent", label: "Agent" },
    { letter: "c", surface: "jarvis", label: "Jarvis (channels, records, recall)" },
    { letter: "r", surface: "radar", label: "Radar" },
    { letter: "s", surface: "sessions", label: "Sessions" },
    { letter: "f", surface: "files", label: "Diff" },
    { letter: "v", surface: "vault", label: "Vault (memory, steering, skills)" },
    { letter: "u", surface: "usage", label: "Usage" },
    { letter: "b", surface: "code", label: "Code (browse source)" },
    { letter: ",", surface: "settings", label: "Settings" },
];

// Posture guard for keys that reach the cockpit rather than the focused agent. Leader-aware: once a
// leader is active the dispatcher consumes the keystroke and it never reaches the agent, so "focus is
// in a text field" has already been overridden by a deliberate chord. In the TUI with no leader,
// editable is true and leader is null — behavior is bit-for-bit what it was before.
const navigate = (ctx: KeyContext) => (!ctx.editable || ctx.leader != null) && !ctx.modalOpen;

// For Escape-keyed bindings only. Escape must never activate while a text field or the terminal holds
// focus: jarvis:blur-composer claims Escape in exactly that posture, and two active claims on one key
// is what assertNoConflicts exists to catch. During leader mode the matcher intercepts Escape ahead of
// any binding (matcher.ts), so nothing is lost by keeping these strict.
const navigateStrict = (ctx: KeyContext) => !ctx.editable && !ctx.modalOpen;

// Deep (non-home) surfaces whose Escape returns to the Cockpit. Excludes cockpit (already home), agent
// (owns Escape via buildAgentBindings: exit fullscreen / back), and settings.
const ESC_HOME_SURFACES = new Set<SurfaceKey>(["jarvis", "radar", "sessions", "files", "vault", "usage", "code"]);

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

    const surfaceChords: Binding[] = SURFACE_ORDER.slice(0, 9).map((surface, i) => ({
        id: `surface:${surface}`,
        keys: `Ctrl:${i + 1}`,
        group: "Global",
        label: `Jump to ${surface}`,
        paletteHidden: true, // duplicates the go-target for the same surface, with a worse label
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
        {
            id: "surface:next",
            keys: "]",
            group: "Navigation",
            label: "Next surface",
            when: navigate,
            run: () => cycleSurface(1),
        },
        {
            id: "surface:prev",
            keys: "[",
            group: "Navigation",
            label: "Previous surface",
            when: navigate,
            run: () => cycleSurface(-1),
        },
        {
            // One chord for both palettes, dispatched on surface: Code leads with its file finder
            // (VS Code's Ctrl+P), every other surface opens the command palette. Typing '>' in the
            // finder hands off to the command palette, so commands stay one keystroke away on Code
            // without a second chord to remember. Deliberately unguarded — the palette has to be
            // reachable from inside a text field, and a binding that always matches is also what
            // keeps WebView2's print dialog off this key. `g p` still opens the palette directly.
            id: "palette",
            keys: "Ctrl:p",
            group: "Global",
            label: "Command palette (file finder on Code)",
            paletteHidden: true, // a palette row that opens the palette
            run: (ctx) => {
                if (ctx.surface === "code" && !globalStore.get(model.paletteOpenAtom)) {
                    globalStore.set(codeFinderOpenAtom, (v) => !v);
                    return;
                }
                globalStore.set(model.paletteOpenAtom, (v) => !v);
            },
        },
        {
            // Documentation only: matcher.ts LEADER_ALIASES performs the leader entry, because the
            // dispatcher owns leader state and a binding cannot set it. This exists so the footer
            // (footer-visible.ts renders a chip only for an ACTIVE binding id) and the Shift+? cheat
            // sheet can advertise the chord. Same shape as the cockpit-grid documentation bindings.
            // The matcher checks LEADER_ALIASES ahead of the singles pass, so this never wins the key.
            id: "leader:enter",
            keys: "Ctrl:g",
            group: "Navigation",
            label: "Go to… (works inside the agent terminal)",
            paletteHidden: true, // a palette row for a key the palette itself would swallow
            // Gated on `editable` for PRESENTATION only, and it costs nothing: the matcher opens the
            // leader from this chord in every posture regardless of any `when`. At rest the bare-`g`
            // chip already says "go", so an unguarded chord would render a second identical chip; this
            // way the footer advertises whichever door is the one that works right now. The Shift+?
            // cheat sheet lists every registered binding without consulting `when`, so the chord stays
            // discoverable at rest.
            when: (ctx) => ctx.editable && !ctx.modalOpen,
            run: () => false, // never consume — the matcher already handled it
        },
        {
            id: "go:palette",
            keys: "g p",
            group: "Go to",
            label: "Command palette",
            paletteHidden: true, // a palette row that opens the palette
            when: navigate,
            run: () => globalStore.set(model.paletteOpenAtom, true),
        },
        {
            id: "new-agent",
            keys: "Ctrl:n",
            group: "Global",
            label: "New agent",
            // yields to an open modal: unguarded it stacked New Agent on top of whatever was already
            // open (the Code file finder, the palette) and pulled focus out of it
            when: (ctx) => !ctx.modalOpen,
            run: () => globalStore.set(model.newAgentOpenAtom, true),
        },
        {
            id: "launch:pi",
            keys: "Ctrl:Shift:n",
            group: "Global",
            label: "Launch Pi tab",
            run: () => void launchPiTab(model),
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
            paletteHidden: true, // one row would fire one press and appear to do nothing
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
                        confirmCloseSession(a);
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
            // the Jarvis graph peek owns Escape while it is open: closing an overlay is what the user means
            // by Escape there, and navigating home instead would leave the peek open behind the Cockpit.
            // The autonomy panel owns it for the same reason — and it cannot claim the key itself, since
            // this dispatcher runs on window capture, ahead of any handler the panel could register.
            when: (ctx) =>
                navigateStrict(ctx) &&
                ESC_HOME_SURFACES.has(ctx.surface) &&
                !globalStore.get(graphPeekOpenAtom) &&
                !globalStore.get(autonomyPanelOpenAtom) &&
                // and the pet's peek, for the same reason again — it is global chrome, so it can be open
                // on ANY of these surfaces, not just Jarvis
                !globalStore.get(petPeekOpenAtom) &&
                // the Diff surface's compare state owns Escape while it is on: leaving compare is what
                // Escape means there, and going home instead would strand a two-ref read behind the Cockpit
                !globalStore.get(compareOnAtom) &&
                // and with filters active, Escape clears them — the filter row says so ("Clear all · esc")
                !(ctx.surface === "files" && anyFilterActive(globalStore.get(historyFiltersAtom))) &&
                // the Code surface's file finder owns it for the same reason as compare — closing the
                // overlay is what Escape means while it is open, and going home too would do both at once
                !globalStore.get(codeFinderOpenAtom) &&
                // and the Vault's reader overlay: Escape closes the note you are reading and returns to
                // the row it was opened from, which is what "back" means while it is up
                globalStore.get(vaultReaderAtom) == null &&
                // the Brief's record peek is a ModalShell and the Brief is where every record destination
                // now lands: without this, one press closed the peek AND left the surface — and the peek's
                // own state was never cleared, so coming back showed it open again
                globalStore.get(briefPeekRecordAtom) == null &&
                // the DAG modal takes Escape itself too, and the Brief mounts it as well as Channels
                globalStore.get(dagModalStateAtom) == null,
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
        {
            id: "list:next-j",
            keys: "j",
            group: "Navigation",
            label: "Next item",
            when: active,
            paletteHidden: true,
            run: () => move(1),
        },
        {
            id: "list:prev-k",
            keys: "k",
            group: "Navigation",
            label: "Previous item",
            when: active,
            paletteHidden: true,
            run: () => move(-1),
        },
        {
            id: "list:next",
            keys: "ArrowDown",
            group: "Navigation",
            label: "Next item",
            when: active,
            paletteHidden: true,
            run: () => move(1),
        },
        {
            id: "list:prev",
            keys: "ArrowUp",
            group: "Navigation",
            label: "Previous item",
            when: active,
            paletteHidden: true,
            run: () => move(-1),
        },
        {
            id: "list:activate",
            keys: "Enter",
            group: "Navigation",
            label: "Open / activate item",
            when: active,
            paletteHidden: true,
            run: activate,
        },
    ];
}

// Run-body ask keys: the ask card renders numbered (1-9) answer badges (channelsprimitives AskRow), but
// the digit handler used to be cockpit-only. These bindings make the badges functional wherever the run
// body lives — now the merged Jarvis Stage — targeting the selected run's asking worker (published live
// via askAgentRef). Reuses answerDigitTarget + model.toggleAnswer/submitAnswer — no duplicated logic.
export function buildChannelsAskBindings(
    model: AgentsViewModel,
    askAgentRef: MutableRefObject<AgentVM | undefined>
): Binding[] {
    const ready = (ctx: KeyContext): boolean =>
        ctx.surface === "jarvis" && !ctx.editable && !ctx.modalOpen && askAgentRef.current != null;
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
        group: "Jarvis",
        label: `Answer option ${n}`,
        paletteHidden: true,
        when: ready,
        run: () => toggleDigit(n),
    }));
    return [
        ...digits,
        {
            id: "channels:submit",
            keys: "Enter",
            group: "Jarvis",
            label: "Submit answer",
            paletteHidden: true,
            when: ready,
            run: submit,
        },
    ];
}

// Jarvis surface keys — the surface's own controls, reachable without the mouse. Two shapes:
//   * state the registry owns outright (the context rail, the graph peek, the run switcher)
//   * a click on a control the surface already draws (+ Channel, the record band's expand)
// The second shape is deliberate. Whether a band is *expandable* is the band's own derivation from the
// run's attribution (recordbandview) and re-deriving it here would be a second source of truth that
// drifts; the button only exists when the band can open, so clicking it is exactly the mouse's contract.
// Every DOM-reaching run() returns false when its control is absent, so the key passes through rather
// than pretending to have acted.
// The jarvis surface's guard. Module-level rather than a local `on` inside buildJarvisBindings, because the
// graph chord and the surface's own keys are registered from different call sites and a second copy of this
// predicate is how the two become different chords wearing the same keys.
const onJarvis = (ctx: KeyContext) => ctx.surface === "jarvis" && !ctx.editable && !ctx.modalOpen;

export function buildJarvisGraphBindings(): Binding[] {
    return [
        {
            id: "jarvis:graph-peek",
            keys: "Shift:g",
            group: "Jarvis",
            label: "Graph peek (Esc closes)",
            when: onJarvis,
            run: () => globalStore.set(graphPeekOpenAtom, (v) => !v),
        },
    ];
}

export function buildJarvisBindings(): Binding[] {
    // the peek is an overlay over the whole Stage: acting behind it would change a surface the user cannot
    // see. Only its own toggle stays live (the peek also closes on Escape, which it owns while open).
    const onStage = (ctx: KeyContext) => onJarvis(ctx) && !globalStore.get(graphPeekOpenAtom);

    const clickThrough = (selector: string): boolean | void => {
        const el = document.querySelector<HTMLElement>(selector);
        if (el == null) {
            return false;
        }
        el.click();
    };

    // the run switcher, keyboard-side: the same list the Subjects column expands under the selected
    // channel, in the same order, moved with the same clamped cursor the lists use.
    const stepRun = (delta: number): boolean | void => {
        const subject = globalStore.get(activeSubjectAtom);
        if (subject?.kind !== "channel") {
            return false; // only a channel has runs to switch between
        }
        const runs = globalStore.get(activeChannelRunsAtom);
        if (runs.length < 2) {
            return false;
        }
        const cur = resolveActiveRunId(runs, globalStore.get(activeRunIdAtom)[subject.id]);
        const next = moveCursor(
            runs.map((r) => r.id),
            cur,
            delta
        );
        if (next == null || next === cur) {
            return false;
        }
        setActiveRunId(subject.id, next);
    };

    return [
        {
            id: "jarvis:new-thread",
            keys: "n",
            group: "Jarvis",
            label: "New thread",
            when: onStage,
            run: () => void startJarvisThread(),
        },
        ...buildJarvisGraphBindings(),
        {
            id: "jarvis:new-run",
            keys: "r",
            group: "Jarvis",
            label: "New run",
            when: onStage,
            run: () => clickThrough("[data-jarvis-new-run]"),
        },
        {
            id: "jarvis:new-initiative",
            keys: "Shift:n",
            group: "Jarvis",
            label: "New initiative",
            when: onStage,
            run: () => clickThrough("[data-jarvis-new-initiative]"),
        },
        {
            id: "jarvis:record-band",
            keys: "e",
            group: "Jarvis",
            label: "Expand / collapse the record band",
            when: onStage,
            run: () => clickThrough("[data-jarvis-band-toggle]"),
        },
        {
            id: "jarvis:next-run",
            keys: "Shift:j",
            group: "Jarvis",
            label: "Next run in this channel",
            when: onStage,
            run: () => stepRun(1),
        },
        {
            id: "jarvis:prev-run",
            keys: "Shift:k",
            group: "Jarvis",
            label: "Previous run in this channel",
            when: onStage,
            run: () => stepRun(-1),
        },
        {
            id: "jarvis:focus-composer",
            keys: "i",
            group: "Jarvis",
            label: "Focus the composer",
            when: onStage,
            run: () => {
                const el = document.querySelector<HTMLElement>(
                    "[data-jarvis-composer] input, [data-jarvis-composer] textarea"
                );
                if (el == null) {
                    return false;
                }
                el.focus();
            },
        },
        {
            id: "jarvis:blur-composer",
            keys: "Escape",
            group: "Jarvis",
            label: "Leave the composer",
            paletteHidden: true,
            // the counterpart to `i`. Guarded on editable only, so `when` stays pure; run() checks *which*
            // field has focus, because the rename box and the subject filter own their own Escape — and
            // blurring the rename box would commit the rename instead of cancelling it.
            when: (ctx) => ctx.surface === "jarvis" && ctx.editable && !ctx.modalOpen,
            run: () => {
                const el = document.activeElement as HTMLElement | null;
                if (el?.closest?.("[data-jarvis-composer]") == null) {
                    return false;
                }
                el.blur();
            },
        },
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
        // documentation-only, so a palette row would be a dead button: run() deliberately performs
        // nothing, and the surface's own onKeyDown never sees a click. The cheat sheet still lists them.
        paletteHidden: true,
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
const agentNavStrict = (ctx: KeyContext) => navigateStrict(ctx) && ctx.surface === "agent";

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
            // with agent:back below (both guarded on focusSubagentAtom), so no key conflict. Still
            // yields to an open modal — the dialog owns Escape, and this dispatcher runs on window
            // capture, so without the guard it would consume the key and the dialog would never close.
            // A tree row's rename box owns it for the same reason, and needs saying separately: every
            // other Escape here is gated on !editable, which would exclude a focused input on its own,
            // but this one cannot use that gate (the terminal textarea holds focus for most of this
            // surface's life). Unguarded, Escape would exit the subagent while the box stayed open —
            // and the box would then commit on blur the name the user was trying to discard.
            when: (ctx) =>
                ctx.surface === "agent" &&
                !ctx.modalOpen &&
                globalStore.get(renamingRowAtom) == null &&
                globalStore.get(focusSubagentAtom) != null,
            run: () => globalStore.set(focusSubagentAtom, null),
        },
        {
            id: "agent:back",
            keys: "Escape",
            group: "Agent",
            label: "Back to Cockpit (or exit fullscreen)",
            when: (ctx) => agentNavStrict(ctx) && globalStore.get(focusSubagentAtom) == null,
            run: () => {
                if (globalStore.get(terminalFullscreenAtom)) {
                    globalStore.set(terminalFullscreenAtom, false);
                } else {
                    globalStore.set(model.surfaceAtom, "cockpit");
                }
            },
        },
        {
            id: "agent:prev",
            keys: "ArrowLeft",
            group: "Agent",
            label: "Previous agent",
            when: agentNav,
            run: () => step(-1),
        },
        {
            id: "agent:next",
            keys: "ArrowRight",
            group: "Agent",
            label: "Next agent",
            when: agentNav,
            run: () => step(1),
        },
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
            // The leader letter `f` is taken by the Diff surface (GO_TARGETS), so fullscreen needs a
            // chord to stay reachable from inside the TUI. F11 is the universal convention, carries no
            // editor muscle memory, and is not a key a TUI's text input consumes. Deliberately NOT
            // gated on !editable — same shape as close-agent's Ctrl+C, which stays live in the terminal.
            id: "agent:fullscreen-chord",
            keys: "F11",
            group: "Agent",
            // named apart from agent:fullscreen's "Toggle terminal fullscreen" so the cheat sheet does
            // not show two rows with one label; the parenthetical is what distinguishes this door
            label: "Toggle terminal fullscreen (works inside the terminal)",
            paletteHidden: true, // duplicates agent:fullscreen, which already has a palette row
            when: (ctx) => ctx.surface === "agent" && !ctx.modalOpen,
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

// Diff-surface keys. `c` is the entry gesture the mockup names; Escape is the single exit; Tab jumps
// between the two compare sides. Entering compare needs a cwd and a branch, which only the surface
// knows, so `c` clicks the control the surface already draws (the same clickThrough shape
// buildJarvisBindings uses) rather than duplicating scope resolution here.
export function buildFilesBindings(): Binding[] {
    const on = (ctx: KeyContext) => ctx.surface === "files" && !ctx.editable && !ctx.modalOpen;
    const inCompare = (ctx: KeyContext) => on(ctx) && globalStore.get(compareOnAtom);
    // History keys are off while compare is on: compare has no filter row and draws no graph.
    const inHistory = (ctx: KeyContext) => on(ctx) && !globalStore.get(compareOnAtom);
    const filtering = (ctx: KeyContext) => inHistory(ctx) && anyFilterActive(globalStore.get(historyFiltersAtom));
    return [
        {
            id: "files:filter",
            keys: "/",
            group: "Diff",
            label: "Filter history",
            when: inHistory,
            run: () => {
                const el = document.querySelector<HTMLInputElement>("[data-history-filter]");
                if (el == null) {
                    return false; // no filter row on screen (a failure panel, say) — let the key pass
                }
                el.focus();
            },
        },
        {
            // Shift:g, not bare "g": g is the leader key for the surface chords, and a bare letter
            // that shadows a leader can never fire. The footer shows it as "G".
            id: "files:toggle-graph",
            keys: "Shift:g",
            group: "Diff",
            label: "Toggle graph",
            when: inHistory,
            run: () => globalStore.set(graphOnAtom, !globalStore.get(graphOnAtom)),
        },
        {
            // Escape's order on this surface: clear filters, else leave compare, else go home. The
            // three guards are mutually exclusive by construction (this one requires filters active
            // and compare off), which is what keeps assertNoConflicts passing.
            id: "files:clear-filters",
            keys: "Escape",
            group: "Diff",
            label: "Clear filters",
            when: filtering,
            run: () => clearHistoryFilters(),
        },
        {
            // The mockup's footer says "g h" for top-of-history, but g h is already the chord for
            // Cockpit (home) in GO_TARGETS. g g is free and is the vim idiom for "top".
            id: "files:top",
            keys: "g g",
            group: "Diff",
            label: "Top of history",
            when: inHistory,
            run: () => {
                globalStore.set(historyScrollAtom, 0);
                const el = document.querySelector<HTMLElement>("[data-history-scroll]");
                if (el != null) {
                    el.scrollTop = 0;
                }
            },
        },
        {
            id: "files:compare",
            keys: "c",
            group: "Diff",
            label: "Compare refs",
            when: on,
            run: () => {
                const el = document.querySelector<HTMLElement>('[data-range-chip="compare"]');
                if (el == null) {
                    return false; // no repository scoped -> nothing to compare; let the key pass
                }
                el.click();
            },
        },
        {
            id: "files:refresh",
            keys: "r",
            group: "Diff",
            label: "Refresh changes",
            when: on,
            run: () => {
                void reloadChanges(globalStore.get(filesStateAtom)?.cwd ?? null);
            },
        },
        {
            id: "files:exit-compare",
            keys: "Escape",
            group: "Diff",
            label: "Back to history",
            when: inCompare,
            run: () => leaveCompare(),
        },
        {
            id: "files:switch-side",
            keys: "Tab",
            group: "Diff",
            label: "Switch compare side",
            when: inCompare,
            run: () => {
                const c = globalStore.get(listNavAtom);
                if (c == null || c.surface !== "files") {
                    return false;
                }
                // the surface publishes its compare rows on the controller; the cast is the seam that
                // keeps listnav.ts free of this surface's row types
                const target = sideJumpTarget((c.rows ?? []) as CompareRow[], globalStore.get(compareSelectionAtom));
                if (target == null) {
                    return false; // the other side has no commits — let Tab do its normal thing
                }
                c.setCursor(target);
            },
        },
    ];
}

export function buildCodeBindings(): Binding[] {
    const on = (ctx: KeyContext) => ctx.surface === "code" && !ctx.editable && !ctx.modalOpen;
    // Live whenever the tree pane holds focus. Focus is read from an atom, not the DOM:
    // store.test.ts evaluates every `when` in vitest's node environment, where document is
    // undefined. !editable matters because the inline name input lives INSIDE the tree — its
    // focusin bubbles, so the atom stays true while you type a filename, and without this gate
    // Enter reaches code:tree-activate first and opens the cursor's file instead of committing
    // the name (n, F2 and Delete are stolen the same way).
    const inTree = (ctx: KeyContext) =>
        ctx.surface === "code" && !ctx.editable && !ctx.modalOpen && globalStore.get(codeTreeFocusedAtom);
    const treeKey = (key: TreeKey) => (): void | boolean => {
        const action = treeKeyAction(globalStore.get(codeRowsAtom), globalStore.get(codeCursorAtom), key);
        switch (action.kind) {
            case "move":
                globalStore.set(codeCursorAtom, action.path);
                return;
            case "toggle":
                toggleDir(action.path);
                return;
            case "open":
                void openPath(action.path);
                return;
            case "none":
                return false; // nothing to do here — let the key pass
        }
    };
    return [
        // The file finder has no chord of its own: the global "palette" binding owns Ctrl+P and
        // routes it here whenever this surface is active.
        {
            id: "code:back",
            keys: "Alt:ArrowLeft",
            group: "Code",
            label: "Back",
            when: on,
            run: () => {
                void goBack();
            },
        },
        {
            id: "code:forward",
            keys: "Alt:ArrowRight",
            group: "Code",
            label: "Forward",
            when: on,
            run: () => {
                void goForward();
            },
        },
        {
            id: "code:refresh",
            keys: "r",
            group: "Code",
            label: "Refresh the file index",
            when: on,
            run: () => {
                void refreshIndex();
            },
        },
        {
            id: "code:diff",
            keys: "d",
            group: "Code",
            label: "Toggle the diff against HEAD",
            when: on,
            run: () => {
                const mode = globalStore.get(codeViewModeAtom);
                globalStore.set(codeViewModeAtom, mode === "diff" ? "source" : "diff");
            },
        },
        {
            id: "code:save",
            keys: "Ctrl:s",
            group: "Code",
            label: "Save the open file",
            // deliberately NOT gated on !ctx.editable: you are typing in Monaco when you press this, so
            // the editable exclusion the bare-letter bindings use would make it unreachable. Same shape
            // as close-agent's Ctrl:c, which stays live while the terminal has focus.
            when: (ctx) => ctx.surface === "code",
            run: () => {
                void saveCurrent();
            },
        },
        {
            id: "code:tree-next",
            keys: "j",
            group: "Code",
            label: "Next file or folder",
            when: inTree,
            run: treeKey("next"),
        },
        {
            id: "code:tree-prev",
            keys: "k",
            group: "Code",
            label: "Previous file or folder",
            when: inTree,
            run: treeKey("prev"),
        },
        {
            id: "code:tree-next-arrow",
            keys: "ArrowDown",
            group: "Code",
            label: "Next file or folder",
            when: inTree,
            run: treeKey("next"),
        },
        {
            id: "code:tree-prev-arrow",
            keys: "ArrowUp",
            group: "Code",
            label: "Previous file or folder",
            when: inTree,
            run: treeKey("prev"),
        },
        {
            id: "code:tree-collapse",
            keys: "ArrowLeft",
            group: "Code",
            label: "Collapse folder",
            when: inTree,
            run: treeKey("collapse"),
        },
        {
            id: "code:tree-expand",
            keys: "ArrowRight",
            group: "Code",
            label: "Expand folder",
            when: inTree,
            run: treeKey("expand"),
        },
        {
            id: "code:tree-activate",
            keys: "Enter",
            group: "Code",
            label: "Open file / toggle folder",
            when: inTree,
            run: treeKey("activate"),
        },
        {
            id: "code:new-file",
            keys: "n",
            group: "Code",
            label: "New file in the cursor's directory",
            when: inTree,
            run: () => startCreate(false),
        },
        {
            id: "code:new-folder",
            keys: "Shift:n",
            group: "Code",
            label: "New folder in the cursor's directory",
            when: inTree,
            run: () => startCreate(true),
        },
        {
            id: "code:rename",
            keys: "F2",
            group: "Code",
            label: "Rename the cursor row",
            when: inTree,
            run: () => {
                const cursor = globalStore.get(codeCursorAtom);
                if (cursor == null) {
                    return false; // nothing named, so let the key pass
                }
                startRename(cursor);
            },
        },
        {
            id: "code:delete",
            keys: "Delete",
            group: "Code",
            label: "Delete the cursor row",
            when: inTree,
            run: () => {
                const cursor = globalStore.get(codeCursorAtom);
                const row = globalStore.get(codeRowsAtom).find((r) => r.path === cursor);
                if (row == null) {
                    return false;
                }
                confirmDelete(row.path, row.kind === "dir");
            },
        },
        {
            id: "code:search",
            keys: "Ctrl:Shift:f",
            group: "Code",
            label: "Search file contents",
            // like the file finder's Ctrl+P and save's Ctrl+S, deliberately NOT gated on !editable:
            // the caret is in Monaco when you want this, so a bare letter would be unreachable
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                globalStore.set(codeSearchModeAtom, "search");
                focusCodeSidebarOpener();
            },
        },
        {
            id: "code:focus-tree",
            keys: "Alt:t",
            group: "Code",
            label: "Focus the file tree",
            // reaching the tree from a writable editor needs a modified key; a bare letter is
            // swallowed by Monaco, which is why the finder moved to Ctrl+P
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                globalStore.set(codeSearchModeAtom, "files");
                // a DOM read in `run` is the established convention here (see files:compare)
                if (focusCodeSidebarOpener()) {
                    window.requestAnimationFrame(focusCodeTree);
                    return;
                }
                focusCodeTree();
            },
        },
        {
            id: "code:focus-editor",
            keys: "Alt:e",
            group: "Code",
            label: "Focus the editor",
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                // Both edit-context hosts: the EditContext div Monaco uses by default since 0.52, and
                // the legacy textarea. `.monaco-editor textarea` alone matches the readonly aria-hidden
                // IME textarea first, so focus landed somewhere that swallows every keystroke.
                const host = document.querySelector<HTMLElement>(
                    ".monaco-editor .native-edit-context, .monaco-editor textarea.inputarea"
                );
                if (host == null) {
                    return false; // no editor open — let the key pass
                }
                host.focus();
            },
        },
    ];
}

// The Vault's review-queue triage keys. The cursor indexes the VISIBLE queue (scope chip + search),
// not the raw pending list, so a filtered pass moves through what is actually on screen. Every run()
// reads live atoms, so the returned array never needs rebuilding.
export function buildVaultBindings(): Binding[] {
    const readerOpen = () => globalStore.get(vaultReaderAtom) != null;
    // triage owns these keys only while the queue has the focus and nothing is overlaying it
    const inQueue = (ctx: KeyContext) =>
        ctx.surface === "vault" &&
        !ctx.editable &&
        !ctx.modalOpen &&
        !readerOpen() &&
        globalStore.get(vaultTabAtom) === "memory" &&
        globalStore.get(vaultFocusAtom) === "queue";
    const inReader = (ctx: KeyContext) => ctx.surface === "vault" && !ctx.editable && !ctx.modalOpen && readerOpen();

    const visible = () =>
        filterQueue(
            globalStore.get(memPendingAtom).map((p) => ({
                path: p.path,
                scope: p.scope || "shared",
                source: p.source,
                title: p.title,
                body: p.body,
            })),
            globalStore.get(vaultScopeAtom),
            globalStore.get(memSearchAtom)
        );
    const current = () => {
        const rows = visible();
        return rows[Math.min(globalStore.get(vaultCursorAtom), Math.max(0, rows.length - 1))];
    };
    // moving the cursor also selects, so the rail follows the keyboard rather than the last click
    const move = (delta: number) => {
        const rows = visible();
        const next = moveQueueCursor(rows.length, globalStore.get(vaultCursorAtom), delta);
        globalStore.set(vaultCursorAtom, next);
        const row = rows[next];
        if (row) {
            selectPending(row.path);
            // keep an expanded row expanded as the cursor moves, matching the mockup's j/k feel
            if (globalStore.get(vaultExpandedAtom) != null) {
                globalStore.set(vaultExpandedAtom, row.path);
            }
        }
    };
    const resolve = (keep: boolean) => (): void | boolean => {
        const row = current();
        if (!row) return false;
        void (keep ? keepPending(row.path) : dismissPending(row.path));
    };

    return [
        {
            id: "vault:queue-down",
            keys: "j",
            group: "Vault",
            label: "Next candidate",
            when: inQueue,
            run: () => move(1),
        },
        {
            id: "vault:queue-up",
            keys: "k",
            group: "Vault",
            label: "Previous candidate",
            when: inQueue,
            run: () => move(-1),
        },
        {
            id: "vault:queue-expand",
            keys: "Space",
            group: "Vault",
            label: "Expand or collapse the candidate",
            when: inQueue,
            run: (): void | boolean => {
                const row = current();
                if (!row) return false;
                globalStore.set(vaultExpandedAtom, globalStore.get(vaultExpandedAtom) === row.path ? null : row.path);
                selectPending(row.path);
            },
        },
        {
            id: "vault:queue-keep",
            keys: "Enter",
            group: "Vault",
            label: "Keep the candidate",
            when: inQueue,
            run: resolve(true),
        },
        {
            id: "vault:queue-dismiss",
            keys: "x",
            group: "Vault",
            label: "Dismiss the candidate",
            when: inQueue,
            run: resolve(false),
        },
        {
            id: "vault:queue-read",
            keys: "o",
            group: "Vault",
            label: "Read the whole candidate",
            when: inQueue,
            run: (): void | boolean => {
                const row = current();
                if (!row) return false;
                globalStore.set(vaultReaderAtom, { kind: "pending", path: row.path });
            },
        },
        {
            id: "vault:reader-close",
            keys: "Escape",
            group: "Vault",
            label: "Back from the reader",
            when: inReader,
            run: () => globalStore.set(vaultReaderAtom, null),
        },
    ];
}
