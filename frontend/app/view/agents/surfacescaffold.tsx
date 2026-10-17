// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared surface chrome — the single source of truth for cockpit surface headers (SurfaceToolbar),
// empty states, and load-error banners.
// See docs/superpowers/specs/2026-07-14-cross-surface-consistency-scaffold-design.md.

import { cardVariants } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { motion } from "motion/react";
import type { ReactNode } from "react";

// no overflow-hidden: Radar's audits popover and Code's project picker open out of this header.
// when the controls do not fit one row it wraps rather than clipping them; py-1.5 lands a single
// row of controls up to 39px at exactly 52px. actions takes min-w-0 so a truncating fact placed there
// (Diff's range summary) can shrink instead of wrapping.
export function SurfaceToolbar({
    title,
    children,
    actions,
    className,
}: {
    title: string;
    children?: ReactNode;
    actions?: ReactNode;
    className?: string;
}) {
    return (
        <header
            data-surface-toolbar
            className={cn(
                "flex min-h-[52px] flex-none flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-border bg-background px-5 py-1.5",
                className
            )}
        >
            <h1 className="text-[15px] font-semibold text-primary">{title}</h1>
            {children}
            <span className="flex-1" />
            {actions != null ? <div className="flex min-w-0 items-center gap-2">{actions}</div> : null}
        </header>
    );
}

// a flex-wrap row breaks on each item's max-content width, so a nowrap fact wraps to a new line before
// it shrinks: a fact meant to truncate needs "min-w-0 flex-1 basis-0 truncate" to take the spacer's place.
export function ToolbarFact({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <span
            className={cn(
                "flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-[11.5px] text-muted",
                className
            )}
        >
            {children}
        </span>
    );
}

// className exists for one reason: the Jarvis Stage stacks this directly above and below bands that all
// share one gutter (jarvis/stagemeasure.ts), and px-[30px] put it 6px right of every one of them. A
// surface that owns its own horizontal measure passes it in; everyone else keeps the default.
// children sit between the body and the buttons, for a state that has to show what it is working on
// (Radar's collector list). secondaryAction sits beside the primary, or alone when a state has no
// accent action to offer.
export function SurfaceEmptyState({
    glyph,
    title,
    body,
    action,
    secondaryAction,
    children,
    className,
}: {
    glyph?: ReactNode;
    title: string;
    body?: ReactNode;
    action?: { label: ReactNode; onClick: () => void; hint?: ReactNode; disabled?: boolean };
    secondaryAction?: { label: ReactNode; onClick: () => void };
    children?: ReactNode;
    className?: string;
}) {
    return (
        <motion.div
            key="empty"
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className={cn(
                "flex h-full w-full flex-col items-center justify-center px-[30px] py-12 text-center",
                className
            )}
        >
            <div className="flex w-full max-w-[600px] flex-col items-center">
                {glyph}
                <h2 className="mb-2.5 text-[25px] font-bold tracking-[-0.02em] text-primary">{title}</h2>
                {body != null ? (
                    <div className="mb-[30px] max-w-[400px] text-[14px] leading-[1.6] text-muted">{body}</div>
                ) : null}
                {children != null ? <div className="mb-[26px] w-full">{children}</div> : null}
                {action != null || secondaryAction != null ? (
                    <div className="flex items-center gap-2.5">
                        {action != null ? (
                            <button
                                type="button"
                                onClick={action.onClick}
                                disabled={action.disabled}
                                className="flex cursor-pointer items-center gap-[11px] rounded-lg bg-accent px-[26px] py-3.5 text-[15px] font-bold text-background shadow-cta hover:bg-accenthover disabled:cursor-default disabled:opacity-50"
                            >
                                {action.label}
                            </button>
                        ) : null}
                        {secondaryAction != null ? (
                            <button
                                type="button"
                                onClick={secondaryAction.onClick}
                                className="cursor-pointer rounded-lg border border-edge-mid bg-surface-raised px-4 py-2.5 text-[13px] font-semibold text-secondary hover:border-edge-strong"
                            >
                                {secondaryAction.label}
                            </button>
                        ) : null}
                    </div>
                ) : null}
                {action?.hint != null ? <div className="mt-[18px] text-[12.5px] text-muted">{action.hint}</div> : null}
            </div>
        </motion.div>
    );
}

// actionLabel exists because not every recoverable state is a retry: the Code surface refuses a save
// when the file changed underneath, and there the button reloads rather than re-attempts.
export function SurfaceError({
    message,
    onRetry,
    actionLabel = "Retry",
}: {
    message: string;
    onRetry?: () => void;
    actionLabel?: string;
}) {
    return (
        <div
            data-surface-error
            className="mx-[28px] mt-3 flex items-center gap-3 rounded-[10px] border border-error/40 bg-error/10 px-3.5 py-2.5 text-[12.5px] text-error"
        >
            <span className="flex-1">{message}</span>
            {onRetry != null ? (
                <button
                    type="button"
                    onClick={onRetry}
                    className="flex-none cursor-pointer rounded border border-error/40 px-2 py-0.5 font-semibold hover:bg-error/15"
                >
                    {actionLabel}
                </button>
            ) : null}
        </div>
    );
}
