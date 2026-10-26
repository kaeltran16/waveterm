// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { launchPiTab } from "@/app/cockpit/cockpit-actions";
import { buildViews } from "@/app/cockpit/resmon";
import {
    confirmResMon,
    dispatchResMon,
    resmonOpenAtom,
    resmonSnapshotAtom,
    resmonUiAtom,
} from "@/app/cockpit/resmonstore";
import { cheatsheetOpenAtom } from "@/app/cockpit/shortcuts-cheatsheet";
import { escapeMenusOpenAtom } from "@/app/hook/useEscapeClose";
import { anyModalOpen } from "@/app/modals/modalstack";
import { globalStore } from "@/app/store/jotaiStore";
import { confirmCloseSession } from "@/app/view/agents/agentactions";
import { getProcExitAtom } from "@/app/view/agents/agentcontrollerstore";
import { AgentsViewModel, SURFACE_ORDER, type SurfaceKey } from "@/app/view/agents/agents";
import { answerDigitTarget, canSubmitAsk, moveCursor, type AgentVM } from "@/app/view/agents/agentsviewmodel";
import {
    checkMain,
    checkReview,
    OPTION_KEYS,
    optionLetter,
    paneBack,
    paneView,
    pickableOptions,
    type BrainstormAction,
    type ReviewRow,
} from "@/app/view/agents/brainstormmodel";
import { sendBrainstorm } from "@/app/view/agents/brainstormsend";
import {
    focusedBrainstorm,
    moveReviewCursor,
    openBrainstormBoard,
    openBrainstormDesign,
    setBrainstormMode,
    shownBrainstormFile,
    toggleReviewRow,
} from "@/app/view/agents/brainstormstore";
import { paneState } from "@/app/view/agents/canvasmodel";
import {
    focusedCanvas,
    focusedCanvasMode,
    setCanvasMode,
    setMarking,
    stepCanvasBoard,
} from "@/app/view/agents/canvasstore";
import { activeChannelRunsAtom } from "@/app/view/agents/channelsstore";
import { sendPendingComments } from "@/app/view/agents/commentsend";
import { sideJumpTarget, type CompareRow } from "@/app/view/agents/comparerows";
import { compareOnAtom, compareSelectionAtom, leaveCompare, swapCompareRefs } from "@/app/view/agents/comparestore";
import { commentOnSelection } from "@/app/view/agents/diffcommentlayer";
import { historyCollapsedAtom } from "@/app/view/agents/difflayout";
import { gotoChange } from "@/app/view/agents/diffnav";
import { ignoreWsAtom, splitViewAtom } from "@/app/view/agents/diffoptions";
import { docReviewAtom, parseDocReview } from "@/app/view/agents/docreview";
import { filesStateAtom, reloadChanges } from "@/app/view/agents/filesstore";
import {
    clearHistoryFilters,
    graphOnAtom,
    historyFiltersAtom,
    historyScrollAtom,
    refreshHistory,
} from "@/app/view/agents/githistorystore";
import { anyFilterActive } from "@/app/view/agents/historyquery";
import { railVisibleAtom, terminalFullscreenAtom } from "@/app/view/agents/railstore";
import { toggleOpenFile } from "@/app/view/agents/reviewmarks";
import { renamingRowAtom } from "@/app/view/agents/rowrenameatom";
import { resolveActiveRunId } from "@/app/view/agents/runmodel";
import { shellTaskPeekAtom } from "@/app/view/agents/shelltasksstore";
import { focusSubagentAtom } from "@/app/view/agents/subagentsstore";
import { codeSearchModeAtom } from "@/app/view/code/codesearchstore";
import {
    caretWord,
    codeCursorAtom,
    codeRowsAtom,
    codeTreeFocusedAtom,
    codeViewModeAtom,
    confirmDelete,
    findReferences,
    goBack,
    goForward,
    goToDefinition,
    openPath,
    refreshIndex,
    saveCurrent,
    startCreate,
    startRename,
    toggleDir,
} from "@/app/view/code/codestore";
import { treeKeyAction, type TreeKey } from "@/app/view/code/codetreekeys";
import { autonomyPanelOpenAtom } from "@/app/view/jarvis/autonomyladder";
import { finalShotsViewerOpenAtom } from "@/app/view/jarvis/finalshotsstore";
import {
    briefPeekRecordAtom,
    chunkMoveAtom,
    graphPeekOpenAtom,
    noteChunkAtom,
    readingNoteAtom,
    trackerMenuAtom,
} from "@/app/view/jarvis/jarvisstore";
import { activeRunIdAtom, activeSubjectAtom, setActiveRunId } from "@/app/view/jarvis/jarvissubjectstore";
import { peekTarget } from "@/app/view/jarvis/openref";
import { petPeekOpenAtom } from "@/app/view/jarvis/petstore";
import { backToOrigin } from "@/app/view/jarvis/returnsurface";
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

function focusCodeSearchInput(): void {
    const input = document.querySelector<HTMLInputElement>("[data-code-search-input]");
    if (input != null) {
        input.focus();
        input.select(); // typing replaces the last query, as in every editor's search box
    }
}

// g-leader surface teleports (collision-free letters; see design spec).
const GO_TARGETS: { letter: string; surface: SurfaceKey; label: string }[] = [
    { letter: "h", surface: "cockpit", label: "Cockpit (home)" },
    { letter: "a", surface: "agent", label: "Agent" },
    { letter: "c", surface: "jarvis", label: "Jarvis (projects, records, recall)" },
    { letter: "s", surface: "sessions", label: "Sessions" },
    { letter: "f", surface: "files", label: "Diff" },
    { letter: "u", surface: "usage", label: "Usage" },
    { letter: "b", surface: "code", label: "Code (browse source)" },
    { letter: ".", surface: "setup", label: "Setup (instructions and skills)" },
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

// Every Escape binding that can be live under a hand-rolled dropdown (useEscapeClose) carries this. The
// dispatcher runs on window capture and stops propagation when a binding runs, so the dropdown's own bubble
// listener never sees the key unless the bindings stand down while it is open.
const noEscapeMenuOpen = () => globalStore.get(escapeMenusOpenAtom) === 0;

// Deep (non-home) surfaces whose Escape returns to the Cockpit. Excludes cockpit (already home), agent
// (owns Escape via buildAgentBindings: exit fullscreen / back), and settings.
const ESC_HOME_SURFACES = new Set<SurfaceKey>(["jarvis", "sessions", "files", "usage", "code"]);

// A key that clicks a control the surface already draws, rather than duplicating what the control knows.
// No control on screen lets the key pass.
const clickThrough = (selector: string): boolean | void => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el == null) {
        return false;
    }
    el.click();
};

// `[` `]` belong to the boards in canvas mode, so the surface switch stands down while the focused agent shows
// its canvas (never for an agent with a brainstorm). The agent switches stay live: the tree stays on screen
// beside the canvas.
const inAgentCanvas = (model: AgentsViewModel, ctx: KeyContext) =>
    ctx.surface === "agent" && focusedCanvasMode(model) != null && focusedBrainstorm(model) == null;

// Spec §5 (agent-tab-fixes): the second Ctrl+C closes the *focused* session — agent or plain
// terminal alike (the UI labels both "terminal": "Close terminal — ends the agent"). Returns null
// only when nothing focusable is targeted, so the press falls through to the PTY instead.
export function closeTargetForDoubleCtrlC(agents: AgentVM[], focusId: string | undefined): AgentVM | null {
    if (!focusId) {
        return null;
    }
    return agents.find((x) => x.id === focusId) ?? null;
}

// a brainstorm or canvas pane hides the terminal and pulls focus to the surface, so the press counts anywhere on
// the surface there; with the terminal showing it counts only inside it, so ^C elsewhere stays a plain key
export function ctrlCReachesSession(inTerm: boolean, inSurface: boolean, paneShown: boolean): boolean {
    return inTerm || (paneShown && inSurface);
}

// same rule as the agent surface's paneMode: an agent with a brainstorm never shows its canvas
function focusedPaneShown(model: AgentsViewModel): boolean {
    const brainstorm = focusedBrainstorm(model);
    return brainstorm != null ? brainstorm.mode === "brainstorm" : focusedCanvasMode(model) != null;
}

// Escape on a surface: back over the jump that brought the user here, and home when there was none
function backOrHome(model: AgentsViewModel): void {
    if (!backToOrigin()) {
        globalStore.set(model.surfaceAtom, "cockpit");
    }
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
            when: (ctx) => navigate(ctx) && !inAgentCanvas(model, ctx),
            run: () => cycleSurface(1),
        },
        {
            id: "surface:prev",
            keys: "[",
            group: "Navigation",
            label: "Previous surface",
            when: (ctx) => navigate(ctx) && !inAgentCanvas(model, ctx),
            run: () => cycleSurface(-1),
        },
        {
            // The one search overlay. On Code it opens on the Files scope (VS Code's Ctrl+P), which is
            // where Code's own file finder folded in. Deliberately unguarded — search has to be
            // reachable from inside a text field, and a binding that always matches is also what keeps
            // WebView2's print dialog off this key. `g p` opens it too.
            id: "palette",
            keys: "Ctrl:p",
            group: "Global",
            label: "Search (files on Code)",
            paletteHidden: true, // a palette row that opens the palette
            run: () => globalStore.set(model.paletteOpenAtom, (v) => !v),
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
            label: "Search",
            paletteHidden: true, // a palette row that opens the palette
            when: navigate,
            run: () => globalStore.set(model.paletteOpenAtom, true),
        },
        {
            id: "go:resmon",
            keys: "g m",
            group: "Go to",
            label: "Resource Manager",
            when: navigate,
            run: () => globalStore.set(resmonOpenAtom, true),
        },
        {
            id: "new-agent",
            keys: "Ctrl:n",
            group: "Global",
            label: "New agent",
            // yields to an open modal: unguarded it stacked New Agent on top of whatever was already
            // open (the search palette) and pulled focus out of it
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
                const active = document.activeElement as HTMLElement | null;
                const inTerm = active?.closest?.(".cockpit-focus-pane") != null;
                const inSurface = active?.closest?.("[data-cockpit-surface-wrap]") != null;
                if (!ctrlCReachesSession(inTerm, inSurface, focusedPaneShown(model))) {
                    return false;
                }
                const now = performance.now();
                if (lastCtrlC != null && now - lastCtrlC < DOUBLE_CTRL_C_MS) {
                    lastCtrlC = null;
                    const agents = [...globalStore.get(model.agentsAtom), ...globalStore.get(model.terminalsAtom)];
                    const fid = globalStore.get(model.focusIdAtom);
                    const a = closeTargetForDoubleCtrlC(agents, fid);
                    if (a) {
                        confirmCloseSession(a, model);
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
            label: "Back, else to Cockpit",
            // the Jarvis graph peek owns Escape while it is open: closing an overlay is what the user means
            // by Escape there, and navigating home instead would leave the peek open behind the Cockpit.
            // The autonomy panel owns it for the same reason — and it cannot claim the key itself, since
            // this dispatcher runs on window capture, ahead of any handler the panel could register.
            when: (ctx) =>
                navigateStrict(ctx) &&
                ESC_HOME_SURFACES.has(ctx.surface) &&
                // any open ModalShell (the Brief's Profile window, its sheet) closes on Escape itself; going
                // home instead unmounts it with its state still set, so it reopens on the way back
                !anyModalOpen() &&
                !globalStore.get(graphPeekOpenAtom) &&
                !globalStore.get(autonomyPanelOpenAtom) &&
                // and the pet's peek, for the same reason again — it is global chrome, so it can be open
                // on ANY of these surfaces, not just Jarvis
                !globalStore.get(petPeekOpenAtom) &&
                // the Diff surface's compare state owns Escape while it is on: leaving compare is what
                // Escape means there, and going home instead would strand a two-ref read behind the Cockpit
                !globalStore.get(compareOnAtom) &&
                // and with filters active, Escape clears them — the history header says so ("Clear filters", esc)
                !(ctx.surface === "files" && anyFilterActive(globalStore.get(historyFiltersAtom))) &&
                // the Brief's record peek is a ModalShell and the Brief is where every record destination
                // now lands: without this, one press closed the peek AND left the surface — and the peek's
                // own state was never cleared, so coming back showed it open again
                globalStore.get(briefPeekRecordAtom) == null &&
                // the DAG modal takes Escape itself too, and the Brief mounts it as well as Channels
                globalStore.get(dagModalStateAtom) == null &&
                // and the Brief's Chunk sidebar: while a note is open, Escape means "back out of the
                // note", and going home too would do both at once
                globalStore.get(noteChunkAtom) == null &&
                // and the plan-editing menu above it, the innermost rung of all
                globalStore.get(trackerMenuAtom) == null &&
                // and any hand-rolled dropdown (useEscapeClose): it closes on Escape and returns focus itself
                noEscapeMenuOpen(),
            run: () => backOrHome(model),
        },
    ];
}

// One shared set of list-cursor bindings for the plain master-detail surfaces. Active only when the
// mounted surface has published a controller (listnav.ts) for itself and focus is not in a field.
export function buildListNavBindings(model: AgentsViewModel): Binding[] {
    const active = (ctx: KeyContext): boolean => {
        if (ctx.editable || ctx.modalOpen) {
            return false;
        }
        const c = globalStore.get(listNavAtom);
        return c != null && c.surface === ctx.surface;
    };
    const rowPeek = () => globalStore.get(listNavAtom)?.peekTarget?.() ?? null;
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
        {
            id: "list:peek",
            keys: "Space",
            group: "Navigation",
            label: "Peek the item in the avatar popup",
            when: (ctx) => active(ctx) && rowPeek() != null,
            paletteHidden: true,
            run: () => {
                const target = rowPeek();
                if (target == null) {
                    return false;
                }
                void peekTarget(model, target);
            },
        },
    ];
}

// Run sheet ask keys: the ask card renders numbered (1-9) answer badges (channelsprimitives AskRow), but
// the digit handler used to be cockpit-only. These bindings make the badges functional on the Brief's run
// sheet, targeting the shown run's asking lead (published live via askAgentRef). Reuses answerDigitTarget +
// model.toggleAnswer/submitAnswer — no duplicated logic.
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

    // One rung per press: an expanded note card folds, then the sidebar closes. Only then does Escape
    // fall through to esc-home, which is guarded on the same atom — otherwise a single press would close
    // the note AND leave the surface.
    const noteSidebarEscape: Binding = {
        id: "jarvis:close-notes",
        keys: "Escape",
        group: "Jarvis",
        label: "Back out of the Chunk sidebar",
        when: (ctx) =>
            onJarvis(ctx) &&
            globalStore.get(noteChunkAtom) != null &&
            globalStore.get(trackerMenuAtom) == null &&
            noEscapeMenuOpen(),
        run: () => {
            if (globalStore.get(readingNoteAtom).size > 0) {
                globalStore.set(readingNoteAtom, new Set());
                return;
            }
            globalStore.set(noteChunkAtom, null);
        },
    };

    // an open status or stage menu sits above the sidebar: Escape closes the menu and nothing else
    const trackerMenuEscape: Binding = {
        id: "jarvis:close-tracker-menu",
        keys: "Escape",
        group: "Jarvis",
        label: "Close the plan menu",
        when: (ctx) => onJarvis(ctx) && globalStore.get(trackerMenuAtom) != null && noEscapeMenuOpen(),
        run: () => globalStore.set(trackerMenuAtom, null),
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
        trackerMenuEscape,
        noteSidebarEscape,
        ...buildJarvisGraphBindings(),
        {
            id: "jarvis:new-run",
            keys: "r",
            group: "Jarvis",
            label: "New run",
            when: onStage,
            run: () => clickThrough("[data-new-run]"),
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
            id: "jarvis:work-on",
            keys: "w",
            group: "Jarvis",
            label: "Work on the initiative under the cursor, or go to its open agent",
            when: onStage,
            run: () => clickThrough('[data-jarvis-brief-cursor="true"] [data-jarvis-work-on]'),
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
            label: "Next run in this project",
            when: onStage,
            run: () => stepRun(1),
        },
        {
            id: "jarvis:prev-run",
            keys: "Shift:k",
            group: "Jarvis",
            label: "Previous run in this project",
            when: onStage,
            run: () => stepRun(-1),
        },
        {
            id: "jarvis:chunk-up",
            keys: "Alt:ArrowUp",
            group: "Jarvis",
            label: "Move the chunk up within its stage",
            when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,
            run: () => globalStore.get(chunkMoveAtom)?.("up"),
        },
        {
            id: "jarvis:chunk-down",
            keys: "Alt:ArrowDown",
            group: "Jarvis",
            label: "Move the chunk down within its stage",
            when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,
            run: () => globalStore.get(chunkMoveAtom)?.("down"),
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
            id: "jarvis:filter",
            keys: "/",
            group: "Jarvis",
            label: "Filter the Brief",
            when: onStage,
            run: () => {
                const el = document.querySelector<HTMLInputElement>("[data-jarvis-brief-filter]");
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
        doc("cockpit:next", "j", "Next card or task row (↓ / j)"),
        doc("cockpit:prev", "k", "Previous card or task row (↑ / k)"),
        doc("cockpit:next-ask", "n", "Jump to next ask"),
        doc("cockpit:column", "h", "Other column (← → / h l); on a multi-question ask, switch question"),
        doc("cockpit:answer", "1", "Select an answer option (1–9); on a task row with no question, run its action"),
        doc("cockpit:open", "Enter", "Confirm answer, else open focus; on a task row, open its worker"),
        doc("cockpit:peek", "Space", "Peek the agent in the avatar popup (Ctrl+click a link peeks it too)"),
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
    const reviewableId = (): string | null => {
        const id = globalStore.get(model.focusIdAtom);
        const agent = globalStore.get(model.agentsAtom).find((a) => a.id === id);
        return agent != null && parseDocReview(agent.ask) != null ? agent.id : null;
    };
    const brainstorm = () => focusedBrainstorm(model);
    const inBrainstorm = (ctx: KeyContext) => agentNav(ctx) && brainstorm()?.mode === "brainstorm";
    // the exit the pane reads, so an exited agent's card holds the keys as the pane holds the review
    const exited = () => {
        const agent = globalStore.get(model.agentsAtom).find((a) => a.id === focusId());
        return agent != null && globalStore.get(getProcExitAtom(agent.blockId ?? "")) != null;
    };
    // the check's review fills the main area: j and k move its cursor instead of the agents, and y, u and Enter act
    // on the cursor row
    const inReview = (ctx: KeyContext) => {
        if (!inBrainstorm(ctx)) {
            return false;
        }
        const s = brainstorm()!;
        const f = shownBrainstormFile(s);
        return f != null && paneView({ ...s, exited: exited() }) === "check" && checkMain(f, s.designOpen) === "review";
    };
    const reviewRow = () => {
        const s = brainstorm();
        const f = shownBrainstormFile(s);
        if (s == null || f == null || s.review.cursor == null) {
            return null;
        }
        const r = checkReview(f);
        return [...r.changed, ...r.fresh].find((x) => x.id === s.review.cursor) ?? null;
    };
    const reviewIds = () => {
        const f = shownBrainstormFile(brainstorm());
        return f == null ? [] : checkReview(f).cursorIds;
    };
    // the row's line goes to the focused agent; with no row or no line for it, or while the agent writes (the row's
    // buttons are locked then too), the key passes on
    const sendReview = (action: (row: ReviewRow) => BrainstormAction | null) => {
        if (shownBrainstormFile(brainstorm())?.working != null) {
            return false;
        }
        const row = reviewRow();
        const a = row == null ? null : action(row);
        const agent = globalStore.get(model.agentsAtom).find((x) => x.id === focusId());
        if (a == null || agent == null) {
            return false;
        }
        sendBrainstorm(agent, a).catch((e) => console.warn("brainstorm review: sending failed", agent.id, a, e));
    };
    // the asked question's options the pane draws, each picked by its letter
    const pickable = () => {
        const s = brainstorm();
        return s == null ? 0 : pickableOptions(shownBrainstormFile(s), s);
    };
    // an agent with a brainstorm never shows its canvas, so the canvas keys stand down for it
    const canvas = () => (brainstorm() == null ? focusedCanvas(model) : null);
    // canvas and brainstorm modes hide the rail and the terminal, so their keys stand down there
    const noCanvas = () => canvas()?.mode !== "canvas" && brainstorm()?.mode !== "brainstorm";
    const nav = (ctx: KeyContext) => agentNav(ctx) && noCanvas();
    const inCanvas = (ctx: KeyContext) => agentNav(ctx) && canvas()?.mode === "canvas";
    const boardReady = (ctx: KeyContext) => inCanvas(ctx) && !canvas()!.marking && paneState(canvas()!) === "board";
    const focusId = () => globalStore.get(model.focusIdAtom);
    // the step the brainstorm pane's back control takes, which Esc takes too. A drawn mark's note owns Esc on the
    // board (it drops the mark there), so the board's step waits for it even while the note's field is unfocused
    const paneStep = () => {
        const s = brainstorm();
        if (s?.mode !== "brainstorm") {
            return null;
        }
        const step = paneBack({ ...s, exited: exited() }, shownBrainstormFile(s));
        return step === "board" && focusedCanvas(model)?.mark != null ? null : step;
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
                noEscapeMenuOpen() &&
                globalStore.get(focusSubagentAtom) != null,
            run: () => globalStore.set(focusSubagentAtom, null),
        },
        {
            // guarded as subagent:back is, so Esc in an open row rename or modal is theirs
            id: "shelltask:back",
            keys: "Escape",
            group: "Agent",
            label: "Close the shell task output peek",
            when: (ctx) =>
                ctx.surface === "agent" &&
                !ctx.modalOpen &&
                globalStore.get(renamingRowAtom) == null &&
                noEscapeMenuOpen() &&
                globalStore.get(shellTaskPeekAtom) != null,
            run: () => globalStore.set(shellTaskPeekAtom, null),
        },
        {
            id: "agent:back",
            keys: "Escape",
            group: "Agent",
            label: "Back, else to Cockpit (or exit fullscreen)",
            when: (ctx) =>
                agentNavStrict(ctx) &&
                noEscapeMenuOpen() &&
                globalStore.get(focusSubagentAtom) == null &&
                globalStore.get(shellTaskPeekAtom) == null &&
                noCanvas(),
            run: () => {
                if (globalStore.get(terminalFullscreenAtom)) {
                    globalStore.set(terminalFullscreenAtom, false);
                } else {
                    backOrHome(model);
                }
            },
        },
        {
            // agent:back stands down in brainstorm mode, so this is the pane's Escape: its back control, one level
            // per press. Guarded as agent:back is, so a focused field keeps its own Esc (the answer box, a row's
            // edit or rename, the builder-check answer, the mark note), as do an open modal and an escape menu
            id: "agent:brainstorm-back",
            keys: "Escape",
            group: "Agent",
            label: "Back in the brainstorm: from a full-size board, or from the design to the question",
            when: (ctx) =>
                agentNavStrict(ctx) &&
                noEscapeMenuOpen() &&
                globalStore.get(focusSubagentAtom) == null &&
                globalStore.get(shellTaskPeekAtom) == null &&
                paneStep() != null,
            run: () => {
                const step = paneStep();
                if (step == null) {
                    return false;
                }
                if (step === "board") {
                    openBrainstormBoard(focusId(), null);
                } else {
                    openBrainstormDesign(focusId(), false);
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
        // in the check's review j and k move between its decisions; the arrows and Ctrl+Tab still move agents
        {
            id: "agent:prev-k",
            keys: "k",
            group: "Agent",
            label: "Previous agent",
            when: (ctx) => agentNav(ctx) && !inReview(ctx),
            run: () => step(-1),
        },
        {
            id: "agent:next-j",
            keys: "j",
            group: "Agent",
            label: "Next agent",
            when: (ctx) => agentNav(ctx) && !inReview(ctx),
            run: () => step(1),
        },
        {
            id: "agent:brainstorm-review-next",
            keys: "j",
            group: "Agent",
            label: "Next decision in the check's review",
            when: inReview,
            run: () => moveReviewCursor(focusId(), reviewIds(), 1),
        },
        {
            id: "agent:brainstorm-review-prev",
            keys: "k",
            group: "Agent",
            label: "Previous decision in the check's review",
            when: inReview,
            run: () => moveReviewCursor(focusId(), reviewIds(), -1),
        },
        {
            id: "agent:brainstorm-review-open",
            keys: "Enter",
            group: "Agent",
            label: "Show what the review's decision was",
            when: inReview,
            // a focused button's Enter is its own press
            run: () => {
                const row = reviewRow();
                if (row == null || document.activeElement?.tagName === "BUTTON") {
                    return false;
                }
                toggleReviewRow(focusId(), row.id);
            },
        },
        {
            id: "agent:brainstorm-review-keep",
            keys: "y",
            group: "Agent",
            label: "Keep the review's change (confirm a guess)",
            when: inReview,
            run: () =>
                sendReview((row) =>
                    row.action === "keep-restore"
                        ? { kind: "keep", part: row.id }
                        : row.action === "confirm"
                          ? { kind: "confirm", part: row.id }
                          : null
                ),
        },
        {
            id: "agent:brainstorm-review-restore",
            keys: "u",
            group: "Agent",
            label: "Put mine back in the review",
            when: inReview,
            run: () => sendReview((row) => (row.action === "keep-restore" ? { kind: "restore", part: row.id } : null)),
        },
        {
            id: "agent:toggle-rail",
            keys: "d",
            group: "Agent",
            label: "Toggle agent rail",
            when: nav,
            run: () => globalStore.set(railVisibleAtom, !globalStore.get(railVisibleAtom)),
        },
        {
            id: "agent:fullscreen",
            keys: "f",
            group: "Agent",
            label: "Toggle terminal fullscreen",
            when: nav,
            run: () => globalStore.set(terminalFullscreenAtom, !globalStore.get(terminalFullscreenAtom)),
        },
        {
            id: "agent:review",
            keys: "r",
            group: "Agent",
            label: "Review",
            // the focused agent lives in model atoms, which a when() cannot read (whenstate.ts watches
            // module atoms only), so run() checks it and lets the key pass when there is nothing to review.
            // Hidden from the palette for the same reason: its row would be dead on most agents.
            paletteHidden: true,
            when: agentNav,
            run: () => {
                const id = reviewableId();
                if (id == null) {
                    return false;
                }
                globalStore.set(docReviewAtom, id);
            },
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
            when: (ctx) => ctx.surface === "agent" && !ctx.modalOpen && noCanvas(),
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
        // b, c and m change meaning with the brainstorm's or the canvas's state, so each is two bindings with
        // exclusive when()s and every footer chip keeps a static label
        {
            id: "agent:canvas-open",
            keys: "c",
            group: "Agent",
            label: "Show the agent's canvas",
            when: (ctx) => agentNav(ctx) && canvas()?.mode === "terminal",
            run: () => setCanvasMode(focusId(), "canvas", Date.now()),
        },
        {
            id: "agent:canvas-close",
            keys: "c",
            group: "Agent",
            label: "Back to the terminal",
            when: inCanvas,
            run: () => setCanvasMode(focusId(), "terminal", Date.now()),
        },
        {
            id: "agent:brainstorm-open",
            keys: "b",
            group: "Agent",
            label: "Show the agent's brainstorm",
            when: (ctx) => agentNav(ctx) && brainstorm()?.mode === "terminal",
            run: () => setBrainstormMode(focusId(), "brainstorm", Date.now()),
        },
        {
            id: "agent:brainstorm-close",
            keys: "b",
            group: "Agent",
            label: "Back to the terminal from the brainstorm",
            // while the question offers a B, b picks it
            when: (ctx) => inBrainstorm(ctx) && pickable() < 2,
            run: () => setBrainstormMode(focusId(), "terminal", Date.now()),
        },
        {
            // b and c only fire off the terminal, and Ctrl+G b / c are Code / Jarvis, so this is the one door
            // that works while typing. A terminal sends it as plain ^B, so no TUI can bind it apart from Ctrl+B.
            // Not gated on editable, like F11. An agent has a brainstorm or a canvas, never both.
            id: "agent:view-chord",
            keys: "Ctrl:Shift:b",
            group: "Agent",
            label: "Switch between the terminal and the agent's brainstorm or canvas (works inside the terminal)",
            when: (ctx) => ctx.surface === "agent" && !ctx.modalOpen && (brainstorm() != null || canvas() != null),
            run: () => {
                const s = brainstorm();
                if (s != null) {
                    setBrainstormMode(focusId(), s.mode === "brainstorm" ? "terminal" : "brainstorm", Date.now());
                    return;
                }
                setCanvasMode(focusId(), canvas()!.mode === "canvas" ? "terminal" : "canvas", Date.now());
            },
        },
        // a letter focuses its answer row, so Enter, the row's own key, sends it
        ...OPTION_KEYS.map(
            (key, i): Binding => ({
                id: `agent:brainstorm-option-${key}`,
                keys: key,
                group: "Agent",
                label: `Pick answer ${optionLetter(i)} of the brainstorm's question`,
                paletteHidden: true,
                when: (ctx) => inBrainstorm(ctx) && pickable() > i,
                run: () => {
                    const row = document.querySelector<HTMLElement>(
                        `[data-brainstorm-pane] [data-brainstorm-option="${i}"]`
                    );
                    if (row == null) {
                        return false;
                    }
                    row.focus();
                },
            })
        ),
        {
            id: "agent:canvas-prev",
            keys: "[",
            group: "Agent",
            label: "Previous board",
            when: boardReady,
            run: () => stepCanvasBoard(focusId(), -1),
        },
        {
            id: "agent:canvas-next",
            keys: "]",
            group: "Agent",
            label: "Next board",
            when: boardReady,
            run: () => stepCanvasBoard(focusId(), 1),
        },
        {
            id: "agent:mark-start",
            keys: "m",
            group: "Agent",
            label: "Mark parts of the board",
            when: boardReady,
            run: () => setMarking(focusId(), true),
        },
        {
            id: "agent:mark-stop",
            keys: "m",
            group: "Agent",
            label: "Stop marking",
            when: (ctx) => inCanvas(ctx) && canvas()!.marking,
            run: () => setMarking(focusId(), false),
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
            // that shadows a leader can never fire. The footer shows it as "⇧G".
            id: "files:toggle-graph",
            keys: "Shift:g",
            group: "Diff",
            label: "Toggle graph",
            when: inHistory,
            run: () => globalStore.set(graphOnAtom, !globalStore.get(graphOnAtom)),
        },
        {
            // Shift:d, not bare "d" — bare letters on this surface sit next to the g leader and "/"
            // and would shadow future chords.
            id: "files:toggle-split",
            keys: "Shift:d",
            group: "Diff",
            label: "Split / unified",
            when: on,
            run: () => globalStore.set(splitViewAtom, !globalStore.get(splitViewAtom)),
        },
        {
            id: "files:toggle-whitespace",
            keys: "Shift:w",
            group: "Diff",
            label: "Ignore whitespace",
            when: on,
            run: () => globalStore.set(ignoreWsAtom, !globalStore.get(ignoreWsAtom)),
        },
        {
            id: "files:swap-refs",
            keys: "Shift:s",
            group: "Diff",
            label: "Swap compare refs",
            when: inCompare,
            run: () => {
                const cwd = globalStore.get(filesStateAtom)?.cwd;
                if (!cwd) {
                    return false; // no repository resolved yet — nothing to re-read
                }
                void swapCompareRefs(cwd);
            },
        },
        {
            // Shift+N/Shift+P, not vim's ]c/[c: "[" and "]" already cycle surfaces globally, and
            // claiming either as a leader here would cost that on this surface. Monaco is asked where
            // the next hunk is rather than told — it computed the diff that is on screen.
            id: "files:next-change",
            keys: "Shift:n",
            group: "Diff",
            label: "Next change",
            when: on,
            // no editor mounted (nothing selected, a binary file, still loading) — decline the key
            run: () => gotoChange("next"),
        },
        {
            id: "files:prev-change",
            keys: "Shift:p",
            group: "Diff",
            label: "Previous change",
            when: on,
            run: () => gotoChange("previous"),
        },
        {
            id: "files:toggle-reviewed",
            keys: "v",
            group: "Diff",
            label: "Mark file reviewed",
            when: on,
            // no open file in a listed subject — let the key pass
            run: () => (toggleOpenFile() ? undefined : false),
        },
        {
            // with focus in the diff editor, `m` is the editor's own action (diffcommentlayer.ts)
            id: "files:comment",
            keys: "m",
            group: "Diff",
            label: "Comment on lines",
            when: on,
            // no editor mounted or no source to comment for — let the key pass
            run: () => commentOnSelection(),
        },
        {
            id: "files:send-comments",
            keys: "Shift:Enter",
            group: "Diff",
            label: "Send comments",
            when: on,
            // no send bar, no comments, or a recipient that has to wait — let the key pass
            run: () => sendPendingComments(),
        },
        {
            id: "files:toggle-history",
            keys: "Shift:h",
            group: "Diff",
            label: "Collapse / expand history",
            when: on,
            run: () => {
                const cur = globalStore.get(historyCollapsedAtom);
                // from "follow the width", an explicit toggle means "collapse it" — that is the
                // state the user can see and is reacting to
                globalStore.set(historyCollapsedAtom, cur == null ? true : !cur);
            },
        },
        {
            // Escape's order on this surface: clear filters, else leave compare, else go home. The
            // three guards are mutually exclusive by construction (this one requires filters active
            // and compare off), which is what keeps assertNoConflicts passing.
            id: "files:clear-filters",
            keys: "Escape",
            group: "Diff",
            label: "Clear filters",
            when: (ctx) => filtering(ctx) && noEscapeMenuOpen(),
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
            when: inHistory,
            run: () => {
                const el = document.querySelector<HTMLElement>('[data-range-chip="compare"]');
                if (el == null) {
                    return false; // no repository scoped -> nothing to compare; let the key pass
                }
                el.click();
            },
        },
        {
            // same key, second meaning: inside compare, c reopens the ref pair rather than re-entering
            id: "files:change-refs",
            keys: "c",
            group: "Diff",
            label: "Change compare refs",
            when: inCompare,
            run: () => {
                const el = document.querySelector<HTMLElement>("[data-ref-pair]");
                if (el == null) {
                    return false;
                }
                el.click();
            },
        },
        {
            id: "files:refresh",
            keys: "r",
            group: "Diff",
            // Both columns, which is why this is no longer "Refresh changes": the change list polls
            // itself, so the reason to press r is usually the half that does not — the commit column.
            label: "Refresh",
            when: on,
            run: () => {
                void reloadChanges(globalStore.get(filesStateAtom)?.cwd ?? null);
                refreshHistory();
            },
        },
        {
            id: "files:exit-compare",
            keys: "Escape",
            group: "Diff",
            label: "Back to history",
            when: (ctx) => inCompare(ctx) && noEscapeMenuOpen(),
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

export function buildCodeBindings(model: AgentsViewModel): Binding[] {
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
        // Files have no chord of their own: the global "palette" binding owns Ctrl+P and opens the
        // search on its Files scope whenever this surface is active.
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
            // overwrites the file on disk with the buffer; nothing asks first
            destructive: true,
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
            // like Ctrl+P and save's Ctrl+S, deliberately NOT gated on !editable:
            // the caret is in Monaco when you want this, so a bare letter would be unreachable
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                globalStore.set(codeSearchModeAtom, "search");
                focusCodeSidebarOpener();
                // the pane focuses its input only on mount: nothing remounts it when Search is already
                // showing, and a collapsed sidebar mounts it hidden, where focus() does nothing
                window.requestAnimationFrame(focusCodeSearchInput);
            },
        },
        // F12, Shift+F12 and Ctrl+Shift+O are Monaco's own chords for the same three things; this
        // dispatcher runs on window capture, so these win while the caret is in the editor, which is
        // where they are pressed — hence the surface gate rather than !editable.
        {
            id: "code:definition",
            keys: "F12",
            group: "Code",
            label: "Go to the definition of the word at the caret",
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                const at = caretWord();
                if (at == null) {
                    return false; // no editor, or no word under the caret — let the key pass
                }
                void goToDefinition(model, at.word, at.lang).then((listed) => {
                    if (listed) {
                        focusCodeSidebarOpener(); // a collapsed sidebar would hide the candidates
                    }
                });
            },
        },
        {
            id: "code:references",
            keys: "Shift:F12",
            group: "Code",
            label: "Find references to the word at the caret",
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                const at = caretWord();
                if (at == null) {
                    return false;
                }
                focusCodeSidebarOpener();
                void findReferences(at.word);
            },
        },
        {
            id: "code:symbols",
            keys: "Ctrl:Shift:o",
            group: "Code",
            label: "Go to a symbol in the open file",
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                globalStore.set(model.paletteSeedAtom, "@");
                globalStore.set(model.paletteOpenAtom, true);
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

// The Final check viewer's keys, registered by the viewer itself while it is mounted. Gated on the viewer's own
// atom rather than on !modalOpen: that atom is what makes modalOpen true, which is how these win over the Jarvis
// list's arrows registered before them, and over Escape on the run sheet underneath.
export function buildFinalShotsBindings(handlers: {
    scenario(d: 1 | -1): void;
    shot(d: 1 | -1): void;
    zoom(): void;
    steps(): void;
    close(): void;
}): Binding[] {
    const open = () => globalStore.get(finalShotsViewerOpenAtom);
    const bind = (id: string, keys: string, label: string, run: () => void): Binding => ({
        id: `final-shots:${id}`,
        keys,
        group: "Final check viewer",
        label,
        when: open,
        paletteHidden: true,
        run,
    });
    return [
        bind("prev-scenario", "ArrowUp", "Previous scenario", () => handlers.scenario(-1)),
        bind("next-scenario", "ArrowDown", "Next scenario", () => handlers.scenario(1)),
        bind("prev-shot", "ArrowLeft", "Previous screenshot", () => handlers.shot(-1)),
        bind("next-shot", "ArrowRight", "Next screenshot", () => handlers.shot(1)),
        bind("zoom", "z", "Fit / actual size", handlers.zoom),
        bind("steps", "s", "Show or hide the steps", handlers.steps),
        bind("close", "Escape", "Close the viewer", handlers.close),
    ];
}

// The Resource Manager popover's keys, registered by the always-mounted popover. Gated on its own atom rather
// than on !modalOpen: that atom is what makes modalOpen true, which stands the surface's arrows, Enter and Escape
// down under it. A palette or modal opened over the popover keeps its own keys.
export function buildResMonBindings(model: AgentsViewModel): Binding[] {
    const active = (ctx: KeyContext) =>
        globalStore.get(resmonOpenAtom) && !ctx.editable && !anyModalOpen() && !globalStore.get(model.paletteOpenAtom);
    const views = () => buildViews(globalStore.get(resmonSnapshotAtom)?.groups ?? []);
    const bind = (id: string, keys: string, label: string, run: () => void): Binding => ({
        id: `resmon:${id}`,
        keys,
        group: "Resource Manager",
        label,
        when: active,
        paletteHidden: true,
        run,
    });
    return [
        bind("prev", "ArrowUp", "Move up", () => dispatchResMon({ type: "move", delta: -1, views: views() })),
        bind("next", "ArrowDown", "Move down", () => dispatchResMon({ type: "move", delta: 1, views: views() })),
        bind("enter", "Enter", "Confirm, else expand or collapse the group", () => {
            if (globalStore.get(resmonUiAtom).confirm != null) {
                void confirmResMon();
            } else {
                dispatchResMon({ type: "toggle", views: views() });
            }
        }),
        bind("kill", "x", "Kill the process and its children", () =>
            dispatchResMon({ type: "askKill", views: views() })
        ),
        bind("kill-children", "Shift:X", "Kill the group's children", () =>
            dispatchResMon({ type: "askChildren", views: views() })
        ),
        bind("close", "Escape", "Cancel, else close", () => {
            if (globalStore.get(resmonUiAtom).confirm != null) {
                dispatchResMon({ type: "cancel" });
            } else {
                globalStore.set(resmonOpenAtom, false);
            }
        }),
    ];
}
