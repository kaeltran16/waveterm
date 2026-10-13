// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Where it goes as a table: one row per part, ranked by spend, with a tokens bar and a spend bar side by
// side. Only the grid; the card and its heading belong to the surface. Rows come from splitTable.

import { Meter } from "@/app/element/meter";
import { cn } from "@/util/util";
import type { SplitTableData } from "./usageattribution";
import { fmt, pctStr, usd } from "./usagestats";

const GRID = "grid grid-cols-[200px_minmax(0,1fr)_130px_minmax(0,1fr)_120px] gap-x-4";

export function SplitTable({ table }: { table: SplitTableData }) {
    return (
        <div className="flex flex-col">
            <div className={cn(GRID, "pb-1.5 font-mono text-[10.5px] text-muted")}>
                <span>{table.head}</span>
                <span>tokens</span>
                <span />
                <span>spend ≈ API-equiv</span>
                <span />
            </div>
            {table.rows.map((r) => (
                <div
                    key={r.key}
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
                </div>
            ))}
            <div
                data-usage-split-total
                className={cn(GRID, "border-t border-border pt-[9px] font-mono text-[11px] font-bold text-primary")}
            >
                <span className="font-sans text-[12px]">Total</span>
                <span />
                <span className="text-right">{fmt(table.tokens)}</span>
                <span />
                <span className="text-right">≈ {usd(table.spendUsd)}</span>
            </div>
        </div>
    );
}
