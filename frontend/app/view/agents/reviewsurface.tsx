// frontend/app/view/agents/reviewsurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Files "Review" mode: file-grouped staged Accept/Reject over a worktree's uncommitted changes,
// applied in a batch (rejected changes reverted). Ported from Wave-diff-review.dc.html; task
// grouping is v2. State + logic live in reviewstore.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useEffect } from "react";
import { MOTION, cardVariants } from "@/app/element/motiontokens";
import { useSettle } from "@/app/element/motionhooks";
import { parseUnifiedDiff } from "./gitdiff";
import {
    appliedAtom, applyReview, decide, decideMany, decisionsAtom, fileDecision, hunkKey, progressOf,
    resetReview, reviewModelAtom, reviewSelectedAtom, undoFile, undoKey, undoLast,
    type Decisions, type ReviewFile,
} from "./reviewstore";

function pendingKeysOf(files: ReviewFile[], d: Decisions): string[] {
    const out: string[] = [];
    for (const f of files) for (const h of f.hunks) { const k = hunkKey(f.path, h.id); if (!d[k]) out.push(k); }
    return out;
}

function moveSel(files: ReviewFile[], selected: string | null, dir: number) {
    const i = files.findIndex((f) => f.path === selected);
    const ni = Math.max(0, Math.min(files.length - 1, (i < 0 ? 0 : i) + dir));
    globalStore.set(reviewSelectedAtom, files[ni].path);
}

export function ReviewSurface() {
    const model = useAtomValue(reviewModelAtom);
    const d = useAtomValue(decisionsAtom);
    const selected = useAtomValue(reviewSelectedAtom);
    const applied = useAtomValue(appliedAtom);

    // keyboard triage: A accept / R reject next pending in selected file, U undo, arrows move file
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!model || applied) return;
            const k = e.key.toLowerCase();
            const sel = model.files.find((f) => f.path === selected) ?? model.files[0];
            const nextPending = sel?.hunks.map((h) => hunkKey(sel.path, h.id)).find((kk) => !d[kk]);
            if (k === "a" && nextPending) { e.preventDefault(); decide(nextPending, "accept"); }
            else if (k === "r" && nextPending) { e.preventDefault(); decide(nextPending, "reject"); }
            else if (k === "u") { e.preventDefault(); undoLast(); }
            else if (e.key === "ArrowDown" || k === "j") { e.preventDefault(); moveSel(model.files, selected, 1); }
            else if (e.key === "ArrowUp" || k === "k") { e.preventDefault(); moveSel(model.files, selected, -1); }
            else if (e.key === "Enter" && pendingKeysOf(model.files, d).length === 0) { e.preventDefault(); void applyReview(); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [model, d, selected, applied]);

    if (!model) return <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">Loading…</div>;
    if (model.files.length === 0) return <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">No changes to review</div>;

    const prog = progressOf(model.files, d);
    const done = prog.pending === 0;

    if (applied) {
        return (
            <motion.div
                variants={cardVariants}
                initial="initial"
                animate="animate"
                className="flex h-full flex-col items-center justify-center gap-[16px] p-[30px]"
            >
                <div className="text-[18px] font-bold text-foreground">Review applied</div>
                <div className="font-mono text-[13px] text-ink-mid">
                    Kept {applied.accepted} · discarded {applied.rejected}
                    {applied.failures.length > 0 && <span className="text-error"> · {applied.failures.length} failed</span>}
                </div>
                <button onClick={resetReview} className="rounded-[9px] border border-border px-[15px] py-[8px] text-[12px] text-ink-mid hover:text-foreground">
                    Reopen review
                </button>
            </motion.div>
        );
    }

    const sel = model.files.find((f) => f.path === selected) ?? model.files[0];

    // Single file list lives in the Diff sidebar (FilesSurface); this surface is just the
    // selected file's hunks + apply footer.
    return (
        <div className="flex h-full min-w-0 flex-1 flex-col bg-transparent">
            <FileHeader f={sel} d={d} />
            <motion.div
                key={sel.path}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                className="flex-1 overflow-auto p-[16px_20px_26px]"
            >
                {sel.hunks.map((h) => <HunkBlock key={h.id} f={sel} h={h} d={d} />)}
            </motion.div>
            <div className="flex flex-none items-center gap-[14px] border-t border-border bg-surface px-[22px] py-[12px]">
                <div className="flex items-center gap-[12px] font-mono text-[11px]">
                    <span className="text-ink-mid">{prog.reviewed}/{prog.total} reviewed</span>
                    <span className="text-success">{prog.accepted} keep</span>
                    <span className="text-error">{prog.rejected} discard</span>
                    <span className="text-ink-faint">{prog.pending} left</span>
                </div>
                <div className="flex-1" />
                {prog.reviewed > 0 && <button onClick={resetReview} className="text-ink-faint hover:text-ink-mid font-[600] text-[12px]">Reset</button>}
                {prog.pending > 0 && (
                    <button onClick={() => decideMany(pendingKeysOf(model.files, d), "accept")}
                        className="rounded-[9px] border border-border px-[15px] py-[9px] text-[12.5px] font-[600] text-ink-mid hover:text-foreground">
                        Accept all remaining
                    </button>
                )}
                <button onClick={() => void applyReview()} disabled={!done}
                    className={cn("flex items-center gap-[7px] rounded-[9px] px-[17px] py-[9px] text-[12.5px] font-bold",
                        done ? "bg-success text-black" : "cursor-not-allowed bg-surface text-ink-faint opacity-70")}>
                    {done ? `Apply review · keep ${prog.accepted}` : `${prog.pending} change${prog.pending === 1 ? "" : "s"} left to review`} →
                </button>
            </div>
        </div>
    );
}

function FileHeader({ f, d }: { f: ReviewFile; d: Decisions }) {
    const verdict = fileDecision(f, d);
    const fkeys = f.hunks.map((h) => hunkKey(f.path, h.id));
    const glyph = f.isNew ? "A" : "M";
    const settling = useSettle(verdict === "accept" || verdict === "reject");
    return (
        <div className={cn(
            "flex flex-none items-center gap-[10px] border-b border-border bg-surface px-[20px] py-[13px]",
            settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
        )}>
            <span className={cn("flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] font-mono text-[10px] font-bold",
                f.isNew ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>{glyph}</span>
            <span className="min-w-0 truncate font-mono text-[12.5px] font-semibold">{f.path}</span>
            <span className="flex-none font-mono text-[10px] font-bold text-success">+{f.adds}</span>
            <span className="flex-none font-mono text-[10px] font-bold text-error">−{f.dels}</span>
            <div className="flex-1" />
            {verdict === "accept" || verdict === "reject" ? (
                <>
                    <span className={cn("font-mono text-[11px] font-[600]", verdict === "accept" ? "text-success" : "text-error")}>
                        {verdict === "accept" ? "✓ File kept" : "✕ File discarded"}
                    </span>
                    <button onClick={() => undoFile(f)} className="text-ink-faint hover:text-ink-mid text-[11px] underline">Undo</button>
                </>
            ) : (
                <>
                    <button onClick={() => decideMany(fkeys, "reject")}
                        className="rounded-[7px] border border-border px-[10px] py-[4px] text-[11px] font-[600] text-ink-mid hover:border-error hover:text-error">Reject file</button>
                    <button onClick={() => decideMany(fkeys, "accept")}
                        className="rounded-[7px] border border-border px-[10px] py-[4px] text-[11px] font-[600] text-ink-mid hover:border-success hover:text-success">Accept file</button>
                </>
            )}
        </div>
    );
}

function HunkBlock({ f, h, d }: { f: ReviewFile; h: ReviewFile["hunks"][number]; d: Decisions }) {
    const key = hunkKey(f.path, h.id);
    const dec = d[key] ?? null;
    const rail = dec === "accept" ? "border-l-success" : dec === "reject" ? "border-l-error" : "border-l-transparent";
    const view = f.isNew ? null : parseUnifiedDiff(f.diffHeader + h.body);
    const settling = useSettle(dec !== null);
    return (
        <div
            className={cn(
                "mb-[10px] overflow-hidden rounded-[8px] border border-border border-l-2 transition-[border-color,opacity] duration-[140ms]",
                rail,
                settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
            )}
            style={{ opacity: dec === "reject" ? 0.5 : 1 }}
        >
            <div className="flex items-center gap-[10px] border-b border-edge-faint bg-surface px-[13px] py-[7px]">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">{h.header}</span>
                <span className="flex-none font-mono text-[10px] font-bold text-success">+{h.adds}</span>
                <span className="flex-none font-mono text-[10px] font-bold text-error">−{h.dels}</span>
                {dec === null ? (
                    <>
                        <button onClick={() => decide(key, "reject")} className="rounded-[6px] border border-border px-[9px] py-[3px] text-[10.5px] font-[600] text-ink-mid hover:border-error hover:text-error">Reject</button>
                        <button onClick={() => decide(key, "accept")} className="rounded-[6px] border border-border px-[9px] py-[3px] text-[10.5px] font-[600] text-ink-mid hover:border-success hover:text-success">Accept</button>
                    </>
                ) : (
                    <>
                        <span className={cn("font-mono text-[10px] font-bold", dec === "accept" ? "text-success" : "text-error")}>{dec === "accept" ? "✓ Keep" : "✕ Discard"}</span>
                        <button onClick={() => undoKey(key)} className="text-ink-faint hover:text-ink-mid text-[10.5px] underline">Undo</button>
                    </>
                )}
            </div>
            {view && (
                <div className="overflow-x-auto bg-surface-code py-[6px] font-mono text-[12px] leading-[1.7]">
                    {view.lines.filter((l) => l.kind !== "hunk").map((l, i) => (
                        <div key={i} className="flex min-w-max"
                            style={{ background: l.kind === "add" ? "color-mix(in srgb, var(--color-success) 10%, transparent)" : l.kind === "del" ? "color-mix(in srgb, var(--color-error) 10%, transparent)" : undefined }}>
                            <span className="w-[42px] flex-none select-none px-[8px] text-right text-ink-faint">{l.gOld}</span>
                            <span className="w-[42px] flex-none select-none px-[8px] text-right text-ink-faint">{l.gNew}</span>
                            <span className={cn("w-[16px] flex-none text-center", l.kind === "add" ? "text-success" : l.kind === "del" ? "text-error" : "text-foreground")}>{l.sign}</span>
                            <span className={cn("whitespace-pre pr-[28px]", l.kind === "add" ? "text-success" : l.kind === "del" ? "text-error" : "text-foreground")}>{l.text}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
