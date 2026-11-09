// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The app bar's plan-usage meters: each provider's 5-hour and weekly windows as two small bars. Tokens
// and resets are on hover; the button opens the Usage surface for the rest. Claude on the API key has
// no windows, so it reads "API key" in place of its bars.

import { Meter } from "@/app/element/meter";
import { cn } from "@/util/util";
import { Fragment } from "react";
import { USAGE_LEVEL_FILL, USAGE_LEVEL_TEXT, usageLevel } from "./agentsviewmodel";
import { meterTitle, providerDot, usageBarVisible, windowUsedTokens } from "./cockpitrailmodel";
import type { mergeRateLimitWindows } from "./ratelimitstore";
import type { WindowTokens } from "./windowtokenstore";

const WINDOWS = [
    ["fivehour", "5h", "5-hour window"],
    ["week", "wk", "Weekly"],
] as const;

const API_KEY_LABEL = "API key";

type MeterItem = {
    key: string;
    provider: string;
    first: boolean;
    title: string;
} & ({ apiKey: true } | { short: string; pct: number });

export function UsageMeters({
    donuts,
    windowTokens,
    now,
    onOpen,
}: {
    donuts: ReturnType<typeof mergeRateLimitWindows>;
    windowTokens: WindowTokens | null;
    now: number;
    onOpen: () => void;
}) {
    const items = donuts.flatMap((d): MeterItem[] =>
        d.apiKey
            ? [
                  {
                      key: `${d.provider}:apikey`,
                      provider: d.provider,
                      first: true,
                      apiKey: true,
                      title: `${API_KEY_LABEL}: pay per token`,
                  },
              ]
            : WINDOWS.filter(([w]) => usageBarVisible(d[w].pct, d.stale != null)).map(([w, short, label], i) => ({
                  key: `${d.provider}:${w}`,
                  provider: d.provider,
                  first: i === 0,
                  short,
                  pct: d[w].pct!,
                  title: meterTitle(label, d[w].pct!, windowUsedTokens(d.provider, windowTokens, w), d[w].reset, now),
              }))
    );
    if (items.length === 0) {
        return null;
    }
    const multi = new Set(items.map((m) => m.provider)).size > 1;
    return (
        <button
            type="button"
            data-usage-meters
            onClick={onOpen}
            title={[...items.map((m) => m.title), "Open Usage"].join("\n")}
            className="flex h-[30px] cursor-pointer items-center gap-2.5 rounded border border-edge-mid bg-transparent px-2.5 hover:border-edge-strong hover:bg-surface-raised"
        >
            {items.map((m, i) => {
                const head = (
                    <>
                        {i > 0 ? <span className="h-3.5 w-px bg-edge-mid" /> : null}
                        {multi && m.first ? (
                            <span className={cn("h-1.5 w-1.5 rounded-full", providerDot(m.provider))} />
                        ) : null}
                    </>
                );
                // an "in" check: with strict off, a discriminant does not narrow the union
                if ("apiKey" in m) {
                    return (
                        <Fragment key={m.key}>
                            {head}
                            <span data-usage-apikey className="font-mono text-[11px] text-muted">
                                {API_KEY_LABEL}
                            </span>
                        </Fragment>
                    );
                }
                const lvl = usageLevel(m.pct);
                return (
                    <Fragment key={m.key}>
                        {head}
                        <span className="font-mono text-[10.5px] text-muted">{m.short}</span>
                        {/* hidden on a narrow app bar (its @container) so the search keeps its room; the
                            percentage stays and the title keeps the detail. 1200: one provider's two bars
                            take 108px, which leaves the search under 200px below a ~1060px bar */}
                        <Meter
                            pct={m.pct}
                            fill={USAGE_LEVEL_FILL[lvl]}
                            height={5}
                            radius={3}
                            className="w-11 @max-[1200px]:hidden"
                        />
                        <span className={cn("font-mono text-[11px] font-semibold", USAGE_LEVEL_TEXT[lvl])}>
                            {Math.round(m.pct)}%
                        </span>
                    </Fragment>
                );
            })}
        </button>
    );
}
