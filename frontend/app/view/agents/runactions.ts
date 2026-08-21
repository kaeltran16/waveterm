// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Impure Run lifecycle: thin wrappers over the Piece 1 RPCs. CreateRun sources the active workspace id
// from the boot-resolved global atom (mirrors agentactions.ts). Approve/send-back drive the review gate;
// cancel stops the run. Phase *completion* is reported by the external ~/.claude hook, not from here.

import { atoms } from "@/app/store/global-atoms";
import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import type { PendingRunDraft } from "./radarmodel";
import { normalizeProfileOverrideRoute, resolveEffectiveRoute } from "./route";
import { harnessesAtom, harnessPreferenceAtom } from "./harnessstore";

// The pending Run draft handed from Radar's "Start investigation" to the Channels Run composer. Ephemeral
// (lost on reload, which is fine for a review step); cleared on explicit Start or Discard.
export const pendingRunDraftAtom = atom<PendingRunDraft | null>(null) as PrimitiveAtom<PendingRunDraft | null>;

// A one-shot request to focus a specific run (e.g. from Radar's "Open run"). The Stage consumes it on
// landing: select the channel, then select the run once its strip is populated, then clear. `landed`
// mirrors pendingRunDraftAtom's guard and bounds the navigation to one attempt — a run that never shows up
// in the channel's list (channel load failed, run gone) must not keep pulling the user back.
export interface PendingRunFocus {
    channelId: string;
    runId: string;
    landed?: boolean;
}

export const pendingRunFocusAtom = atom<PendingRunFocus | null>(null) as PrimitiveAtom<PendingRunFocus | null>;

// Run ids whose Cancel RPC is in flight. CancelRunCommand is synchronous — it returns only after each
// worker's graceful stop completes — so this real interval drives the transient "Cancelling…" button
// label until the run flips to cancelled. Frontend-only (lost on reload, which lands on the already-
// cancelled run).
export const cancellingRunIdsAtom = atom<Set<string>>(new Set<string>());

// Worker tab ids whose per-worker Stop RPC is in flight (partial-failure surface). Mirrors
// cancellingRunIdsAtom: StopRunWorkerCommand is synchronous, so this drives a transient "Stopping…" label
// on the survivor's Stop button. Frontend-only.
export const stoppingWorkerIdsAtom = atom<Set<string>>(new Set<string>());

// Stop one surviving worker of a cancelled run (partial-failure surface). workerORef is the worker's tab
// oref ("tab:<id>"). Tracks the in-flight tab id so the button reads "Stopping…"; the roster flips the
// row to idle on success, which drops it from cancelSurvivors.
export async function stopRunWorker(channelId: string, runId: string, workerORef: string): Promise<void> {
    const tabId = workerORef.startsWith("tab:") ? workerORef.slice(4) : workerORef;
    globalStore.set(stoppingWorkerIdsAtom, (prev) => new Set(prev).add(tabId));
    try {
        await RpcApi.StopRunWorkerCommand(TabRpcClient, { channelid: channelId, runid: runId, workeroref: workerORef });
    } finally {
        globalStore.set(stoppingWorkerIdsAtom, (prev) => {
            const next = new Set(prev);
            next.delete(tabId);
            return next;
        });
    }
}

export async function createRun(
    channelId: string,
    goal: string,
    route: RoutePin,
    opts?: {
        mode?: string;
        planGate?: boolean;
        deferStart?: boolean;
        radarOrigin?: { reportid: string; findingid: string; fingerprint: string };
    }
): Promise<Run> {
    if (!route.runtime || !route.tier) throw new Error("Choose a route");
    const workspaceId = globalStore.get(atoms.workspaceId);
    const rtn = await RpcApi.CreateRunCommand(TabRpcClient, {
        channelid: channelId,
        workspaceid: workspaceId,
        goal,
        runtime: route.runtime,
        tier: route.tier,
        mode: opts?.mode,
        plangate: opts?.planGate,
        deferstart: opts?.deferStart,
        radarorigin: opts?.radarOrigin,
    });
    return rtn.run;
}

export async function approveGate(channelId: string, runId: string, gateIdx: number): Promise<void> {
    await RpcApi.AdvanceRunCommand(TabRpcClient, {
        channelid: channelId,
        runid: runId,
        phaseidx: gateIdx,
        action: "approve",
    });
}

export async function sendBackGate(channelId: string, runId: string, gateIdx: number): Promise<void> {
    await RpcApi.AdvanceRunCommand(TabRpcClient, {
        channelid: channelId,
        runid: runId,
        phaseidx: gateIdx,
        action: "sendback",
    });
}

export async function cancelRun(channelId: string, runId: string): Promise<void> {
    globalStore.set(cancellingRunIdsAtom, (prev) => new Set(prev).add(runId));
    try {
        await RpcApi.CancelRunCommand(TabRpcClient, { channelid: channelId, runid: runId });
    } finally {
        globalStore.set(cancellingRunIdsAtom, (prev) => {
            const next = new Set(prev);
            next.delete(runId);
            return next;
        });
    }
}

// Cancel a run, confirming first when it has live workers (goal: never silently stop running agents).
// liveCount 0 (e.g. the worker already exited — the "blocked · worker exited" card) cancels directly.
// Copy reassures that completed work is kept: the backend stops the processes but keeps worker tabs,
// transcripts, and completed phases.
export function confirmCancelRun(channelId: string, runId: string, liveCount: number): void {
    const doCancel = () => fireAndForget(() => cancelRun(channelId, runId));
    if (liveCount <= 0) {
        doCancel();
        return;
    }
    const n = liveCount === 1 ? "1 running worker" : `${liveCount} running workers`;
    modalsModel.pushModal("ConfirmModal", {
        title: "Cancel run",
        message: `Stop ${n} and cancel this run? Completed phases, transcripts, and artifacts are kept.`,
        confirmLabel: "Cancel run",
        cancelLabel: "Keep running",
        destructive: true,
        onConfirm: doCancel,
    });
}

export async function getJarvisProfile(channelId: string): Promise<CommandGetJarvisProfileRtnData> {
    return RpcApi.GetJarvisProfileCommand(TabRpcClient, { channelid: channelId });
}

// The resolved (global + channel override) Jarvis profile, keyed by channel id. Module scope so ⚙'s Save
// refreshes every reader at once: a Stage-local copy went stale the moment the drawer wrote, and the
// composer went on labelling the run strategy the user had just replaced.
export const resolvedProfileAtom = atom<Record<string, JarvisProfile>>({}) as PrimitiveAtom<
    Record<string, JarvisProfile>
>;

export const channelOverrideAtom = atom<Record<string, ProfileOverride>>({}) as PrimitiveAtom<
    Record<string, ProfileOverride>
>;

export function loadResolvedProfile(channelId: string): void {
    if (globalStore.get(resolvedProfileAtom)[channelId] != null) {
        return;
    }
    fireAndForget(() => refreshResolvedProfile(channelId));
}

export function cacheJarvisProfile(channelId: string, response: CommandGetJarvisProfileRtnData): void {
    globalStore.set(channelOverrideAtom, { ...globalStore.get(channelOverrideAtom), [channelId]: response.override ?? {} });
    if (response.resolved != null) {
        globalStore.set(resolvedProfileAtom, { ...globalStore.get(resolvedProfileAtom), [channelId]: response.resolved });
    }
}

export async function refreshResolvedProfile(channelId: string): Promise<void> {
    const r = await getJarvisProfile(channelId);
    cacheJarvisProfile(channelId, r);
}

// A global-profile write re-resolves every channel, not just the one the drawer was opened on.
export function clearResolvedProfiles(): void {
    globalStore.set(resolvedProfileAtom, {});
    globalStore.set(channelOverrideAtom, {});
}

export async function resolveChannelLaunchRoute(channelId: string): Promise<RoutePin> {
    const response = await getJarvisProfile(channelId);
    cacheJarvisProfile(channelId, response);
    const settingsRuntime = (globalStore.get(getSettingsKeyAtom("harness:preferredruntime")) as string) ?? "";
    const settingsTier = (globalStore.get(getSettingsKeyAtom("harness:preferredtier")) as string) ?? "";
    const pref = globalStore.get(harnessPreferenceAtom);
    const settings = pref.route ?? (settingsRuntime ? { runtime: settingsRuntime, tier: settingsTier || "capable" } : null);
    const effective = resolveEffectiveRoute({
        settings,
        channel: response.override?.route ?? null,
        harnesses: globalStore.get(harnessesAtom),
    });
    if (effective == null || effective.capability == null) {
        throw new Error("Selected route is unavailable");
    }
    return effective.pin;
}

export async function setChannelProfile(channelId: string, override: ProfileOverride): Promise<void> {
    await RpcApi.SetChannelProfileCommand(TabRpcClient, {
        channelid: channelId,
        override: normalizeProfileOverrideRoute(override),
    });
}

export async function getGlobalProfile(): Promise<JarvisProfile> {
    return RpcApi.GetGlobalProfileCommand(TabRpcClient);
}

export async function setGlobalProfile(profile: JarvisProfile): Promise<void> {
    await RpcApi.SetGlobalProfileCommand(TabRpcClient, { profile });
}
