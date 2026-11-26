// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Disk-backed subagent lists per parent agent, plus the "which child interior is open" selection.
// Mirrors cardgitstore.ts: refresh on enter, scheduleSubagents (debounced) on parent-transcript
// activity, drop on leave. The source of truth is the on-disk subagents/ dir (GetSubagentsCommand);
// the parent transcript tail supplies the Task spawns that correlate type + outcome onto each file.
// While any child works, its listing alone is re-read every SUBAGENT_POLL_MS against the spawns of the
// last full refresh: a background child runs while the parent sits quiet, so no parent activity reads it.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { getProcExitAtom } from "./agentcontrollerstore";
import type { SubagentVM } from "./session-models/sessionviewmodel";
import { correlateSubagents } from "./subagentcorrelate";
import { extractSubagentSpawns, type SubagentSpawn } from "./transcriptprojection";

export interface FocusSubagent {
    parentId: string;
    agentId: string;
    transcriptPath: string;
    label: string;
}

// per parent-agent-id -> its correlated children
export const subagentsByIdAtom = atom<Record<string, SubagentVM[]>>({}) as PrimitiveAtom<Record<string, SubagentVM[]>>;
// the child interior currently open in the focused view (null = show the parent terminal)
export const focusSubagentAtom = atom<FocusSubagent | null>(null) as PrimitiveAtom<FocusSubagent | null>;

export const SUBAGENT_POLL_MS = 2000;

const PARENT_TAIL_LINES = 1000; // covers the current turn's Task spawns + results
const DEBOUNCE_MS = 4000; // same cadence as cardgitstore
// a first listing reads every child file whole (they reach 65 MB), past the 5s rpc default; a timed-out read
// only keeps the last list
const LISTING_TIMEOUT_MS = 30_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const loadSeq = new Map<string, number>();
// per parent: the spawns of its last full refresh, which a poll correlates against
const spawnsById = new Map<string, SubagentSpawn[]>();

interface ParentSource {
    transcriptPath: string;
    blockId?: string;
}

/** Open a subagent in the center, as the child of its parent. */
export function openSubagent(parentId: string, sub: SubagentVM): void {
    globalStore.set(focusSubagentAtom, {
        parentId,
        agentId: sub.id,
        transcriptPath: sub.transcriptPath ?? "",
        label: sub.type || "subagent",
    });
}

function setList(id: string, list: SubagentVM[] | null): void {
    const cur = globalStore.get(subagentsByIdAtom);
    if (list == null || list.length === 0) {
        if (!(id in cur)) {
            return;
        }
        const { [id]: _, ...rest } = cur;
        globalStore.set(subagentsByIdAtom, rest);
        return;
    }
    globalStore.set(subagentsByIdAtom, { ...cur, [id]: list });
}

function clearPoll(id: string): void {
    const existing = pollTimers.get(id);
    if (existing) {
        clearTimeout(existing);
        pollTimers.delete(id);
    }
}

// a new read supersedes any in flight and any pending poll
function nextSeq(id: string): number {
    const seq = (loadSeq.get(id) ?? 0) + 1;
    loadSeq.set(id, seq);
    clearPoll(id);
    return seq;
}

// the parent's session ended: its block reports its process exited, so an unfinished child is lost with it
function parentEnded(blockId: string | undefined): boolean {
    return blockId != null && globalStore.get(getProcExitAtom(blockId)) != null;
}

function readListing(path: string): Promise<CommandGetSubagentsRtnData> {
    return RpcApi.GetSubagentsCommand(TabRpcClient, { path }, { timeout: LISTING_TIMEOUT_MS });
}

function storeFiles(id: string, files: SubagentFileInfo[], src: ParentSource): void {
    if (files.length === 0) {
        setList(id, null);
        return;
    }
    const spawns = spawnsById.get(id) ?? [];
    setList(id, correlateSubagents(spawns, files, { parentEnded: parentEnded(src.blockId) }));
}

// armed only after a read that is still current, so reads never overlap
function armPoll(id: string, src: ParentSource): void {
    const list = globalStore.get(subagentsByIdAtom)[id] ?? [];
    if (!list.some((s) => s.state === "working")) {
        return;
    }
    pollTimers.set(
        id,
        setTimeout(() => {
            pollTimers.delete(id);
            void pollSubagents(id, src);
        }, SUBAGENT_POLL_MS)
    );
}

// a failed read keeps the last known list, as shelltasksstore does: clearing it reads as the agent's background
// subagents finishing (the rail says finished, the card settles and leaves for Idle). The next read retries
function warnRead(id: string, e: unknown): void {
    console.warn("reading the subagents of", id, e);
}

async function pollSubagents(id: string, src: ParentSource): Promise<void> {
    const seq = nextSeq(id);
    try {
        const subs = await readListing(src.transcriptPath);
        if (loadSeq.get(id) !== seq) {
            return;
        }
        storeFiles(id, subs.subagents ?? [], src);
    } catch (e) {
        if (loadSeq.get(id) !== seq) {
            return;
        }
        warnRead(id, e);
    }
    armPoll(id, src);
}

/** Load the parent's subagent files + tail its transcript, correlate, and store; then poll while a child works.
 *  Guarded so a superseding load (or a drop) discards a slower older result. blockId is the parent's terminal
 *  block, whose process exit stops its unfinished children. */
export async function refreshSubagents(id: string, transcriptPath: string | undefined, blockId?: string): Promise<void> {
    const seq = nextSeq(id);
    if (!transcriptPath) {
        spawnsById.delete(id);
        setList(id, null);
        return;
    }
    const src = { transcriptPath, blockId };
    try {
        const [subs, tr] = await Promise.all([
            readListing(transcriptPath),
            RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: transcriptPath, maxlines: PARENT_TAIL_LINES }),
        ]);
        if (loadSeq.get(id) !== seq) {
            return;
        }
        spawnsById.set(id, extractSubagentSpawns(tr.lines ?? []));
        storeFiles(id, subs.subagents ?? [], src);
    } catch (e) {
        if (loadSeq.get(id) !== seq) {
            return;
        }
        warnRead(id, e);
    }
    armPoll(id, src);
}

/** Debounced refresh, coalescing a burst of parent activity into one load. */
export function scheduleSubagents(id: string, transcriptPath: string | undefined, blockId?: string): void {
    const existing = timers.get(id);
    if (existing) {
        clearTimeout(existing);
    }
    timers.set(
        id,
        setTimeout(() => {
            timers.delete(id);
            void refreshSubagents(id, transcriptPath, blockId);
        }, DEBOUNCE_MS)
    );
}

/** Stop tracking a parent that left the rendered set: cancel pending work and polls, invalidate in-flight loads,
 *  drop its list, and close the interior if it belonged to this parent. */
export function dropSubagents(id: string): void {
    const existing = timers.get(id);
    if (existing) {
        clearTimeout(existing);
        timers.delete(id);
    }
    nextSeq(id);
    spawnsById.delete(id);
    setList(id, null);
    const fs = globalStore.get(focusSubagentAtom);
    if (fs && fs.parentId === id) {
        globalStore.set(focusSubagentAtom, null);
    }
}
