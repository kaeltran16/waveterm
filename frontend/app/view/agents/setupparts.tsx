// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Parts the Setup surface's Instructions and Skills tabs both draw: marks, button and tone classes, the
// error banner, the failed-first-read state, and a read-only file preview.

import { composerReveal, MOTION } from "@/app/element/motiontokens";
import { PaneReveal } from "@/app/element/panereveal";
import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { RuntimeMark } from "./runtimemark";
import { runtimeMeta } from "./runtimemeta";
import type { Tone } from "./setupmodel";
import { useFileText } from "./usefiletext";

export const SECTION_HEAD = cn(REGION_LABEL, "text-muted");
export const BTN_SECONDARY =
    "h-[30px] cursor-pointer rounded border border-edge-mid bg-surface-raised px-3 text-[12.5px] font-semibold text-ink-mid hover:border-edge-strong hover:bg-surface-hover hover:text-primary disabled:cursor-default disabled:text-ink-faint disabled:hover:border-edge-mid disabled:hover:bg-surface-raised";
export const BTN_PRIMARY =
    "h-8 cursor-pointer rounded border-0 bg-accent px-[14px] text-[13px] font-bold text-background shadow-inset-highlight hover:bg-accenthover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-accent";

export const TONE_DOT: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", none: "bg-ink-faint" };
export const TONE_TEXT: Record<Tone, string> = { ok: "text-ink-mid", warn: "text-warning-soft", none: "text-muted" };

// a swapped tab or skill fades in rather than cutting; the outgoing one leaves at once, so a quick run of
// arrow keys through the skill list never queues exits
export const FADE_IN = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: MOTION.durMicro, ease: MOTION.easeFluid },
};

export function Dot({ tone, size = 6 }: { tone: Tone; size?: 6 | 7 }) {
    return (
        <span
            className={cn("flex-none rounded-full", TONE_DOT[tone], size === 7 ? "h-[7px] w-[7px]" : "h-1.5 w-1.5")}
        />
    );
}

export function HarnessMark({ runtime }: { runtime: string }) {
    const meta = runtimeMeta(runtime);
    return (
        <span
            className={cn(
                "flex flex-none items-center justify-center rounded-[5px] border font-mono text-[10.5px] font-bold",
                meta.line,
                meta.text,
                "h-5 w-5"
            )}
        >
            <RuntimeMark runtime={runtime} imageClassName="h-3 w-3" />
        </span>
    );
}

export function ErrorBanner({ error }: { error: string | null }) {
    return (
        <PaneReveal open={!!error} variants={composerReveal} className="flex-none">
            <div role="alert" className="border-b border-error/30 bg-error/10 px-5 py-2 text-[12.5px] text-error-soft">
                {error}
            </div>
        </PaneReveal>
    );
}

// drawn in place of "Reading…" when a tab's first read failed, so the tab never waits on a read that is over
export function LoadFailed({ error, onRetry }: { error: string; onRetry: () => void }) {
    return (
        <div
            role="alert"
            data-load-failed
            className="flex flex-1 flex-col items-center justify-center gap-2.5 px-4 py-3 text-center"
        >
            <span className="text-[12.5px] leading-[1.45] break-words text-error-soft">{error}</span>
            <button type="button" onClick={onRetry} className={BTN_SECONDARY}>
                Retry
            </button>
        </div>
    );
}

// a read-only view of one file: its path, then its text wrapped and scrolled inside the box
export function FilePreview({ path, className }: { path: string; className?: string }) {
    const [file] = useFileText(path);
    return (
        <div
            className={cn(
                "flex min-h-0 flex-col overflow-hidden rounded border border-edge-mid bg-surface-code",
                className
            )}
        >
            <div className="flex h-[30px] flex-none items-center border-b border-edge-faint px-3 font-mono text-[11px] text-muted">
                <span title={path} className="min-w-0 truncate">
                    {path}
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12.5px] leading-[21px]">
                {file.status === "ok" ? (
                    <div className="whitespace-pre-wrap break-words text-secondary">{file.text}</div>
                ) : (
                    <div className="text-muted">{file.status === "error" ? `Could not read ${path}` : "Reading…"}</div>
                )}
            </div>
        </div>
    );
}
