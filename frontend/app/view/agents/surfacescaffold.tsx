// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared surface chrome — the single source of truth for cockpit surface headers, empty states, and
// load-error banners. Modeled on the original cockpit header + CockpitEmptyState.
// See docs/superpowers/specs/2026-07-14-cross-surface-consistency-scaffold-design.md.

import { cardVariants } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { motion } from "motion/react";
import type { ReactNode } from "react";

export function SurfaceHeader({
    title,
    badge,
    subtitle,
    actions,
    border = true,
}: {
    title: string;
    badge?: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
    border?: boolean;
}) {
    return (
        <div
            className={cn(
                "flex flex-none items-start justify-between gap-5 bg-background px-[28px] pb-4 pt-5",
                border && "border-b border-border"
            )}
        >
            <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                    <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">{title}</h1>
                    {badge}
                </div>
                {subtitle != null ? <div className="mt-1 text-[13px] text-secondary">{subtitle}</div> : null}
            </div>
            {actions != null ? <div className="flex flex-none items-center gap-2">{actions}</div> : null}
        </div>
    );
}

export function SurfaceEmptyState({
    glyph,
    title,
    body,
    action,
}: {
    glyph?: ReactNode;
    title: string;
    body?: ReactNode;
    action?: { label: ReactNode; onClick: () => void; hint?: ReactNode };
}) {
    return (
        <motion.div
            key="empty"
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex h-full w-full flex-col items-center justify-center px-[30px] py-12 text-center"
        >
            <div className="flex w-full max-w-[600px] flex-col items-center">
                {glyph}
                <h2 className="mb-2.5 text-[25px] font-bold tracking-[-0.02em] text-primary">{title}</h2>
                {body != null ? (
                    <div className="mb-[30px] max-w-[400px] text-[14px] leading-[1.6] text-muted">{body}</div>
                ) : null}
                {action != null ? (
                    <>
                        <motion.button
                            type="button"
                            onClick={action.onClick}
                            whileHover={{ y: -1 }}
                            whileTap={{ y: 0 }}
                            style={{
                                boxShadow:
                                    "0 14px 34px color-mix(in srgb, var(--color-accent) 34%, transparent), inset 0 1px 0 rgba(255,255,255,0.28)",
                            }}
                            className="flex cursor-pointer items-center gap-[11px] rounded-lg bg-accent px-[26px] py-3.5 text-[15px] font-bold text-background hover:bg-accenthover"
                        >
                            {action.label}
                        </motion.button>
                        {action.hint != null ? (
                            <div className="mt-[18px] text-[12.5px] text-muted">{action.hint}</div>
                        ) : null}
                    </>
                ) : null}
            </div>
        </motion.div>
    );
}

export function SurfaceError({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div className="mx-[28px] mt-3 flex items-center gap-3 rounded-[10px] border border-error/40 bg-error/10 px-3.5 py-2.5 text-[12.5px] text-error">
            <span className="flex-1">{message}</span>
            {onRetry != null ? (
                <button
                    type="button"
                    onClick={onRetry}
                    className="flex-none cursor-pointer rounded border border-error/40 px-2 py-0.5 font-semibold hover:bg-error/15"
                >
                    Retry
                </button>
            ) : null}
        </div>
    );
}
