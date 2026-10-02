// session.measure -> `wsh agentstatus --usage` arguments. kept free of the engine so vitest can run it;
// register.ts does the call.

export type UsageMeasure = {
    context: { window: number; percent?: number };
    rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[];
    cost?: { usd: number };
};

const RATE_LIMIT_FLAGS: Record<string, { pct: string; reset: string }> = {
    five_hour: { pct: "--five-hour-pct", reset: "--five-hour-reset" },
    seven_day: { pct: "--week-pct", reset: "--week-reset" },
};

// null before the first context reading: a zero would read as an empty window, the same reason
// wsh statusline reports nothing without used_percentage
export function usageArgs(m: UsageMeasure): string[] | null {
    if (m.context.percent == null) {
        return null;
    }
    const args = [
        "agentstatus", "--usage",
        "--context-pct", String(m.context.percent),
        "--context-max", String(m.context.window),
        "--cost-usd", String(m.cost?.usd ?? 0),
    ];
    for (const limit of m.rateLimits) {
        const flags = RATE_LIMIT_FLAGS[limit.kind];
        if (!flags) {
            continue;
        }
        args.push(flags.pct, String(limit.percentUsed));
        const resetMs = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
        if (!Number.isNaN(resetMs)) {
            args.push(flags.reset, String(Math.floor(resetMs / 1000)));
        }
    }
    return args;
}
