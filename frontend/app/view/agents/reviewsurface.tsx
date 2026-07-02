// frontend/app/view/agents/reviewsurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Files "Review" mode: file-grouped staged Accept/Reject over a worktree's uncommitted changes,
// applied in a batch (rejected changes reverted). Ported from Wave-diff-review.dc.html; task
// grouping is v2. State + logic live in reviewstore.ts.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
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
    const acceptPct = prog.total ? (prog.accepted / prog.total) * 100 : 0;
    const rejectPct = prog.total ? (prog.rejected / prog.total) * 100 : 0;
    const done = prog.pending === 0;

    if (applied) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-[16px] p-[30px]">
                <div className="text-[18px] font-bold text-foreground">Review applied</div>
                <div className="font-mono text-[13px] text-ink-mid">
                    Kept {applied.accepted} · discarded {applied.rejected}
                    {applied.failures.length > 0 && <span className="text-error"> · {applied.failures.length} failed</span>}
                </div>
                <button onClick={resetReview} className="rounded-[9px] border border-border px-[15px] py-[8px] text-[12px] text-ink-mid hover:text-foreground">
                    Reopen review
                </button>
            </div>
        );
    }

    const sel = model.files.find((f) => f.path === selected) ?? model.files[0];

    return (
        <div className="flex h-full min-h-0">
            {/* left: file list with per-file review progress */}
            <div className="flex w-[300px] flex-none flex-col border-r border-border bg-surface">
                <div className="flex-none border-b border-edge-faint p-[13px]">
                    <div className="mb-[8px] flex items-baseline justify-between font-mono text-[11px]">
                        <span className="text-ink-faint">{model.files.length} files</span>
                        <span className="text-ink-mid">{prog.reviewed}/{prog.total} reviewed</span>
                    </div>
                    <div className="flex h-[6px] overflow-hidden rounded-[4px] bg-surface-hover">
                        <div className="h-full bg-success" style={{ width: `${acceptPct}%` }} />
                        <div className="h-full bg-error" style={{ width: `${rejectPct}%` }} />
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-[8px]">
                    {model.files.map((f) => {
                        const verdict = fileDecision(f, d);
                        const dec = f.hunks.filter((h) => d[hunkKey(f.path, h.id)]).length;
                        const ring = verdict === "accept" ? "text-success" : verdict === "reject" ? "text-error" : verdict === "partial" ? "text-warning" : "text-ink-faint";
                        return (
                            <button key={f.path} onClick={() => globalStore.set(reviewSelectedAtom, f.path)}
                                className={cn("flex w-full items-center gap-[8px] rounded-[8px] px-[9px] py-[7px] text-left hover:bg-surface-hover",
                                    f.path === sel.path && "bg-surface-hover")}>
                                <span className={cn("font-mono text-[11px]", ring)}>●</span>
                                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-mid">{f.path}</span>
                                <span className="flex-none font-mono text-[10px] text-ink-faint">{dec}/{f.hunks.length}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* right: selected file's hunks + footer */}
            <div className="flex min-w-0 flex-1 flex-col bg-transparent">
                <FileHeader f={sel} d={d} />
                <div className="flex-1 overflow-auto p-[16px_20px_26px]">
                    {sel.hunks.map((h) => <HunkBlock key={h.id} f={sel} h={h} d={d} />)}
                </div>
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
        </div>
    );
}

function FileHeader({ f, d }: { f: ReviewFile; d: Decisions }) {
    const verdict = fileDecision(f, d);
    const fkeys = f.hunks.map((h) => hunkKey(f.path, h.id));
    const glyph = f.isNew ? "A" : "M";
    return (
        <div className="flex flex-none items-center gap-[10px] border-b border-border bg-surface px-[20px] py-[13px]">
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
    return (
        <div className={cn("mb-[10px] overflow-hidden rounded-[8px] border border-border border-l-2", rail)} style={{ opacity: dec === "reject" ? 0.5 : 1 }}>
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
                <div className="overflow-x-auto py-[6px] font-mono text-[12px] leading-[1.7]">
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
