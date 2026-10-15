// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Where it goes as a table: one row per part, ranked by spend, with a tokens bar and a spend bar side by
// side. Only the grid; the card and its heading belong to the surface. Rows come from splitTable.
//
// A scope change re-ranks the rows, so they slide to their new place and a part that comes or goes fades (a range change
// reloads behind the skeleton, so its rows mount fresh).
// They measure only when the order changes (layoutDependency): otherwise motion animates any move on screen, and the
// card shifting as the content above it resizes would slide every row in from where the card used to be.

import { Meter } from "@/app/element/meter";
import { cardVariants } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { AnimatePresence, motion } from "motion/react";
import type { SplitTableData } from "./usageattribution";
import { fmt, pctStr, usd } from "./usagestats";

const GRID = "grid grid-cols-[200px_minmax(0,1fr)_130px_minmax(0,1fr)_120px] gap-x-4";

export function SplitTable({ table }: { table: SplitTableData }) {
    const order = table.rows.map((r) => r.key).join(",");
    return (
        <div className="relative flex flex-col">
            <div className={cn(GRID, "pb-1.5 font-mono text-[10.5px] text-muted")}>
                <span>{table.head}</span>
                <span>tokens</span>
                <span />
                <span>spend ≈ API-equiv</span>
                <span />
            </div>
            <AnimatePresence mode="popLayout" initial={false}>
                {table.rows.map((r) => (
                    <motion.div
                        key={r.key}
                        layout="position"
                        layoutDependency={order}
                        variants={cardVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        data-usage-split-part={r.key}
                        className={cn(GRID, "items-center border-t border-edge-faint py-[7px]")}
                    >
                        <span className="flex min-w-0 items-center gap-[7px] text-[12px] font-semibold text-secondary">
                            <span className={cn("h-[9px] w-[9px] flex-none rounded-[3px]", r.fill)} />
                            <span className="truncate">{r.label}</span>
                        </span>
                        <Meter pct={r.tokenBarPct} fill={r.fill} track="bg-background" />
                        <span className="text-right font-mono text-[11px] text-muted">
                            <span className="text-secondary">{fmt(r.tokens)}</span> · {pctStr(r.tokenPct)}
                        </span>
                        <Meter pct={r.spendBarPct} fill={r.fill} track="bg-background" />
                        <span className="text-right font-mono text-[11px] text-muted">
                            <span className="text-secondary">{usd(r.spendUsd)}</span> · {pctStr(r.spendPct)}
                        </span>
                    </motion.div>
                ))}
            </AnimatePresence>
            <motion.div
                layout="position"
                layoutDependency={order}
                data-usage-split-total
                className={cn(GRID, "border-t border-border pt-[9px] font-mono text-[11px] font-bold text-primary")}
            >
                <span className="font-sans text-[12px]">Total</span>
                <span />
                <span className="text-right">{fmt(table.tokens)}</span>
                <span />
                <span className="text-right">≈ {usd(table.spendUsd)}</span>
            </motion.div>
        </div>
    );
}
