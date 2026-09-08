// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Full-width reader for one long note (Wave-vault-tab.dc.html). Serves both halves of the memory
// tab: a candidate from the review queue (Keep/Dismiss in the footer) and a saved note (Edit/Ask
// Jarvis). It overlays the panes rather than replacing the rail, so Escape returns to exactly the
// row the reader was opened from.

import { MOTION } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { AskJarvisButton, sourceRefForMemory } from "@/app/view/jarvis/contextualentry";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import type { AgentsViewModel } from "./agents";
import { MarkdownMessage } from "./markdownmessage";
import {
    dismissPending,
    keepPending,
    memBodyAtom,
    memDraftAtom,
    memEditingAtom,
    memNotesAtom,
    memPendingAtom,
    memRailOpenAtom,
} from "./memstore";
import { relativeAge } from "./memtypes";
import { noteTally, vaultReaderAtom, vaultStatusAtom, type VaultReader as ReaderTarget } from "./vaultstore";
import { readingTime, scopeLabel } from "./vaulttriage";

function closeReader(): void {
    globalStore.set(vaultReaderAtom, null);
}

function Chrome({
    label,
    labelClass,
    meta,
    backLabel,
    body,
    footer,
}: {
    label: string;
    labelClass: string;
    meta: string;
    backLabel: string;
    body: string;
    footer: React.ReactNode;
}) {
    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.99 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } }}
            exit={{ opacity: 0, scale: 0.99, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } }}
            className="absolute inset-0 z-10 flex flex-col bg-background"
        >
            <div className="flex flex-none items-center gap-[10px] border-b border-edge-faint px-[24px] py-[11px]">
                <span className={cn("font-mono text-[10px] font-semibold uppercase tracking-[0.1em]", labelClass)}>
                    {label}
                </span>
                <span className="truncate font-mono text-[11px] text-ink-faint">{meta}</span>
                <div className="flex-1" />
                <button
                    onClick={closeReader}
                    className="flex items-center gap-[6px] rounded-[7px] border border-edge-mid px-[12px] py-[4px] text-[11px] font-semibold text-ink-mid hover:text-primary"
                >
                    {backLabel}
                    <span className="font-mono text-[10px] text-ink-faint">esc</span>
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-[32px] py-[24px]">
                <div className="max-w-[74ch] text-[14.5px] leading-[1.7] text-ink-hi">
                    <MarkdownMessage text={body} />
                </div>
            </div>
            <div className="flex flex-none items-center gap-[9px] border-t border-edge-faint px-[24px] py-[12px]">
                {footer}
                <div className="flex-1" />
                <span className="font-mono text-[11px] text-ink-faint">{readingTime(body)}</span>
            </div>
        </motion.div>
    );
}

export function VaultReader({ model, reader }: { model: AgentsViewModel; reader: NonNullable<ReaderTarget> }) {
    const pending = useAtomValue(memPendingAtom);
    const notes = useAtomValue(memNotesAtom);
    const body = useAtomValue(memBodyAtom);

    if (reader.kind === "pending") {
        const p = pending.find((c) => c.path === reader.path);
        if (!p) return null;
        const resolve = (keep: boolean) => {
            closeReader();
            noteTally(keep);
            globalStore.set(vaultStatusAtom, keep ? `Kept ${p.title}` : `Dismissed ${p.title}`);
            fireAndForget(() => (keep ? keepPending(p.path) : dismissPending(p.path)));
        };
        return (
            <Chrome
                label="Reviewing"
                labelClass="text-asking"
                meta={`${scopeLabel(p.scope)} · ${p.source} · ${relativeAge(p.capturedat) || "just now"}`}
                backLabel="Back to queue"
                body={p.body}
                footer={
                    <>
                        <button
                            onClick={() => resolve(true)}
                            className="rounded-[7px] bg-accent px-[22px] py-[8px] text-[12.5px] font-semibold text-background hover:bg-accenthover"
                        >
                            Keep <span className="font-mono text-[10px] opacity-75">↵</span>
                        </button>
                        <button
                            onClick={() => resolve(false)}
                            className="rounded-[7px] border border-edge-mid px-[18px] py-[8px] text-[12.5px] font-semibold text-ink-mid hover:text-primary"
                        >
                            Dismiss <span className="font-mono text-[10px] opacity-75">x</span>
                        </button>
                    </>
                }
            />
        );
    }

    const note = notes.find((n) => n.id === reader.id);
    if (!note) return null;
    const startEdit = () => {
        // editing lives in the rail; the reader hands the note over rather than growing an editor
        globalStore.set(memDraftAtom, body?.body ?? "");
        globalStore.set(memEditingAtom, true);
        globalStore.set(memRailOpenAtom, true);
        closeReader();
    };
    return (
        <Chrome
            label="Reading"
            labelClass="text-accent-soft"
            meta={`${note.type || "note"} · ${scopeLabel(note.scope)}`}
            backLabel="Back to Saved"
            body={body?.body || note.description}
            footer={
                <>
                    <button
                        onClick={startEdit}
                        className="rounded-[7px] border border-accent/40 bg-accent/15 px-[20px] py-[8px] text-[12.5px] font-semibold text-accent-soft hover:bg-accentbg"
                    >
                        Edit
                    </button>
                    <AskJarvisButton model={model} sourceRef={sourceRefForMemory(note)} label="Ask Jarvis" />
                </>
            }
        />
    );
}
