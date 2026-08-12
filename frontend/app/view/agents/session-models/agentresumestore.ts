// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Resume-on-reopen (Claude only, v1). Agent blocks already survive quit+reopen: the tab/block/layout
// are DB-backed and ResyncController relaunches each block from its persisted cmd:args when the term
// view mounts. But that replay is a *fresh* session — it re-runs the original task prompt. As a running
// Claude agent reports its live transcript via agent:status, we bake that session's `--resume <id>`
// into the block's persisted cmd:args, so the very same relaunch reattaches to the session instead of
// starting over. FE-only, no backend change; codex keeps restarting fresh.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { resumeArgsForClaude, resumeArgsForOpencode, resumeArgsForPi, sessionIdFromTranscript } from "../launch";
import { naRememberFlagsAtom } from "../naflagsstore";

// oref -> resume key already baked into the block this session, to skip redundant SetMeta writes
const bakedResumeId = new Map<string, string>();

// Pure: resume-on-reopen is Claude-, opencode-, and Pi-only, gated on the user's "Remember flags" New
// Agent default. When that setting is off the user wants a clean slate, so the agent relaunches
// fresh on reopen; when on (the default) reopening reattaches to the live session. codex
// always restarts fresh.
export function shouldPersistResume(provider: string | undefined, rememberFlags: boolean): boolean {
    const p = (provider ?? "").toLowerCase();
    return (p === "claude" || p === "opencode" || p === "pi") && rememberFlags === true;
}

function sameArgs(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Bake the live session's resume key into the block's persisted cmd:args. Fire-and-forget: any
// failure just leaves the block to relaunch fresh (today's behavior), so callers ignore the result.
export async function persistResume(
    oref: string,
    provider: string | undefined,
    transcriptPath: string | undefined
): Promise<void> {
    if (!shouldPersistResume(provider, globalStore.get(naRememberFlagsAtom))) {
        return;
    }
    const block = WOS.getObjectValue<Block>(oref);
    const meta = block?.meta as Record<string, unknown> | undefined;
    const cmd = meta?.["cmd"];
    if (!meta || meta["controller"] !== "cmd" || (cmd !== "claude" && cmd !== "opencode" && cmd !== "pi")) {
        return;
    }
    const baseArgs = meta["agent:baseargs"] as string[] | undefined;
    if (baseArgs == null) {
        return; // launched before resume support: relaunches fresh
    }
    // pi's resume key is the full transcript path (--session takes a path, never an id), so the dedup
    // cache key is the path too — sessionIdFromTranscript must never run on a pi path.
    const cacheKey = cmd === "pi" ? transcriptPath : sessionIdFromTranscript(transcriptPath);
    if (!cacheKey || bakedResumeId.get(oref) === cacheKey) {
        return;
    }
    const nextArgs =
        cmd === "pi"
            ? resumeArgsForPi(transcriptPath!, baseArgs)
            : cmd === "opencode"
              ? resumeArgsForOpencode(cacheKey, baseArgs)
              : resumeArgsForClaude(cacheKey, baseArgs);
    const curArgs = (meta["cmd:args"] as string[] | undefined) ?? [];
    if (sameArgs(nextArgs, curArgs)) {
        bakedResumeId.set(oref, cacheKey);
        return;
    }
    try {
        await RpcApi.SetMetaCommand(TabRpcClient, { oref, meta: { "cmd:args": nextArgs } });
        await WOS.reloadWaveObject(oref); // keep the cached block fresh for the next comparison
        bakedResumeId.set(oref, cacheKey);
    } catch {
        // leave bakedResumeId unset so a later status retries
    }
}
