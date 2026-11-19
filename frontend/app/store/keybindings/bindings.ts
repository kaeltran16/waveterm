// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { launchPiTab } from "@/app/cockpit/cockpit-actions";
import {
    confirmResMon,
    dispatchResMon,
    resmonOpenAtom,
    resmonUiAtom,
    resmonViewsAtom,
} from "@/app/cockpit/resmonstore";
import { cheatsheetOpenAtom } from "@/app/cockpit/shortcuts-cheatsheet";
import { escapeMenusOpenAtom } from "@/app/hook/useEscapeClose";
import { anyModalOpen } from "@/app/modals/modalstack";
import { globalStore } from "@/app/store/jotaiStore";
import { confirmCloseSession, driveAgent } from "@/app/view/agents/agentactions";
import { paneShown, showPane, type PaneKind } from "@/app/view/agents/agentpanes";
import { AgentsViewModel, SURFACE_ORDER, type SurfaceKey } from "@/app/view/agents/agents";
import { answerDigitTarget, canSubmitAsk, moveCursor, type AgentVM } from "@/app/view/agents/agentsviewmodel";
import { enterAction, pickAdvance } from "@/app/view/agents/askflow";
import {
    checkMain,
    checkReview,
    OPTION_KEYS,
    optionNumber,
    paneBack,
    paneView,
    pickableOptions,
    type PartPick,
    type ReviewRow,
} from "@/app/view/agents/brainstormmodel";
import { pickPart, reportSendFailure } from "@/app/view/agents/brainstormsend";
import {
    focusedBrainstorm,
    moveReviewCursor,
    openBrainstormBoard,
    openBrainstormDesign,
    openBrainstormHistory,
    shownBrainstormFile,
    toggleReviewRow,
} from "@/app/view/agents/brainstormstore";
import { paneState, shownBoard } from "@/app/view/agents/canvasmodel";
import {
    canvasWindowAtom,
    focusedCanvas,
    getCanvas,
    openCanvasWindow,
    selectCanvasBoard,
    setMarking,
    stepCanvasBoard,
} from "@/app/view/agents/canvasstore";
import { activeChannelRunsAtom } from "@/app/view/agents/channelsstore";
import { sendPendingComments } from "@/app/view/agents/commentsend";
import { sideJumpTarget, type CompareRow } from "@/app/view/agents/comparerows";
import {
    compareCwd,
    compareOnAtom,
    compareSelectionAtom,
    leaveCompare,
    refreshCompare,
    swapCompareRefs,
} from "@/app/view/agents/comparestore";
import { commentOnSelection } from "@/app/view/agents/diffcommentlayer";
import { filesSurfaceWidthAtom, historyCollapsedAtom, resolveCollapsed } from "@/app/view/agents/difflayout";
import { gotoChange } from "@/app/view/agents/diffnav";
import { ignoreWsAtom, splitAvailableAtom, splitViewAtom } from "@/app/view/agents/diffoptions";
import { docReviewAtom, parseDocReview } from "@/app/view/agents/docreview";
import { filesStateAtom, reloadChanges } from "@/app/view/agents/filesstore";
import { listOrder, stepInList, treeModeAtom } from "@/app/view/agents/filetree";
import { isFinalStageId } from "@/app/view/agents/finalstage";
import {
    clearHistoryFilters,
    graphOnAtom,
    historyFiltersAtom,
    historyScrollAtom,
    refreshHistory,
} from "@/app/view/agents/githistorystore";
import { canHandToPhone } from "@/app/view/agents/handtophone";
import { anyFilterActive } from "@/app/view/agents/historyquery";
import { canApply, isPending, stepChange, undoExpired } from "@/app/view/agents/memorymodel";
import {
    decideMemory,
    memoryBusyAtom,
    memoryDetailOpenAtom,
    memorySelection,
    memorySheetOpen,
    selectMemoryChange,
    type MemVerdict,
} from "@/app/view/agents/memorystore";
import { railVisibleAtom, terminalFullscreenAtom } from "@/app/view/agents/railstore";
import { toggleHandToPhone } from "@/app/view/agents/remotestore";
import { canRender, toggleViewMode } from "@/app/view/agents/renderedmode";
import { activeReviewAtom, toggleOpenFile } from "@/app/view/agents/reviewmarks";
import { renamingRowAtom } from "@/app/view/agents/rowrenameatom";
import { isEndedWorkerId } from "@/app/view/agents/runlineage";
import { resolveActiveRunId } from "@/app/view/agents/runmodel";
import { shellTaskPeekAtom } from "@/app/view/agents/shelltasksstore";
import { focusSubagentAtom } from "@/app/view/agents/subagentsstore";
import { LIST_COLLAPSED_ROWS } from "@/app/view/agents/usageattribution";
import { usageBackStep } from "@/app/view/agents/usagenav";
import { usageLensAtom, usageListShownAtom, usageWorkItemAtom, usageWorkScopeAtom } from "@/app/view/agents/usagestore";
import { stepListBoard } from "@/app/view/agents/workspacecanvastabmodel";
import { stepChangesHunk } from "@/app/view/agents/workspacechangesstore";
import { tabKey } from "@/app/view/agents/workspacemodel";
import { graphEscapeKey, toLanes } from "@/app/view/agents/workspacerungraphmodel";
import {
    rendersNow,
    toggleWorkspaceCollapsed,
    updateWorkspaceTab,
    workspaceAtom,
} from "@/app/view/agents/workspacestore";
import { boardOwnsEscapeAtom, runBoardEscape } from "@/app/view/boards/boardstore";
import { toggleBlame } from "@/app/view/code/codeblamestore";
import { closePeek, codePeekFocusedAtom, openPeekInCode } from "@/app/view/code/codepeekstore";
import { projectComments } from "@/app/view/code/codereview";
import { codeReviewsAtom, codeReviewSendOpenAtom, startComment } from "@/app/view/code/codereviewstore";
import { codeSearchModeAtom } from "@/app/view/code/codesearchstore";
import {
    caretWord,
    codeCursorAtom,
    codePlainAtom,
    codeProjectAtom,
    codeRowsAtom,
    codeTreeFocusedAtom,
    confirmDelete,
    cycleDiff,
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
    toggleGraphPeek,
    trackerMenuAtom,
} from "@/app/view/jarvis/jarvisstore";
import { activeRunIdAtom, activeSubjectAtom, setActiveRunId } from "@/app/view/jarvis/jarvissubjectstore";
import { checkJiraOpenAtom } from "@/app/view/jarvis/jiracheck";
import { peekTarget } from "@/app/view/jarvis/openref";
import { petPeekOpenAtom } from "@/app/view/jarvis/petstore";
import { backToOrigin } from "@/app/view/jarvis/returnsurface";
import { dagModalStateAtom } from "@/app/view/orchestrate/dagmodalstate";
import { fireAndForget } from "@/util/util";
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
    { letter: "c", surface: "jarvis", label: "Hub (initiatives, runs, records)" },
    { letter: "s", surface: "sessions", label: "Sessions" },
    { letter: "f", surface: "files", label: "Diff" },
    { letter: "u", surface: "usage", label: "Usage" },
    { letter: "b", surface: "code", label: "Code (browse source)" },
    { letter: ".", surface: "setup", label: "Setup (instructions, skills, memory)" },
    { letter: ",", surface: "settings", label: "Settings" },
    { letter: "w", surface: "boards", label: "Boards" },
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
const ESC_HOME_SURFACES = new Set<SurfaceKey>(["jarvis", "sessions", "files", "usage", "code", "boards"]);

// Escape on a deep surface navigates (back, else home) only when nothing on screen owns it.
// the Jarvis graph peek owns Escape while it is open: closing an overlay is what the user means
// by Escape there, and navigating home instead would leave the peek open behind the Cockpit.
// The autonomy panel owns it for the same reason — and it cannot claim the key itself, since
// this dispatcher runs on window capture, ahead of any handler the panel could register.
const escapeNavigates = (ctx: KeyContext): boolean =>
    navigateStrict(ctx) &&
    ESC_HOME_SURFACES.has(ctx.surface) &&
    // any open ModalShell (the Brief's Profile window, its sheet) closes on Escape itself; going
    // home instead unmounts it with its state still set, so it reopens on the way back
    !anyModalOpen() &&
    // only the Brief draws the graph peek, and a surface chord leaves its atom set: elsewhere it owns nothing
    !(ctx.surface === "jarvis" && globalStore.get(graphPeekOpenAtom)) &&
    !globalStore.get(autonomyPanelOpenAtom) &&
    // and the pet's peek, for the same reason again — it is global chrome, so it can be open
    // on ANY of these surfaces, not just Jarvis
    !globalStore.get(petPeekOpenAtom) &&
    // the Diff surface's compare state owns Escape while it is on: leaving compare is what
    // Escape means there, and going home instead would strand a two-ref read behind the Cockpit
    !globalStore.get(compareOnAtom) &&
    // and with filters active, Escape clears them — the history header says so ("Clear filters", esc)
    !(ctx.surface === "files" && anyFilterActive(globalStore.get(historyFiltersAtom))) &&
    // the open board owns Escape while Excalidraw has a selection or a tool to drop, as compare does on Diff
    !(ctx.surface === "boards" && globalStore.get(boardOwnsEscapeAtom)) &&
    // the Brief's record peek is a ModalShell and the Brief is where every record destination
    // now lands: without this, one press closed the peek AND left the surface — and the peek's
    // own state was never cleared, so coming back showed it open again. Only the Brief draws it, and a surface
    // chord leaves it set, so it counts on Jarvis only
    !(ctx.surface === "jarvis" && globalStore.get(briefPeekRecordAtom) != null) &&
    // the DAG modal takes Escape itself too, and the Brief mounts it as well as Channels
    globalStore.get(dagModalStateAtom) == null &&
    // and the Brief's Chunk sidebar: while a note is open, Escape means "back out of the
    // note", and going home too would do both at once. Both atoms outlive the Brief, so they
    // only count on Jarvis: elsewhere nothing draws them and Escape would do nothing at all
    !(ctx.surface === "jarvis" && globalStore.get(noteChunkAtom) != null) &&
    // and the plan-editing menu above it, the innermost rung of all
    !(ctx.surface === "jarvis" && globalStore.get(trackerMenuAtom) != null) &&
    // and any hand-rolled dropdown (useEscapeClose): it closes on Escape and returns focus itself
    noEscapeMenuOpen();

// Usage's By work Back step while Usage shows, else null. The three atoms are all read whatever they
// hold, so the PREDICATE_ATOMS completeness sweep sees each of them.
const usageBack = (ctx: KeyContext) => {
    const step = usageBackStep(
        globalStore.get(usageLensAtom),
        globalStore.get(usageWorkScopeAtom),
        globalStore.get(usageWorkItemAtom)
    );
    return ctx.surface === "usage" ? step : null;
};

// A key that clicks a control the surface already draws, rather than duplicating what the control knows.
// No control on screen lets the key pass.
const clickThrough = (selector: string): boolean | void => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el == null) {
        return false;
    }
    el.click();
};

// what the focused agent shows of its brainstorm or canvas: its tab in Rendered, the center in Terminal
function focusedShown(model: AgentsViewModel): PaneKind | null {
    const id = globalStore.get(model.focusIdAtom);
    return id ? paneShown(model, id) : null;
}

// the Canvas tab's [ and ]: only the selection moves among the boards; the canvas's All or single-board view stays
function selectListBoard(agentId: string, delta: number): void {
    const s = getCanvas(agentId);
    const next = s != null ? stepListBoard(s, delta) : null;
    if (next != null) {
        selectCanvasBoard(agentId, next);
    }
}

// the canvas of the board the focused agent's brainstorm pane shows full size; null while it shows anything else
function brainstormBoard(model: AgentsViewModel): ReturnType<typeof focusedCanvas> {
    const s = focusedBrainstorm(model);
    if (s == null || focusedShown(model) !== "brainstorm") {
        return null;
    }
    return paneView(s) === "board" ? focusedCanvas(model) : null;
}

// `[` `]` belong to the boards while the canvas shows and on a brainstorm's full-size board, so the surface switch
// stands down while the focused agent shows either. The agent switches stay live: the tree stays on screen beside it.
const inAgentCanvas = (model: AgentsViewModel, ctx: KeyContext) =>
    ctx.surface === "agent" && (focusedShown(model) === "canvas" || brainstormBoard(model) != null);

// the second Ctrl+C closes the focused session among `agents`; the caller passes agents only, so a plain terminal
// (closed from its row menu or the header's x) gets both presses. null lets the press fall through to the PTY.
export function closeTargetForDoubleCtrlC(agents: AgentVM[], focusId: string | undefined): AgentVM | null {
    if (!focusId) {
        return null;
    }
    return agents.find((x) => x.id === focusId) ?? null;
}

// a brainstorm or canvas pane, or the Rendered view, hides the terminal, so the press counts anywhere on the surface
// there: a click on the Rendered transcript's text leaves focus on the surface, not in the view. With the terminal
// showing it counts only inside it, so ^C elsewhere stays a plain key.
export function ctrlCReachesSession(
    inTerm: boolean,
    inSurface: boolean,
    paneShown: boolean,
    renderedShown = false
): boolean {
    return inTerm || ((paneShown || renderedShown) && inSurface);
}

// selected text makes ^C a copy: in the message box (a textarea's selection is not the document's) or the page
function hasTextSelection(el: HTMLElement | null): boolean {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        return el.selectionStart !== el.selectionEnd;
    }
    return !(window.getSelection()?.isCollapsed ?? true);
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
            run: () => model.cycleFocus(1),
        },
        {
            id: "cycle-agent-prev",
            keys: "Ctrl:Shift:Tab",
            group: "Agent",
            label: "Previous agent",
            when: (ctx) => ctx.surface === "agent",
            run: () => model.cycleFocus(-1),
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
                const surface = active?.closest?.("[data-cockpit-surface-wrap]");
                const inSurface = surface != null;
                const renderedShown = surface?.querySelector("[data-rendered-view]") != null;
                if (!ctrlCReachesSession(inTerm, inSurface, focusedShown(model) != null, renderedShown)) {
                    return false;
                }
                if (renderedShown && hasTextSelection(active)) {
                    return false;
                }
                const now = performance.now();
                if (lastCtrlC != null && now - lastCtrlC < DOUBLE_CTRL_C_MS) {
                    lastCtrlC = null;
                    // agents only: on a plain terminal both presses belong to the shell
                    const fid = globalStore.get(model.focusIdAtom);
                    const a = closeTargetForDoubleCtrlC(globalStore.get(model.agentsAtom), fid);
                    if (a) {
                        confirmCloseSession(a, model);
                        return true;
                    }
                    return false;
                }
                lastCtrlC = now;
                if (renderedShown) {
                    // the Rendered view's message box is not the PTY, so the first press goes to Claude as the
                    // terminal's would: it stops a running turn
                    const fid = globalStore.get(model.focusIdAtom);
                    driveAgent(globalStore.get(model.agentsAtom).find((a) => a.id === fid)?.blockId, "\x03");
                }
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
            // stands down while Usage's By work is drilled: usage:back takes the press there
            when: (ctx) => escapeNavigates(ctx) && usageBack(ctx) == null,
            run: () => backOrHome(model),
        },
        {
            id: "boards:clear",
            keys: "Escape",
            group: "Boards",
            label: "Clear the board's selection or tool",
            when: (ctx) =>
                navigateStrict(ctx) &&
                ctx.surface === "boards" &&
                globalStore.get(boardOwnsEscapeAtom) &&
                !anyModalOpen() &&
                noEscapeMenuOpen(),
            run: () => runBoardEscape(),
        },
        {
            id: "usage:back",
            keys: "Escape",
            group: "Navigation",
            label: "Back to the scope, else All usage",
            when: (ctx) => escapeNavigates(ctx) && usageBack(ctx) != null,
            run: (ctx) => {
                const step = usageBack(ctx);
                if (step == null) {
                    return false;
                }
                globalStore.set(usageWorkScopeAtom, step.scope);
                globalStore.set(usageWorkItemAtom, step.item);
                globalStore.set(usageListShownAtom, LIST_COLLAPSED_ROWS);
            },
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
        // clamped at the ends to the row already selected: re-selecting it would re-read its files and reopen
        // the first one (the Diff), once per key repeat
        if (next != null && next !== c.cursorId) {
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
        group: "Hub",
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
            group: "Hub",
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
            group: "Hub",
            label: "Graph peek (Esc closes)",
            when: onJarvis,
            run: toggleGraphPeek,
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
        group: "Hub",
        label: "Back out of the Chunk sidebar",
        when: (ctx) =>
            onJarvis(ctx) &&
            globalStore.get(noteChunkAtom) != null &&
            globalStore.get(trackerMenuAtom) == null &&
            // a sheet, record peek or graph peek above the sidebar closes first, on its own listener
            !anyModalOpen() &&
            !globalStore.get(graphPeekOpenAtom) &&
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
        group: "Hub",
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
            group: "Hub",
            label: "New run",
            when: onStage,
            run: () => clickThrough("[data-new-run]"),
        },
        {
            id: "jarvis:new-initiative",
            keys: "Shift:n",
            group: "Hub",
            label: "New initiative",
            when: onStage,
            run: () => clickThrough("[data-jarvis-new-initiative]"),
        },
        {
            id: "jarvis:check-jira",
            keys: "Shift:c",
            group: "Hub",
            label: "Check Jira for my tickets",
            when: onStage,
            run: () => globalStore.set(checkJiraOpenAtom, true),
        },
        {
            id: "jarvis:work-on",
            keys: "w",
            group: "Hub",
            label: "Work on the initiative under the cursor, or go to its open agent",
            when: onStage,
            run: () => clickThrough('[data-jarvis-brief-cursor="true"] [data-jarvis-work-on]'),
        },
        {
            id: "jarvis:record-band",
            keys: "e",
            group: "Hub",
            label: "Expand / collapse the record band",
            when: onStage,
            run: () => clickThrough("[data-jarvis-band-toggle]"),
        },
        {
            id: "jarvis:next-run",
            keys: "Shift:j",
            group: "Hub",
            label: "Next run in this project",
            when: onStage,
            run: () => stepRun(1),
        },
        {
            id: "jarvis:prev-run",
            keys: "Shift:k",
            group: "Hub",
            label: "Previous run in this project",
            when: onStage,
            run: () => stepRun(-1),
        },
        {
            id: "jarvis:chunk-up",
            keys: "Alt:ArrowUp",
            group: "Hub",
            label: "Move the chunk up within its stage",
            when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,
            run: () => globalStore.get(chunkMoveAtom)?.("up"),
        },
        {
            id: "jarvis:chunk-down",
            keys: "Alt:ArrowDown",
            group: "Hub",
            label: "Move the chunk down within its stage",
            when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,
            run: () => globalStore.get(chunkMoveAtom)?.("down"),
        },
        {
            id: "jarvis:focus-composer",
            keys: "i",
            group: "Hub",
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
            group: "Hub",
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
            group: "Hub",
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
    // a focus the tree no longer shows (its run folded) starts from the first row
    const step = (delta: number) => {
        const order = globalStore.get(model.focusOrderAtom);
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
    const shown = () => focusedShown(model);
    const inBrainstorm = (ctx: KeyContext) => agentNav(ctx) && shown() === "brainstorm";
    // the check's review fills the main area: j and k move its cursor instead of the agents, and y, u and Enter act
    // on the cursor row
    const inReview = (ctx: KeyContext) => {
        if (!inBrainstorm(ctx)) {
            return false;
        }
        const s = brainstorm()!;
        const f = shownBrainstormFile(s);
        return f != null && paneView(s) === "check" && checkMain(f, s.designOpen) === "review";
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
    // the key picks for the row as its button does; with no row or no pick for it, or while the agent writes (the
    // row's buttons are locked then too), the key passes on
    const pickReview = (pickFor: (row: ReviewRow) => PartPick | null) => {
        if (shownBrainstormFile(brainstorm())?.working != null) {
            return false;
        }
        const row = reviewRow();
        const pick = row == null ? null : pickFor(row);
        const agent = globalStore.get(model.agentsAtom).find((x) => x.id === focusId());
        if (row == null || pick == null || agent == null) {
            return false;
        }
        pickPart(agent, row.id, pick).catch((e) => reportSendFailure(agent.id, e));
    };
    // the asked question's options the pane draws, each picked by its digit
    const pickable = () => {
        const s = brainstorm();
        return s == null ? 0 : pickableOptions(shownBrainstormFile(s), s);
    };
    // an agent with a brainstorm never shows its canvas, so the canvas keys stand down for it
    const canvas = () => (brainstorm() == null ? focusedCanvas(model) : null);
    // in Terminal a shown brainstorm or canvas hides the rail and the terminal, so their keys stand down there; in
    // Rendered it is a tab beside the transcript, whose keys stay
    const centerFree = () => shown() == null || rendered();
    const nav = (ctx: KeyContext) => agentNav(ctx) && centerFree();
    const inCanvas = (ctx: KeyContext) => agentNav(ctx) && shown() === "canvas";
    // the Terminal view's canvas center marks in place; the Rendered view's Canvas tab is a list that marks in the
    // canvas window, so the two get their own [ ] and m
    const inCanvasCenter = (ctx: KeyContext) => inCanvas(ctx) && !rendered();
    const boardReady = (ctx: KeyContext) =>
        inCanvasCenter(ctx) && !canvas()!.marking && paneState(canvas()!) === "board";
    // agentNav stands down under the open window, whose own keys take over there
    const listReady = (ctx: KeyContext) => inCanvas(ctx) && rendered() && paneState(canvas()!) === "board";
    // a brainstorm's board opened full size steps with [ and ] as the canvas does
    const stepReady = (ctx: KeyContext) => {
        const c = agentNav(ctx) ? brainstormBoard(model) : null;
        return boardReady(ctx) || (c != null && !c.marking && paneState(c) === "board");
    };
    const focusId = () => globalStore.get(model.focusIdAtom);
    // the focused agent when the center can show it Rendered; a subagent interior wins over Rendered
    const renderableId = (): string | null => {
        const id = focusId();
        const agent = globalStore.get(model.agentsAtom).find((a) => a.id === id);
        const ok =
            agent != null &&
            globalStore.get(focusSubagentAtom) == null &&
            canRender(agent, { ended: isEndedWorkerId(id), stage: isFinalStageId(id) });
        return ok ? id : null;
    };
    // the focused agent's center shows Rendered, where the workspace pane stands in for the details rail
    const rendered = () => {
        const id = focusId();
        return id != null && rendersNow(model, id);
    };
    const workspaceTabs = () => {
        const id = focusId();
        return id == null ? 0 : globalStore.get(workspaceAtom(id)).tabs.length;
    };
    // the Run tab's key while the pane beside the transcript shows its Graph in Focus, where Esc returns to Lanes
    const graphFocusKey = (): string | null => {
        const id = focusId();
        return id != null && rendered() ? graphEscapeKey(globalStore.get(workspaceAtom(id))) : null;
    };
    // the focused agent's open pane (not the strip) shows the Changes tab
    const changesShown = (): string | null => {
        const id = focusId();
        if (id == null || !rendered()) {
            return null;
        }
        const ws = globalStore.get(workspaceAtom(id));
        return ws.active === "changes" && !ws.collapsed ? id : null;
    };
    // strict: a bare Shift+letter typed in a field is text, and the Terminal view's xterm is editable
    const onChanges = (ctx: KeyContext) => agentNavStrict(ctx) && changesShown() != null;
    const stepChanges = (dir: "next" | "previous") => (): boolean | void => {
        const id = changesShown();
        if (id == null || !stepChangesHunk(id, dir)) {
            return false;
        }
    };
    const codePeekFocused = () => globalStore.get(codePeekFocusedAtom);
    // the Rendered view's ask dock draws only for an asking agent, and only the focused agent's view is mounted, so a
    // dock in the DOM is the renderable focused agent's
    const renderedAsker = (): AgentVM | null => {
        if (document.querySelector("[data-rendered-ask]") == null) {
            return null;
        }
        const id = renderableId();
        const agent = globalStore.get(model.agentsAtom).find((a) => a.id === id);
        return agent?.state === "asking" ? agent : null;
    };
    const askAnswers = (id: string) => ({
        sel: globalStore.get(model.answerSelAtom)[id] ?? {},
        txt: globalStore.get(model.answerTextAtom)[id] ?? {},
    });
    const selectAskQuestion = (id: string, qi: number) =>
        globalStore.set(model.answerTabAtom, (prev) => ({ ...prev, [id]: qi }));
    // a digit picks as the cockpit's does: toggle, move on from a single-select question, never send
    const pickAskDigit = (n: number): boolean | void => {
        const asker = renderedAsker();
        const target =
            asker != null ? answerDigitTarget(asker, globalStore.get(model.answerTabAtom)[asker.id] ?? 0, n) : null;
        if (target == null) {
            return false;
        }
        model.toggleAnswer(asker.id, target.qi, target.oi);
        const { sel, txt } = askAnswers(asker.id);
        const next = pickAdvance(asker.ask?.questions ?? [], sel, txt, target.qi);
        if (next != null) {
            selectAskQuestion(asker.id, next);
        }
    };
    // the step the brainstorm pane's back control takes, which Esc takes too. A drawn mark's note owns Esc on the
    // board (it drops the mark there), so the board's step waits for it even while the note's field is unfocused
    const paneStep = () => {
        const s = brainstorm();
        if (s == null || shown() !== "brainstorm") {
            return null;
        }
        const step = paneBack(s, shownBrainstormFile(s));
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
                !codePeekFocused() &&
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
                !codePeekFocused() &&
                globalStore.get(renamingRowAtom) == null &&
                noEscapeMenuOpen() &&
                globalStore.get(shellTaskPeekAtom) != null,
            run: () => globalStore.set(shellTaskPeekAtom, null),
        },
        {
            // Esc in the terminal interrupts the agent, so the peek takes the key only while focus is inside its
            // card (codePeekFocusedAtom). It is not gated on editable: the card's Monaco textarea is editable. The
            // Escapes around it stand down for it, so it is the one claim on the key then.
            id: "codepeek:close",
            keys: "Escape",
            group: "Agent",
            label: "Close the code peek",
            when: (ctx) => ctx.surface === "agent" && codePeekFocused() && !ctx.modalOpen && noEscapeMenuOpen(),
            run: () => closePeek(),
        },
        {
            id: "codepeek:open",
            keys: "Enter",
            group: "Agent",
            label: "Open the peeked file in Code",
            when: (ctx) => ctx.surface === "agent" && codePeekFocused() && !ctx.modalOpen,
            run: () => {
                openPeekInCode(model).catch((e) => console.warn("code peek: open in Code failed", e));
            },
        },
        {
            id: "agent:back",
            keys: "Escape",
            group: "Agent",
            label: "Back, else to Cockpit (or exit fullscreen)",
            when: (ctx) =>
                agentNavStrict(ctx) &&
                noEscapeMenuOpen() &&
                !codePeekFocused() &&
                globalStore.get(focusSubagentAtom) == null &&
                globalStore.get(shellTaskPeekAtom) == null &&
                shown() == null &&
                graphFocusKey() == null,
            run: () => {
                if (globalStore.get(terminalFullscreenAtom)) {
                    globalStore.set(terminalFullscreenAtom, false);
                } else {
                    backOrHome(model);
                }
            },
        },
        {
            // the Run tab's Graph in Focus: Esc returns to Lanes and stops there, and the next Esc is agent:back's.
            // Guarded as agent:back is, so a focused field keeps its own Esc; agent:back stands down meanwhile
            id: "agent:graph-lanes",
            keys: "Escape",
            group: "Agent",
            label: "Run tab Graph: from Focus back to Lanes",
            when: (ctx) =>
                agentNavStrict(ctx) &&
                noEscapeMenuOpen() &&
                !codePeekFocused() &&
                globalStore.get(focusSubagentAtom) == null &&
                globalStore.get(shellTaskPeekAtom) == null &&
                shown() == null &&
                graphFocusKey() != null,
            run: () => {
                const key = graphFocusKey();
                const id = focusId();
                const tab = globalStore.get(workspaceAtom(id)).tabs.find((t) => tabKey(t) === key);
                if (key == null || tab?.kind !== "run") {
                    return false;
                }
                updateWorkspaceTab(id, key, { graph: toLanes(tab.graph) });
            },
        },
        {
            // agent:back stands down in brainstorm mode, so this is the pane's Escape: its back control, one level
            // per press. Guarded as agent:back is, so a focused field keeps its own Esc (the answer box, a row's
            // edit or rename, the builder-check answer, the mark note), as do an open modal and an escape menu
            id: "agent:brainstorm-back",
            keys: "Escape",
            group: "Agent",
            label: "Back in the brainstorm: from a full-size board, or from the history or the design to the question",
            when: (ctx) =>
                agentNavStrict(ctx) &&
                noEscapeMenuOpen() &&
                !codePeekFocused() &&
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
                } else if (step === "history") {
                    openBrainstormHistory(focusId(), false);
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
        // in the check's review j and k move its decisions and ↑ ↓ stand down; ← → and Ctrl+Tab still move agents
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
            id: "agent:prev-up",
            keys: "ArrowUp",
            group: "Agent",
            label: "Previous agent",
            when: (ctx) => agentNav(ctx) && !inReview(ctx),
            run: () => step(-1),
        },
        {
            id: "agent:next-down",
            keys: "ArrowDown",
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
            label: "Open or close the decision",
            when: (ctx) => !codePeekFocused() && inReview(ctx),
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
                pickReview((row) =>
                    row.action === "keep-restore" ? "keep" : row.action === "confirm" ? "confirm" : null
                ),
        },
        {
            id: "agent:brainstorm-review-restore",
            keys: "u",
            group: "Agent",
            label: "Put mine back in the review",
            when: inReview,
            run: () => pickReview((row) => (row.action === "keep-restore" ? "restore" : null)),
        },
        {
            id: "agent:toggle-rail",
            keys: "d",
            group: "Agent",
            label: "Toggle agent rail",
            // a terminal has no rail, and the Rendered view has the workspace pane in its place
            when: (ctx) =>
                nav(ctx) && !globalStore.get(model.terminalsAtom).some((t) => t.id === focusId()) && !rendered(),
            run: () => globalStore.set(railVisibleAtom, !globalStore.get(railVisibleAtom)),
        },
        {
            // with no tab open there is no pane, so the key passes on
            id: "agent:toggle-workspace",
            keys: "d",
            group: "Agent",
            label: "Collapse or restore the workspace pane",
            when: (ctx) => nav(ctx) && workspaceTabs() > 0 && rendered(),
            run: () => {
                toggleWorkspaceCollapsed(focusId()!);
            },
        },
        {
            // Shift+N/P/W match the Diff surface's keys for the same actions; the Changes tab walks every file's hunks
            id: "agent:changes-next",
            keys: "Shift:n",
            group: "Agent",
            label: "Next change",
            when: onChanges,
            // no hunk to walk — decline the key
            run: stepChanges("next"),
        },
        {
            id: "agent:changes-prev",
            keys: "Shift:p",
            group: "Agent",
            label: "Previous change",
            when: onChanges,
            run: stepChanges("previous"),
        },
        {
            id: "agent:changes-whitespace",
            keys: "Shift:w",
            group: "Agent",
            label: "Ignore whitespace",
            when: onChanges,
            run: () => globalStore.set(ignoreWsAtom, !globalStore.get(ignoreWsAtom)),
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
            id: "agent:toggle-view",
            keys: "v",
            group: "Agent",
            label: "Toggle Terminal / Rendered",
            // the focused agent lives in model atoms, which a when() cannot read, so run() lets the key pass for an
            // agent the header shows no toggle for (another runtime, a plain terminal, an ended worker)
            when: (ctx) => nav(ctx) && globalStore.get(focusSubagentAtom) == null,
            run: () => {
                const id = renderableId();
                if (id == null) {
                    return false;
                }
                toggleViewMode(id);
            },
        },
        // the band owns the in-flight lock and the error, so a digit presses its button; only the focused agent's
        // rendered view is mounted, so the band in the DOM is that agent's. With no band, the digit answers the ask
        // dock, since the dispatcher never falls through to a second binding on the same key
        ...Array.from(
            { length: 9 },
            (_, i): Binding => ({
                id: `agent:permission-choice-${i + 1}`,
                keys: String(i + 1),
                group: "Agent",
                label: `Answer the permission prompt with choice ${i + 1}`,
                paletteHidden: true,
                // a shown Brainstorm tab's answer row claims its digit
                when: (ctx) => nav(ctx) && !ctx.editable && !(inBrainstorm(ctx) && pickable() > i),
                run: () => {
                    const button = document.querySelector<HTMLButtonElement>(
                        `[data-permission-band] [data-permission-choice="${i}"]`
                    );
                    if (button == null) {
                        return pickAskDigit(i + 1);
                    }
                    if (button.disabled) {
                        return false;
                    }
                    button.click();
                },
            })
        ),
        {
            id: "agent:ask-submit",
            keys: "Enter",
            group: "Agent",
            label: "Send the answer to the agent's question",
            paletteHidden: true,
            when: (ctx) => nav(ctx) && !ctx.editable && !codePeekFocused(),
            // Enter on a button outside the dock is that button's own press
            run: () => {
                const asker = renderedAsker();
                const active = document.activeElement;
                if (asker == null || (active?.tagName === "BUTTON" && active.closest("[data-rendered-ask]") == null)) {
                    return false;
                }
                const { sel, txt } = askAnswers(asker.id);
                const tab = globalStore.get(model.answerTabAtom)[asker.id] ?? 0;
                const action = enterAction(asker.ask?.questions ?? [], sel, txt, tab);
                if (action.kind === "submit") {
                    model.submitAnswer(asker.id);
                } else {
                    selectAskQuestion(asker.id, action.qi);
                }
            },
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
            id: "agent:hand-to-phone",
            keys: "p",
            group: "Agent",
            label: "Hand to phone, or take back",
            // like agent:review, the focused agent lives in model atoms, so run() lets the key pass when the
            // header shows no button for it
            paletteHidden: true,
            when: agentNav,
            run: () => {
                const agent = globalStore.get(model.agentsAtom).find((a) => a.id === focusId());
                const role = agent == null ? null : globalStore.get(model.lineageAtom).roles[agent.id];
                if (agent == null || !canHandToPhone(agent, role)) {
                    return false;
                }
                toggleHandToPhone(agent.id);
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
            when: (ctx) => ctx.surface === "agent" && !ctx.modalOpen && centerFree(),
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
            when: (ctx) => agentNav(ctx) && canvas() != null && shown() == null,
            run: () => showPane(model, focusId()!, "canvas", true, Date.now()),
        },
        {
            id: "agent:canvas-close",
            keys: "c",
            group: "Agent",
            label: "Close the canvas",
            when: inCanvas,
            run: () => showPane(model, focusId()!, "canvas", false, Date.now()),
        },
        {
            id: "agent:brainstorm-open",
            keys: "b",
            group: "Agent",
            label: "Show the agent's brainstorm",
            when: (ctx) => agentNav(ctx) && brainstorm() != null && shown() == null,
            run: () => showPane(model, focusId()!, "brainstorm", true, Date.now()),
        },
        {
            id: "agent:brainstorm-close",
            keys: "b",
            group: "Agent",
            label: "Close the brainstorm",
            when: inBrainstorm,
            run: () => showPane(model, focusId()!, "brainstorm", false, Date.now()),
        },
        {
            // b and c only fire off the terminal, and Ctrl+G b / c are Code / Jarvis, so this is the one door
            // that works while typing. A terminal sends it as plain ^B, so no TUI can bind it apart from Ctrl+B.
            // Not gated on editable, like F11. An agent has a brainstorm or a canvas, never both; with neither it
            // flips Terminal / Rendered, so the composer has the same door back
            id: "agent:view-chord",
            keys: "Ctrl:Shift:b",
            group: "Agent",
            label: "Switch the terminal with the agent's brainstorm, canvas or Rendered view (works inside the terminal)",
            when: (ctx) =>
                ctx.surface === "agent" &&
                !ctx.modalOpen &&
                (brainstorm() != null || canvas() != null || renderableId() != null),
            run: () => {
                const kind = brainstorm() != null ? "brainstorm" : canvas() != null ? "canvas" : null;
                if (kind != null) {
                    showPane(model, focusId()!, kind, shown() == null, Date.now());
                    return;
                }
                const id = renderableId();
                if (id == null) {
                    return false;
                }
                toggleViewMode(id);
            },
        },
        // a digit focuses its answer row, so Enter, the row's own key, sends it
        ...OPTION_KEYS.map(
            (key, i): Binding => ({
                id: `agent:brainstorm-option-${key}`,
                keys: key,
                group: "Agent",
                label: `Pick answer ${optionNumber(i)} of the brainstorm's question`,
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
            when: stepReady,
            run: () => stepCanvasBoard(focusId(), -1),
        },
        {
            id: "agent:canvas-next",
            keys: "]",
            group: "Agent",
            label: "Next board",
            when: stepReady,
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
            when: (ctx) => inCanvasCenter(ctx) && canvas()!.marking,
            run: () => setMarking(focusId(), false),
        },
        {
            id: "agent:canvas-list-prev",
            keys: "[",
            group: "Agent",
            label: "Previous board",
            when: listReady,
            run: () => selectListBoard(focusId()!, -1),
        },
        {
            id: "agent:canvas-list-next",
            keys: "]",
            group: "Agent",
            label: "Next board",
            when: listReady,
            run: () => selectListBoard(focusId()!, 1),
        },
        {
            id: "agent:canvas-list-mark",
            keys: "m",
            group: "Agent",
            label: "Mark part of the board in the canvas window",
            when: listReady,
            run: () => openCanvasWindow(focusId()!, { board: shownBoard(canvas()!).name, mark: true }),
        },
    ];
}

// Sessions-surface keys, registered by the surface while it is mounted. j/k and Enter are the shared list-nav.
export function buildSessionsBindings(): Binding[] {
    return [
        {
            id: "sessions:search",
            keys: "/",
            group: "Sessions",
            label: "Search sessions",
            when: (ctx) => ctx.surface === "sessions" && !ctx.editable && !ctx.modalOpen,
            run: () => {
                const el = document.querySelector<HTMLInputElement>("[data-sessions-search]");
                if (el == null) {
                    return false;
                }
                el.focus();
            },
        },
    ];
}

// false declines the key: no list showing, or already at that end (the list does not wrap)
function stepFile(dir: 1 | -1): false | undefined {
    const active = globalStore.get(activeReviewAtom);
    if (active == null) {
        return false;
    }
    const next = stepInList(listOrder(active.files, globalStore.get(treeModeAtom)), active.open, dir);
    if (next == null) {
        return false;
    }
    active.select(next);
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
            run: () => {
                if (!globalStore.get(splitAvailableAtom)) {
                    return false; // too narrow to draw split (or no pane yet): the pane stays unified
                }
                globalStore.set(splitViewAtom, !globalStore.get(splitViewAtom));
            },
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
                // the comparison's own repository: the change list's cwd is null while a ref change reloads it
                const cwd = compareCwd() ?? globalStore.get(filesStateAtom)?.cwd;
                if (!cwd) {
                    return false;
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
            // n / p open without marking: v is the key that marks and moves on
            id: "files:next-file",
            keys: "n",
            group: "Diff",
            label: "Next file",
            when: on,
            run: () => stepFile(1),
        },
        {
            id: "files:prev-file",
            keys: "p",
            group: "Diff",
            label: "Previous file",
            when: on,
            run: () => stepFile(-1),
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
                // flips what is drawn: from "follow the width" at a narrow width the rail is showing, so
                // the toggle opens the history over the panes rather than writing an invisible "collapsed"
                const shown = resolveCollapsed(
                    globalStore.get(historyCollapsedAtom),
                    globalStore.get(filesSurfaceWidthAtom)
                );
                globalStore.set(historyCollapsedAtom, !shown);
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
                const cwd = globalStore.get(filesStateAtom)?.cwd ?? null;
                void reloadChanges(cwd);
                const compare = compareCwd() ?? cwd;
                if (!globalStore.get(compareOnAtom)) {
                    refreshHistory();
                } else if (compare) {
                    void refreshCompare(compare);
                }
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
            // from the editor too: Alt+arrows are not editing keys, and the editor is where you jump from
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                void goBack();
            },
        },
        {
            id: "code:forward",
            keys: "Alt:ArrowRight",
            group: "Code",
            label: "Forward",
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
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
            label: "Cycle the diff: HEAD, branch base, off (git repo)",
            when: on,
            run: () => {
                // a plain directory has no history to diff against, as its disabled Diff button says
                if (globalStore.get(codePlainAtom)) {
                    return false;
                }
                void cycleDiff();
            },
        },
        {
            id: "code:blame",
            keys: "b",
            group: "Code",
            label: "Toggle the blame column (switches to Source)",
            when: on,
            run: () => {
                // a plain directory has no history, as its disabled Blame button says
                if (!globalStore.get(codePlainAtom)) {
                    toggleBlame();
                }
            },
        },
        {
            id: "code:comment",
            keys: "Alt:m",
            group: "Code",
            label: "Comment on the selection (switches to Source)",
            // from the editor too: a comment is on what the editor has selected
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => startComment(),
        },
        {
            id: "code:send-review",
            keys: "Alt:Shift:m",
            group: "Code",
            label: "Send the review",
            when: (ctx) => ctx.surface === "code" && !ctx.modalOpen,
            run: () => {
                const project = globalStore.get(codeProjectAtom);
                if (project == null || projectComments(globalStore.get(codeReviewsAtom), project.path).length === 0) {
                    return false; // no review to send, and so no toolbar to open it in
                }
                globalStore.set(codeReviewSendOpenAtom, true);
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

// The Setup surface's Memory tab keys, registered by the tab while it is mounted, so the surface check is
// enough to keep them off every other tab. A verdict key does what its button does, and nothing while the
// button is disabled.
export function buildMemoryBindings(): Binding[] {
    const on = (ctx: KeyContext) => ctx.surface === "setup" && !ctx.editable && !ctx.modalOpen;
    const bind = (id: string, keys: string, label: string, run: () => void | boolean): Binding => ({
        id: `memory:${id}`,
        keys,
        group: "Setup · Memory",
        label,
        when: on,
        run,
    });
    const move = (delta: number) => () => {
        const { project, change } = memorySelection();
        const next = project == null ? null : stepChange(project, change?.id ?? null, delta);
        if (next == null) {
            return false;
        }
        selectMemoryChange(next);
    };
    const decide = (verdict: MemVerdict, allowed: (p: MemHygieneProject, c: MemChange) => boolean) => () => {
        const { project, change } = memorySelection();
        if (project == null || change == null || globalStore.get(memoryBusyAtom) || !allowed(project, change)) {
            return false;
        }
        fireAndForget(() => decideMemory(project.project, change.id, verdict));
    };
    return [
        bind("next", "j", "Next change", move(1)),
        bind("prev", "k", "Previous change", move(-1)),
        bind("next-arrow", "ArrowDown", "Next change", move(1)),
        bind("prev-arrow", "ArrowUp", "Previous change", move(-1)),
        bind("apply", "a", "Apply the change", decide("apply", canApply)),
        bind(
            "keep",
            "x",
            "Keep as is",
            decide("keep", (_p, c) => isPending(c))
        ),
        bind("undo", "u", "Undo an applied change, or review a kept one again", () => {
            const c = memorySelection().change;
            return decide(
                c?.status === "applied" ? "undo" : "reopen",
                (_p, ch) => !isPending(ch) && !undoExpired(ch, Date.now())
            )();
        }),
        {
            ...bind("close-detail", "Escape", "Close the change detail", () =>
                globalStore.set(memoryDetailOpenAtom, false)
            ),
            when: (ctx) => on(ctx) && memorySheetOpen() && noEscapeMenuOpen(),
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

// The canvas window's keys, registered by the window while it is mounted. Gated on its atom: that atom is what makes
// modalOpen true on the Agent surface, which stands the agent's own canvas keys down under it. A focused field (the
// mark's note) keeps its keys, Esc included. escape is the window's one Esc handler, which ModalShell's onClose calls too
export function buildCanvasWindowBindings(escape: () => void): Binding[] {
    const id = () => globalStore.get(canvasWindowAtom);
    // the open window's canvas, while its keys are its own
    const shown = (ctx: KeyContext) =>
        ctx.surface === "agent" && ctx.modalOpen && !ctx.editable && id() != null ? getCanvas(id()!) : null;
    const ready = (ctx: KeyContext) => {
        const s = shown(ctx);
        return s != null && !s.marking && paneState(s) === "board";
    };
    const bind = (name: string, keys: string, label: string, when: Binding["when"], run: () => void): Binding => ({
        id: `canvas-window:${name}`,
        keys,
        group: "Canvas window",
        label,
        when,
        paletteHidden: true,
        run,
    });
    return [
        bind("escape", "Escape", "Drop the drawn mark, else close the window", (ctx) => shown(ctx) != null, escape),
        bind("mark-start", "m", "Mark part of the board", ready, () => setMarking(id()!, true)),
        bind(
            "mark-stop",
            "m",
            "Stop marking",
            (ctx) => shown(ctx)?.marking === true,
            () => setMarking(id()!, false)
        ),
        bind("prev", "[", "Previous board", ready, () => stepCanvasBoard(id()!, -1)),
        bind("next", "]", "Next board", ready, () => stepCanvasBoard(id()!, 1)),
    ];
}

// The Resource Manager popover's keys, registered by the always-mounted popover. Gated on its own atom rather
// than on !modalOpen: that atom is what makes modalOpen true, which stands the surface's arrows, Enter and Escape
// down under it. A palette or modal opened over the popover keeps its own keys.
export function buildResMonBindings(model: AgentsViewModel): Binding[] {
    const active = (ctx: KeyContext) =>
        globalStore.get(resmonOpenAtom) && !ctx.editable && !anyModalOpen() && !globalStore.get(model.paletteOpenAtom);
    const views = () => globalStore.get(resmonViewsAtom);
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
