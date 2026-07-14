// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Impure Run lifecycle: thin wrappers over the Piece 1 RPCs. CreateRun sources the active workspace id
// from the boot-resolved global atom (mirrors agentactions.ts). Approve/send-back drive the review gate;
// cancel stops the run. Phase *completion* is reported by the external ~/.claude hook, not from here.

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import type { PendingRunDraft } from "./radarmodel";

// The pending Run draft handed from Radar's "Start investigation" to the Channels Run composer. Ephemeral
// (lost on reload, which is fine for a review step); cleared on explicit Start or Discard.
export const pendingRunDraftAtom = atom<PendingRunDraft | null>(null) as PrimitiveAtom<PendingRunDraft | null>;

// Run ids whose Cancel RPC is in flight. CancelRunCommand is synchronous — it returns only after each
// worker's graceful stop completes — so this real interval drives the transient "Cancelling…" button
// label until the run flips to cancelled. Frontend-only (lost on reload, which lands on the already-
// cancelled run).
export const cancellingRunIdsAtom = atom<Set<string>>(new Set<string>());

export async function createRun(
    channelId: string,
    goal: string,
    opts?: { mode?: string; planGate?: boolean; radarOrigin?: { reportid: string; findingid: string; fingerprint: string } }
): Promise<Run> {
    const workspaceId = globalStore.get(atoms.workspaceId);
    const rtn = await RpcApi.CreateRunCommand(TabRpcClient, {
        channelid: channelId,
        workspaceid: workspaceId,
        goal,
        mode: opts?.mode,
        plangate: opts?.planGate,
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

export async function setChannelProfile(channelId: string, override: ProfileOverride): Promise<void> {
    await RpcApi.SetChannelProfileCommand(TabRpcClient, { channelid: channelId, override });
}
