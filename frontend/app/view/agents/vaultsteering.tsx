// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Vault's steering collection: one shared document that every harness gets, and one tab per
// harness showing that harness's real file. A harness file is three zones — the rules it holds of
// its own, the shared block Arc writes into it, and the memory projection — and only the first is
// editable here. The delimited region that separates them is the mechanism and never appears on
// screen; what the user sees is their file.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import {
    foldIntoShared,
    loadHarnessDoc,
    revertSteering,
    saveHarnessOwn,
    saveSteering,
    selectDocTab,
    SHARED_TAB,
    vaultDirtyAtom,
    vaultDocTabAtom,
    vaultDraftAtom,
    vaultHarnessDocAtom,
    vaultHarnessesAtom,
    vaultMemoryOpenAtom,
    vaultOwnDirtyAtom,
    vaultOwnDraftAtom,
    vaultSteeringPathAtom,
    vaultSyncBusyAtom,
} from "./vaultstore";

const STATE_TONE: Record<string, string> = {
    current: "text-success",
    stale: "text-warning",
    absent: "text-muted",
};

const STATE_LABEL: Record<string, string> = {
    current: "in sync with the shared doc",
    stale: "shared doc has changed — sync to update",
    absent: "shared doc not written here yet",
};

const ZONE_HEAD = "font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-feed-label";

function DocTabs() {
    const tab = useAtomValue(vaultDocTabAtom);
    const harnesses = useAtomValue(vaultHarnessesAtom);
    return (
        <div className="flex flex-none items-center gap-[8px] border-b border-edge-faint px-[24px] py-[10px]">
            <button
                onClick={() => selectDocTab(SHARED_TAB)}
                data-vault-doc-tab={SHARED_TAB}
                className={cn(
                    "rounded-[8px] border px-[11px] py-[4px] font-mono text-[11.5px] font-medium",
                    tab === SHARED_TAB
                        ? "border-accent/40 bg-accent/15 text-accent-soft"
                        : "border-border text-ink-mid hover:text-primary"
                )}
            >
                Shared
            </button>
            <span className="mx-[2px] h-[14px] w-px bg-edge-mid" />
            {harnesses.map((h) => (
                <button
                    key={h.runtime}
                    onClick={() => selectDocTab(h.runtime)}
                    data-vault-doc-tab={h.runtime}
                    disabled={!h.present}
                    title={h.present ? undefined : `${h.label} has never run here`}
                    className={cn(
                        "flex items-center gap-[6px] rounded-[8px] border px-[11px] py-[4px] font-mono text-[11.5px] font-medium",
                        tab === h.runtime
                            ? "border-accent/40 bg-accent/15 text-accent-soft"
                            : "border-border text-ink-mid hover:text-primary",
                        !h.present && "opacity-40"
                    )}
                >
                    {h.label}
                    {/* a harness still holding rules of its own is the only thing left to do here */}
                    {h.present && h.own && <span className="h-[5px] w-[5px] rounded-full bg-warning" />}
                </button>
            ))}
            <div className="flex-1" />
            <span className="font-mono text-[11px] text-ink-faint">
                {tab === SHARED_TAB ? "saved here, written into every installed harness" : "this harness's own file"}
            </span>
        </div>
    );
}

function SharedEditor() {
    const draft = useAtomValue(vaultDraftAtom);
    const dirty = useAtomValue(vaultDirtyAtom);
    const busy = useAtomValue(vaultSyncBusyAtom);
    const path = useAtomValue(vaultSteeringPathAtom);
    const harnesses = useAtomValue(vaultHarnessesAtom);
    const withOwn = harnesses.filter((h) => h.present && h.own);
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[10px] px-[24px] py-[10px]">
                <span className="truncate font-mono text-[13px] font-semibold text-primary">
                    The instructions every harness gets
                </span>
                <span title={path} className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint">
                    {path}
                </span>
                {dirty ? (
                    <>
                        <button
                            onClick={revertSteering}
                            className="rounded-[7px] border border-edge-mid px-[12px] py-[5px] text-[11.5px] font-semibold text-ink-mid hover:text-primary"
                        >
                            Revert
                        </button>
                        <button
                            onClick={() => fireAndForget(saveSteering)}
                            disabled={busy}
                            className="rounded-[7px] bg-accent px-[14px] py-[5px] text-[11.5px] font-semibold text-background hover:bg-accenthover disabled:opacity-40"
                        >
                            {busy ? "Saving…" : "Save and sync"}
                        </button>
                    </>
                ) : (
                    <span className="font-mono text-[10.5px] text-muted">saved</span>
                )}
            </div>
            {/* the migration lives here rather than behind a wizard: whatever a harness still holds
                of its own is one click from becoming shared, and the result lands in this editor */}
            {withOwn.length > 0 && (
                <div className="mx-[24px] mb-[10px] flex items-center gap-[10px] rounded-[9px] border border-warning/30 bg-warning/10 px-[13px] py-[9px]">
                    <span className="min-w-0 flex-1 text-[11.5px] leading-[1.5] text-ink-mid">
                        {withOwn.map((h) => h.label).join(", ")} still{" "}
                        {withOwn.length === 1 ? "holds rules" : "hold rules"} of their own. Moving them here makes them
                        apply everywhere.
                    </span>
                    {withOwn.map((h) => (
                        <button
                            key={h.runtime}
                            onClick={() => fireAndForget(() => foldIntoShared(h.runtime))}
                            disabled={busy}
                            data-vault-fold={h.runtime}
                            className="flex-none rounded-[6px] border border-warning/40 px-[10px] py-[4px] font-mono text-[10.5px] font-semibold text-warning hover:bg-warning/15 disabled:opacity-40"
                        >
                            Move {h.label}
                        </button>
                    ))}
                </div>
            )}
            <textarea
                value={draft}
                spellCheck={false}
                placeholder={
                    "The instructions every harness should follow. Saving writes them into each " +
                    "installed harness's file, leaving whatever that harness holds of its own alone."
                }
                onChange={(e) => {
                    globalStore.set(vaultDraftAtom, e.target.value);
                    globalStore.set(vaultDirtyAtom, true);
                }}
                className="min-h-0 flex-1 resize-none border-0 border-t border-edge-faint bg-surface px-[24px] py-[16px] font-mono text-[12.5px] leading-[1.75] text-secondary outline-none placeholder:text-muted"
            />
        </div>
    );
}

function HarnessFile() {
    const doc = useAtomValue(vaultHarnessDocAtom);
    const tab = useAtomValue(vaultDocTabAtom);
    const draft = useAtomValue(vaultOwnDraftAtom);
    const dirty = useAtomValue(vaultOwnDirtyAtom);
    const busy = useAtomValue(vaultSyncBusyAtom);
    const memoryOpen = useAtomValue(vaultMemoryOpenAtom);

    // re-read on entry so a file edited outside Arc does not show stale
    useEffect(() => {
        fireAndForget(() => loadHarnessDoc(tab));
    }, [tab]);

    if (!doc) {
        return <div className="px-[24px] py-[16px] text-[12.5px] text-ink-faint">Reading…</div>;
    }
    if (!doc.present) {
        return (
            <div className="px-[24px] py-[16px] text-[12.5px] text-ink-faint">
                This harness has never run here, so it has no config directory. Arc never creates one.
            </div>
        );
    }
    const memoryLines = doc.memory ? doc.memory.split("\n").length : 0;
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            <div className="flex flex-none items-center gap-[10px] px-[24px] py-[10px]">
                <span className="truncate font-mono text-[13px] font-semibold text-primary">{doc.path}</span>
                <span className={cn("flex-none font-mono text-[10.5px]", STATE_TONE[doc.state] ?? "text-muted")}>
                    {STATE_LABEL[doc.state] ?? doc.state}
                </span>
                <div className="flex-1" />
                {dirty ? (
                    <>
                        <button
                            onClick={() => {
                                globalStore.set(vaultOwnDraftAtom, doc.own ?? "");
                                globalStore.set(vaultOwnDirtyAtom, false);
                            }}
                            className="rounded-[7px] border border-edge-mid px-[12px] py-[5px] text-[11.5px] font-semibold text-ink-mid hover:text-primary"
                        >
                            Revert
                        </button>
                        <button
                            onClick={() => fireAndForget(saveHarnessOwn)}
                            disabled={busy}
                            className="rounded-[7px] bg-accent px-[14px] py-[5px] text-[11.5px] font-semibold text-background hover:bg-accenthover disabled:opacity-40"
                        >
                            {busy ? "Saving…" : "Save to this file"}
                        </button>
                    </>
                ) : (
                    <span className="font-mono text-[10.5px] text-muted">saved</span>
                )}
            </div>

            <div className="flex flex-none items-center gap-[10px] border-t border-edge-faint px-[24px] pt-[12px]">
                <span className={ZONE_HEAD}>Only this harness</span>
                <div className="flex-1" />
                {doc.carried > 0 && (
                    <button
                        onClick={() => fireAndForget(() => foldIntoShared(doc.runtime))}
                        disabled={busy || dirty}
                        title={dirty ? "Save or revert this edit first" : undefined}
                        data-vault-fold={doc.runtime}
                        className="rounded-[6px] border border-warning/40 px-[10px] py-[4px] font-mono text-[10.5px] font-semibold text-warning hover:bg-warning/15 disabled:opacity-40"
                    >
                        Move {doc.carried} line{doc.carried === 1 ? "" : "s"} into Shared
                    </button>
                )}
            </div>
            <textarea
                value={draft}
                spellCheck={false}
                placeholder="Rules only this harness should follow. Everything shared belongs in the Shared tab."
                onChange={(e) => {
                    globalStore.set(vaultOwnDraftAtom, e.target.value);
                    globalStore.set(vaultOwnDirtyAtom, true);
                }}
                className="mx-[24px] mt-[8px] min-h-[180px] flex-none resize-y rounded-[9px] border border-border bg-surface px-[16px] py-[12px] font-mono text-[12.5px] leading-[1.75] text-secondary outline-none placeholder:text-muted"
            />

            <div className="flex flex-none items-center gap-[10px] px-[24px] pt-[18px]">
                <span className={ZONE_HEAD}>Shared with every harness</span>
                <button
                    onClick={() => selectDocTab(SHARED_TAB)}
                    className="font-mono text-[10.5px] font-semibold text-accent-soft hover:text-accenthover"
                >
                    Edit in Shared ↗
                </button>
            </div>
            <div className="mx-[24px] mt-[8px] flex-none whitespace-pre-wrap rounded-[9px] border border-dashed border-edge-mid bg-background px-[16px] py-[12px] font-mono text-[12px] leading-[1.75] text-ink-faint">
                {doc.shared || "Nothing shared here yet — save the Shared tab to write it into this file."}
            </div>

            {memoryLines > 0 && (
                <>
                    <button
                        onClick={() => globalStore.set(vaultMemoryOpenAtom, !memoryOpen)}
                        className="mx-[24px] mt-[18px] mb-[20px] flex flex-none items-center gap-[9px] rounded-[9px] border border-edge-faint bg-background px-[13px] py-[9px] text-left hover:border-edge-strong"
                    >
                        <span className="font-mono text-[10.5px] text-ink-faint">{memoryOpen ? "▾" : "▸"}</span>
                        <span className="text-[11.5px] text-ink-mid">
                            {memoryLines} more lines of project memory, written by the memory projection
                        </span>
                        <div className="flex-1" />
                        <span className="font-mono text-[10px] text-ink-faint">generated · read-only</span>
                    </button>
                    {memoryOpen && (
                        <div className="mx-[24px] mb-[20px] max-h-[420px] flex-none overflow-auto whitespace-pre-wrap rounded-[9px] border border-edge-faint bg-background px-[16px] py-[12px] font-mono text-[11.5px] leading-[1.7] text-ink-faint">
                            {doc.memory}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export function VaultSteering() {
    const tab = useAtomValue(vaultDocTabAtom);
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <DocTabs />
            {tab === SHARED_TAB ? <SharedEditor /> : <HarnessFile />}
        </div>
    );
}
