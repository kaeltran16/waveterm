// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { globalStore } from "@/app/store/jotaiStore";
import type { TabModel } from "@/app/store/tab-model";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import {
    buildAskAnswers,
    canSubmitAsk,
    cycleId,
    mergePendingLaunches,
    type AgentVM,
    type CardPref,
    type PendingLaunch,
} from "./agentsviewmodel";
import { CockpitSurface } from "./cockpitsurface";
import type { ActivityType } from "./activityevents";
import { devRosterAtom, loadDevMockRoster } from "./devmock";
import { liveAgentsAtom, liveTerminalsAtom } from "./liveagents";

export type SurfaceKey =
    | "cockpit"
    | "agent"
    | "activity"
    | "channels"
    | "sessions"
    | "files"
    | "memory"
    | "usage"
    | "settings";

// Ordered to match the NavRail (navrail.tsx ITEMS) so Ctrl+1..8 line up with what the user sees.
export const SURFACE_ORDER: SurfaceKey[] = [
    "cockpit",
    "agent",
    "activity",
    "channels",
    "sessions",
    "files",
    "memory",
    "usage",
];

export type ChipFilter = "all" | "asking" | "working" | "idle";

export class AgentsViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    viewIcon = atom<string>("robot");
    viewName = atom<string>("Agents");
    noPadding = atom(true);
    agentsAtom: Atom<AgentVM[]>; // base roster overlaid with pending launches
    baseRosterAtom: Atom<AgentVM[]>; // un-overlaid roster (dev mock or live) — read by the prune effect
    // Background terminals launched via New Agent: kept separate from the agent roster (own tree group
    // + focus pane). Always live (reads the workspace session sidebar), independent of the dev mock roster.
    terminalsAtom: Atom<AgentVM[]> = liveTerminalsAtom;
    pendingLaunchesAtom = atom<PendingLaunch[]>([]) as PrimitiveAtom<PendingLaunch[]>;
    // the term blockId the Agent surface renders; undefined = no terminal open
    terminalTargetAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;

    // orchestration state lifted off the surface's useStates (spec §4); surfaces read/write via globalStore
    surfaceAtom = atom<SurfaceKey>("cockpit");
    nowAtom = atom(Date.now());
    cursorIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;
    orderAtom = atom<string[]>([]) as PrimitiveAtom<string[]>;
    backgroundedIdsAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
    dismissedAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
    answerSelAtom = atom<Record<string, Record<number, Set<number>>>>({}) as PrimitiveAtom<
        Record<string, Record<number, Set<number>>>
    >;
    answerTabAtom = atom<Record<string, number>>({}) as PrimitiveAtom<Record<string, number>>;
    sentIdsAtom = atom<Set<string>>(new Set<string>()) as PrimitiveAtom<Set<string>>;
    focusIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;
    focusReplyAtom = atom(false);
    railOpenAtom = atom(true);
    chipFilterAtom = atom<ChipFilter>("all");
    // Activity surface: selected type filter chip (spec §4.1). Default "all".
    activityFilterAtom = atom<ActivityType | "all">("all");
    // Activity surface: selected project scope ("all" | <project>), independent of the type chip.
    activityProjectFilterAtom = atom<string>("all");

    // New Project / New Agent modal + command-palette visibility (gated overlays rendered from the cockpit root).
    newProjectOpenAtom = atom(false);
    newAgentOpenAtom = atom(false);
    paletteOpenAtom = atom(false);

    // handoff-parity filters + per-card layout (spec §State). Project scope is a single source bound to
    // both the app-bar switcher and the header button; card prefs are ephemeral (not persisted).
    projectFilterAtom = atom<string>("all"); // "all" | <projectName>
    liveOnlyAtom = atom(false);
    cardPrefsAtom = atom<Record<string, CardPref>>({}) as PrimitiveAtom<Record<string, CardPref>>;
    // which card's composer is expanded (one at a time); asking cards are always expanded regardless
    openComposerIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.viewType = "agents";
        // DEV-only: runtime mock roster from frontend/tauri/public/cockpit-fixtures/active.json (see
        // devmock.ts + scripts/gen-cockpit-fixtures.mjs). import.meta.env.DEV is build-time -> prod uses live.
        if (import.meta.env.DEV) {
            void loadDevMockRoster();
            this.baseRosterAtom = devRosterAtom;
        } else {
            this.baseRosterAtom = liveAgentsAtom;
        }
        const base = this.baseRosterAtom;
        const pendingAtom = this.pendingLaunchesAtom;
        // Booting launches overlay the roster until the reporter registers them (supersede by tabId).
        this.agentsAtom = atom((get) => mergePendingLaunches(get(base), get(pendingAtom), Date.now()));
    }

    // openTerminal routes to the interim Agent surface (spec §6): set the target block, clear any focused
    // transcript, switch surface. The Agent surface renders CockpitFocusPane; the controller starts on render.
    openTerminal(agentId: string) {
        const agent = globalStore.get(this.agentsAtom).find((a) => a.id === agentId);
        globalStore.set(this.terminalTargetAtom, agent?.blockId);
        globalStore.set(this.focusIdAtom, agentId);
        globalStore.set(this.surfaceAtom, "agent");
    }

    // Cycle the focused agent (Ctrl+Tab). askingOnly restricts to asking agents (Ctrl+Shift+Tab).
    cycleFocus(askingOnly: boolean) {
        const agents = globalStore.get(this.agentsAtom);
        const byId = new Map(agents.map((a) => [a.id, a]));
        const ordered = globalStore.get(this.orderAtom).filter((id) => byId.has(id));
        let ids = ordered.length ? ordered : agents.map((a) => a.id);
        if (askingOnly) {
            ids = ids.filter((id) => byId.get(id)?.state === "asking");
        }
        const next = cycleId(ids, globalStore.get(this.focusIdAtom), 1);
        if (next != null) {
            globalStore.set(this.focusIdAtom, next);
        }
    }

    // Shared by the cockpit grid and the Agent surface. Validates against the model atoms, fires the RPC
    // once, and marks the ask sent so the answer bar locks.
    submitAnswer(agentId: string) {
        const agent = globalStore.get(this.agentsAtom).find((a) => a.id === agentId);
        const sent = globalStore.get(this.sentIdsAtom);
        if (!agent || sent.has(agentId)) {
            return;
        }
        const qs = agent.ask?.questions ?? [];
        const sel = globalStore.get(this.answerSelAtom)[agentId] ?? {};
        const oref = agent.ask?.oref;
        if (!canSubmitAsk(qs, sel) || !oref) {
            return;
        }
        fireAndForget(() => RpcApi.AnswerAgentCommand(TabRpcClient, { oref, answers: buildAskAnswers(qs, sel) }));
        globalStore.set(this.sentIdsAtom, new Set(sent).add(agentId));
    }

    get viewComponent(): ViewComponent {
        return CockpitSurface;
    }
}
