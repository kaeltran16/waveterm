// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Resume-on-reopen (Claude only, v1). Agent blocks already survive quit+reopen: the tab/block/layout
// are DB-backed and ResyncController relaunches each block from its persisted cmd:args when the term
// view mounts. But that replay is a *fresh* session — it re-runs the original task prompt. As a running
// Claude agent reports its live transcript via agent:status, we bake that session's `--resume <id>`
// into the block's persisted cmd:args, so the very same relaunch reattaches to the session instead of
// starting over. FE-only, no backend change; codex/antigravity keep restarting fresh.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { resumeArgsForClaude, sessionIdFromTranscript } from "../launch";
import { naRememberFlagsAtom } from "../naflagsstore";

// oref -> resume id already baked into the block this session, to skip redundant SetMeta writes
const bakedResumeId = new Map<string, string>();

// Pure: resume-on-reopen is Claude-only, gated on the user's "Remember flags" New Agent default. When
// that setting is off the user wants a clean slate, so the agent relaunches fresh on reopen; when on
// (the default) reopening reattaches to the live session. codex/antigravity always restart fresh.
export function shouldPersistClaudeResume(provider: string | undefined, rememberFlags: boolean): boolean {
    return (provider ?? "").toLowerCase() === "claude" && rememberFlags === true;
}

function sameArgs(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Bake the live Claude session's --resume key into the block's persisted cmd:args. Fire-and-forget: any
// failure just leaves the block to relaunch fresh (today's behavior), so callers ignore the result.
export async function persistClaudeResume(
    oref: string,
    provider: string | undefined,
    transcriptPath: string | undefined
): Promise<void> {
    if (!shouldPersistClaudeResume(provider, globalStore.get(naRememberFlagsAtom))) {
        return;
    }
    const sessionId = sessionIdFromTranscript(transcriptPath);
    if (!sessionId || bakedResumeId.get(oref) === sessionId) {
        return;
    }
    const block = WOS.getObjectValue<Block>(oref);
    const meta = block?.meta as Record<string, unknown> | undefined;
    if (!meta || meta["controller"] !== "cmd" || meta["cmd"] !== "claude") {
        return;
    }
    const baseArgs = meta["agent:baseargs"] as string[] | undefined;
    if (baseArgs == null) {
        return; // launched before resume support: relaunches fresh
    }
    const nextArgs = resumeArgsForClaude(sessionId, baseArgs);
    const curArgs = (meta["cmd:args"] as string[] | undefined) ?? [];
    if (sameArgs(nextArgs, curArgs)) {
        bakedResumeId.set(oref, sessionId);
        return;
    }
    try {
        await RpcApi.SetMetaCommand(TabRpcClient, { oref, meta: { "cmd:args": nextArgs } });
        await WOS.reloadWaveObject(oref); // keep the cached block fresh for the next comparison
        bakedResumeId.set(oref, sessionId);
    } catch {
        // leave bakedResumeId unset so a later status retries
    }
}
