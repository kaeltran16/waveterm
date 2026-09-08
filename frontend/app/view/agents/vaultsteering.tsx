// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Vault's steering collection (Wave-vault-tab.dc.html): one canonical document you edit, and a
// read-only preview of what each harness's steering file currently holds. The direction is one-way —
// the vault writes into a delimited ARC-STEERING region and nothing is ever harvested back — so the
// projections are previews, never editors.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import {
    loadProjection,
    revertSteering,
    saveSteering,
    selectDocTab,
    vaultDirtyAtom,
    vaultDocTabAtom,
    vaultDraftAtom,
    vaultHarnessesAtom,
    vaultProjectionAtom,
    vaultSteeringPathAtom,
    vaultSyncBusyAtom,
} from "./vaultstore";

const STATE_TONE: Record<string, string> = {
    current: "text-success",
    stale: "text-warning",
    absent: "text-muted",
};

const STATE_LABEL: Record<string, string> = {
    current: "current",
    stale: "stale — sync to update",
    absent: "no region yet",
};

function DocTabs() {
    const tab = useAtomValue(vaultDocTabAtom);
    const harnesses = useAtomValue(vaultHarnessesAtom);
    const tabs = [
        { key: "canonical", label: "AGENTS.md" },
        ...harnesses.map((h) => ({ key: h.runtime, label: `→ ${h.label}` })),
    ];
    return (
        <div className="flex flex-none items-center gap-[8px] border-b border-edge-faint px-[24px] py-[10px]">
            {tabs.map((t) => (
                <button
                    key={t.key}
                    onClick={() => selectDocTab(t.key)}
                    data-vault-doc-tab={t.key}
                    className={cn(
                        "rounded-[8px] border px-[11px] py-[4px] font-mono text-[11.5px] font-medium",
                        tab === t.key
                            ? "border-accent/40 bg-accent/15 text-accent-soft"
                            : "border-border text-ink-mid hover:text-primary"
                    )}
                >
                    {t.label}
                </button>
            ))}
            <div className="flex-1" />
            <span className="font-mono text-[11px] text-ink-faint">
                {tab === "canonical"
                    ? "edits here reach every harness on the next sync"
                    : "generated region · read-only"}
            </span>
        </div>
    );
}

function CanonicalEditor() {
    const draft = useAtomValue(vaultDraftAtom);
    const dirty = useAtomValue(vaultDirtyAtom);
    const busy = useAtomValue(vaultSyncBusyAtom);
    const path = useAtomValue(vaultSteeringPathAtom);
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[10px] px-[24px] py-[10px]">
                <span className="truncate font-mono text-[13px] font-semibold text-primary">{path}</span>
                <span className="flex-none font-mono text-[10.5px] text-ink-faint">
                    canonical · projected into every harness
                </span>
                <div className="flex-1" />
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
            <textarea
                value={draft}
                spellCheck={false}
                // a vault that has never synced opens on an empty box; say what it is for rather than
                // leaving a blank pane that reads as a failed load
                placeholder={
                    "The rules every harness should follow. Saving writes them into each installed " +
                    "harness's steering file, inside a managed region — whatever you wrote there yourself " +
                    "is left alone."
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

function ProjectionPreview() {
    const proj = useAtomValue(vaultProjectionAtom);
    const tab = useAtomValue(vaultDocTabAtom);
    // re-read on entry so a harness edited outside Arc does not show a cached region
    useEffect(() => {
        fireAndForget(() => loadProjection(tab));
    }, [tab]);
    if (!proj) {
        return <div className="px-[24px] py-[16px] text-[12.5px] text-ink-faint">Reading…</div>;
    }
    const state = proj.present ? proj.state : "absent";
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            <div className="flex flex-none items-center gap-[10px] px-[24px] py-[10px]">
                <span className="truncate font-mono text-[13px] font-semibold text-primary">{proj.path}</span>
                <span className={cn("flex-none font-mono text-[10.5px]", STATE_TONE[state] ?? "text-muted")}>
                    {proj.present ? (STATE_LABEL[state] ?? state) : "harness not installed"}
                </span>
                <div className="flex-1" />
                <span className="flex-none font-mono text-[10.5px] text-ink-faint">
                    read-only · yours outside the markers
                </span>
            </div>
            <div className="mx-[24px] mb-[20px] rounded-[9px] border border-border bg-surface px-[16px] py-[14px] font-mono text-[12px] leading-[1.8] text-ink-mid">
                <div className="text-ink-faint">
                    &lt;!-- ARC-STEERING:BEGIN (generated — do not edit; managed by Arc) --&gt;
                </div>
                <div className="whitespace-pre-wrap text-ink-hi">{proj.body || "(nothing projected here yet)"}</div>
                <div className="text-ink-faint">&lt;!-- ARC-STEERING:END --&gt;</div>
            </div>
        </div>
    );
}

export function VaultSteering() {
    const tab = useAtomValue(vaultDocTabAtom);
    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <DocTabs />
            {tab === "canonical" ? <CanonicalEditor /> : <ProjectionPreview />}
        </div>
    );
}
