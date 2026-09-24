// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Setup surface state and its agentsync loaders. Module-level atoms because every surface but Agent
// unmounts on a switch: the shared-doc draft must survive one, and the rest is cheap to keep.

import { openFileInCode } from "@/app/cockpit/openfilestore";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentsViewModel } from "./agents";
import {
    editorDiscard,
    editorLoaded,
    editorReload,
    editorSaved,
    editorTyped,
    EMPTY_EDITOR,
    saveBaseMtime,
    SHARED,
    type DocEditor,
    type SetupSelection,
} from "./setupmodel";
import { adoptKeep, type SkillKeep } from "./skillsmatrix";

export type SetupTab = "instructions" | "skills";

// local filesystem reads behind an rpc with no default timeout: a stalled backend must reject rather
// than leave the pane on "Reading…" forever
const READ_TIMEOUT_MS = 5000;

export const setupTabAtom = atom<SetupTab>("instructions") as PrimitiveAtom<SetupTab>;
export const setupSelectionAtom = atom<SetupSelection>(SHARED) as PrimitiveAtom<SetupSelection>;
export const setupStatusAtom = atom<CommandAgentSyncStatusRtnData | null>(
    null
) as PrimitiveAtom<CommandAgentSyncStatusRtnData | null>;
export const setupDocsAtom = atom<Record<string, CommandAgentSyncHarnessReadRtnData>>({}) as PrimitiveAtom<
    Record<string, CommandAgentSyncHarnessReadRtnData>
>;
export const setupSharedPathAtom = atom<string>("") as PrimitiveAtom<string>;
export const setupSharedAtom = atom<DocEditor>(EMPTY_EDITOR) as PrimitiveAtom<DocEditor>;
// the selected harness's own zone; switching harness starts it over from disk
export const setupOwnAtom = atom<{ runtime: string; editor: DocEditor } | null>(null) as PrimitiveAtom<{
    runtime: string;
    editor: DocEditor;
} | null>;
// "start with an empty page" on first run: open the editor on an empty doc instead of the offer
export const setupFreshStartAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const setupSkillsAtom = atom<CommandAgentSyncSkillsRtnData | null>(
    null
) as PrimitiveAtom<CommandAgentSyncSkillsRtnData | null>;
export const setupSkillKeepAtom = atom<SkillKeep>({}) as PrimitiveAtom<SkillKeep>;
export const setupSkillSelectedAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
export const setupBusyAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const setupErrorAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

async function busy(fn: () => Promise<void>): Promise<void> {
    globalStore.set(setupBusyAtom, true);
    globalStore.set(setupErrorAtom, null);
    try {
        await fn();
    } catch (e) {
        globalStore.set(setupErrorAtom, errText(e));
    } finally {
        globalStore.set(setupBusyAtom, false);
    }
}

function syncOwnEditor(docs: Record<string, CommandAgentSyncHarnessReadRtnData>): void {
    const own = globalStore.get(setupOwnAtom);
    const doc = own != null ? docs[own.runtime] : undefined;
    if (own != null && doc != null) {
        globalStore.set(setupOwnAtom, {
            runtime: own.runtime,
            editor: editorLoaded(own.editor, doc.own ?? "", doc.mtime ?? 0),
        });
    }
}

// Status gives the rows and their order; each harness's file read gives the state table's inputs.
async function load(): Promise<void> {
    const [status, steering] = await Promise.all([
        RpcApi.AgentSyncStatusCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS }),
        RpcApi.AgentSyncSteeringReadCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS }),
    ]);
    const reads = await Promise.all(
        (status.harnesses ?? []).map((h) =>
            RpcApi.AgentSyncHarnessReadCommand(TabRpcClient, { runtime: h.runtime }, { timeout: READ_TIMEOUT_MS })
        )
    );
    const docs: Record<string, CommandAgentSyncHarnessReadRtnData> = {};
    for (const r of reads) {
        docs[r.runtime] = r;
    }
    globalStore.set(setupStatusAtom, status);
    globalStore.set(setupDocsAtom, docs);
    globalStore.set(setupSharedPathAtom, steering.path ?? status.steeringdoc ?? "");
    globalStore.set(
        setupSharedAtom,
        editorLoaded(globalStore.get(setupSharedAtom), steering.content ?? "", steering.mtime ?? 0)
    );
    syncOwnEditor(docs);
}

export async function loadSetup(): Promise<void> {
    try {
        await load();
    } catch (e) {
        globalStore.set(setupErrorAtom, errText(e));
    }
}

export function selectShared(): void {
    globalStore.set(setupSelectionAtom, SHARED);
}

export function selectHarness(runtime: string): void {
    globalStore.set(setupSelectionAtom, runtime);
    const doc = globalStore.get(setupDocsAtom)[runtime];
    globalStore.set(setupOwnAtom, { runtime, editor: editorReload(doc?.own ?? "", doc?.mtime ?? 0) });
}

export function startEmptyPage(): void {
    globalStore.set(setupFreshStartAtom, true);
    selectShared();
}

// ---- shared doc ----

export function typeShared(draft: string): void {
    globalStore.set(setupSharedAtom, editorTyped(globalStore.get(setupSharedAtom), draft));
}

export function discardShared(): void {
    globalStore.set(setupSharedAtom, editorDiscard(globalStore.get(setupSharedAtom)));
}

export function reloadShared(): Promise<void> {
    return busy(async () => {
        const r = await RpcApi.AgentSyncSteeringReadCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS });
        globalStore.set(setupSharedAtom, editorReload(r.content ?? "", r.mtime ?? 0));
    });
}

// Write, then project at once: a doc the harnesses have not received is the stale state this exists to
// remove. A conflict stops before the apply and leaves the draft for Reload or Overwrite.
export function saveShared(overwrite: boolean): Promise<void> {
    return busy(async () => {
        const ed = globalStore.get(setupSharedAtom);
        const written = ed.draft;
        const res = await RpcApi.AgentSyncSteeringWriteCommand(TabRpcClient, {
            content: written,
            basemtime: saveBaseMtime(ed, overwrite),
        });
        globalStore.set(setupSharedAtom, editorSaved(globalStore.get(setupSharedAtom), written, res));
        if (res.conflict) {
            return;
        }
        await RpcApi.AgentSyncApplyCommand(TabRpcClient, {});
        await load();
    });
}

// ---- one harness ----

export function typeOwn(draft: string): void {
    const own = globalStore.get(setupOwnAtom);
    if (own != null) {
        globalStore.set(setupOwnAtom, { runtime: own.runtime, editor: editorTyped(own.editor, draft) });
    }
}

export function discardOwn(): void {
    const own = globalStore.get(setupOwnAtom);
    if (own != null) {
        globalStore.set(setupOwnAtom, { runtime: own.runtime, editor: editorDiscard(own.editor) });
    }
}

export function reloadOwn(): Promise<void> {
    return busy(async () => {
        const own = globalStore.get(setupOwnAtom);
        if (own == null) {
            return;
        }
        const r = await RpcApi.AgentSyncHarnessReadCommand(
            TabRpcClient,
            { runtime: own.runtime },
            { timeout: READ_TIMEOUT_MS }
        );
        globalStore.set(setupDocsAtom, { ...globalStore.get(setupDocsAtom), [r.runtime]: r });
        globalStore.set(setupOwnAtom, { runtime: own.runtime, editor: editorReload(r.own ?? "", r.mtime ?? 0) });
    });
}

export function saveOwn(overwrite: boolean): Promise<void> {
    return busy(async () => {
        const own = globalStore.get(setupOwnAtom);
        if (own == null) {
            return;
        }
        const written = own.editor.draft;
        const res = await RpcApi.AgentSyncHarnessWriteCommand(TabRpcClient, {
            runtime: own.runtime,
            own: written,
            basemtime: saveBaseMtime(own.editor, overwrite),
        });
        const cur = globalStore.get(setupOwnAtom);
        if (cur?.runtime === own.runtime) {
            globalStore.set(setupOwnAtom, { runtime: own.runtime, editor: editorSaved(cur.editor, written, res) });
        }
        if (!res.conflict) {
            await load();
        }
    });
}

// Moves a harness's own rules into the shared doc; into an empty doc it seeds it verbatim. The backend
// projects before it clears the source, so no rule leaves the file it was serving.
export function foldIntoShared(runtime: string, thenEdit: boolean): Promise<void> {
    return busy(async () => {
        await RpcApi.AgentSyncFoldCommand(TabRpcClient, { runtime });
        await load();
        if (thenEdit) {
            selectShared();
        }
    });
}

export function dropMemory(runtime: string): Promise<void> {
    return busy(async () => {
        const doc = globalStore.get(setupDocsAtom)[runtime];
        const res = await RpcApi.AgentSyncHarnessDropMemoryCommand(TabRpcClient, {
            runtime,
            basemtime: doc?.mtime ?? 0,
        });
        await load();
        if (res.conflict) {
            globalStore.set(
                setupErrorAtom,
                `${doc?.path ?? runtime} changed on disk since you opened it, so nothing was removed. It is reloaded; check it and remove again.`
            );
        }
    });
}

// ---- skills ----

export async function loadSkills(): Promise<void> {
    try {
        globalStore.set(
            setupSkillsAtom,
            await RpcApi.AgentSyncSkillsCommand(TabRpcClient, { timeout: READ_TIMEOUT_MS })
        );
        // a read that failed on an earlier visit must not leave its banner over fresh data
        globalStore.set(setupErrorAtom, null);
    } catch (e) {
        globalStore.set(setupErrorAtom, errText(e));
    }
}

export function selectSkill(name: string): void {
    globalStore.set(setupSkillSelectedAtom, name);
}

export function setSkillKeep(name: string, runtime: string | null): void {
    const { [name]: _, ...rest } = globalStore.get(setupSkillKeepAtom);
    globalStore.set(setupSkillKeepAtom, runtime == null ? rest : { ...rest, [name]: runtime });
}

// Moves every adoptable skill into the vault; an undecided one without a keep stays where it is.
export function adoptSkills(): Promise<void> {
    return busy(async () => {
        const data = globalStore.get(setupSkillsAtom);
        if (data == null) {
            return;
        }
        const keep = adoptKeep(data, globalStore.get(setupSkillKeepAtom));
        // a failed adopt may have moved some skills already, so the matrix is re-read either way
        try {
            await RpcApi.AgentSyncAdoptCommand(TabRpcClient, { apply: true, keep });
            globalStore.set(setupSkillKeepAtom, {});
        } finally {
            await loadSkills();
        }
    });
}

export function openSkillFile(model: AgentsViewModel, path: string): Promise<void> {
    return busy(() => openFileInCode(model, path));
}
