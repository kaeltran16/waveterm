// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Setup surface state: the tab, and the Instructions tab's status and shared doc with their agentsync
// loaders. The Skills tab's state is in setupskillsstore.ts. Module-level atoms because every surface but
// Agent unmounts on a switch: the shared-doc draft must survive one, and the rest is cheap to keep.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import {
    editorDiscard,
    editorLoaded,
    editorReload,
    editorSaved,
    editorTyped,
    EMPTY_EDITOR,
    saveBaseMtime,
    type DocEditor,
} from "./setupmodel";

export type SetupTab = "instructions" | "skills" | "memory";

// local filesystem reads behind an rpc with no default timeout: a stalled backend must reject rather
// than leave the pane on "Reading…" forever
export const READ_TIMEOUT_MS = 5000;

export const setupTabAtom = atom<SetupTab>("instructions") as PrimitiveAtom<SetupTab>;
export const setupStatusAtom = atom<CommandAgentSyncStatusRtnData | null>(
    null
) as PrimitiveAtom<CommandAgentSyncStatusRtnData | null>;
export const setupSharedPathAtom = atom<string>("") as PrimitiveAtom<string>;
export const setupSharedAtom = atom<DocEditor>(EMPTY_EDITOR) as PrimitiveAtom<DocEditor>;
// one action at a time across both tabs: the Skills tab's adopt also re-renders every harness
export const setupBusyAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
// one error per tab, so one tab's successful read never clears the other's banner
export const setupInstructionsErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

export function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// runs one action, reporting its failure to the tab whose error atom is given
export async function busy(errorAtom: PrimitiveAtom<string | null>, fn: () => Promise<void>): Promise<void> {
    globalStore.set(setupBusyAtom, true);
    globalStore.set(errorAtom, null);
    try {
        await fn();
    } catch (e) {
        globalStore.set(errorAtom, errText(e));
    } finally {
        globalStore.set(setupBusyAtom, false);
    }
}

// Status gives the rows, their order, and each harness file's state against the shared doc.
async function load(): Promise<void> {
    const [status, steering] = await Promise.all([
        RpcApi.AgentSyncStatusCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS }),
        RpcApi.AgentSyncSteeringReadCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS }),
    ]);
    globalStore.set(setupStatusAtom, status);
    globalStore.set(setupSharedPathAtom, steering.path ?? status.steeringdoc ?? "");
    globalStore.set(
        setupSharedAtom,
        editorLoaded(globalStore.get(setupSharedAtom), steering.content ?? "", steering.mtime ?? 0)
    );
}

export async function loadSetup(): Promise<void> {
    try {
        await load();
        globalStore.set(setupInstructionsErrorAtom, null);
    } catch (e) {
        globalStore.set(setupInstructionsErrorAtom, errText(e));
    }
}

// ---- shared doc ----

export function typeShared(draft: string): void {
    globalStore.set(setupSharedAtom, editorTyped(globalStore.get(setupSharedAtom), draft));
}

export function discardShared(): void {
    globalStore.set(setupSharedAtom, editorDiscard(globalStore.get(setupSharedAtom)));
}

export function reloadShared(): Promise<void> {
    return busy(setupInstructionsErrorAtom, async () => {
        const r = await RpcApi.AgentSyncSteeringReadCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS });
        globalStore.set(setupSharedAtom, editorReload(r.content ?? "", r.mtime ?? 0));
    });
}

// The doc as it is on disk, for the conflict notice to list what the outside edit changed. A failed read
// leaves disk null, which the notice says, so Reload and Overwrite stay the way out.
async function readDiskAfterConflict(): Promise<void> {
    try {
        const r = await RpcApi.AgentSyncSteeringReadCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS });
        const ed = globalStore.get(setupSharedAtom);
        if (ed.conflict) {
            globalStore.set(setupSharedAtom, { ...ed, disk: r.content ?? "" });
        }
    } catch (e) {
        console.error("reading the shared doc after a save conflict:", e);
    }
}

// Write, then project at once: a doc the harnesses have not received is the stale state this exists to
// remove. A conflict stops before the apply and leaves the draft for Reload or Overwrite.
export function saveShared(overwrite: boolean): Promise<void> {
    return busy(setupInstructionsErrorAtom, async () => {
        const ed = globalStore.get(setupSharedAtom);
        const written = ed.draft;
        const res = await RpcApi.AgentSyncSteeringWriteCommand(TabRpcClient, {
            content: written,
            basemtime: saveBaseMtime(ed, overwrite),
        });
        globalStore.set(setupSharedAtom, editorSaved(globalStore.get(setupSharedAtom), written, res));
        if (res.conflict) {
            await readDiskAfterConflict();
            return;
        }
        await RpcApi.AgentSyncApplyCommand(TabRpcClient, {});
        await load();
    });
}

// Projects the saved doc into every harness without a save: the way to bring a stale or unwritten
// harness up to date when there is nothing to edit.
export function syncNow(): Promise<void> {
    return busy(setupInstructionsErrorAtom, async () => {
        await RpcApi.AgentSyncApplyCommand(TabRpcClient, {});
        await load();
    });
}
