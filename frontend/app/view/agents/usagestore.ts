// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface store: raw wire buckets, the session directory + the impure loader. The scan runs in the Go backend
// (GetUsageStatsCommand walks every in-window transcript, no file cap); this stores the raw buckets
// and exposes aggregateBuckets over them (all-history when no harness filter is applied — the
// surface's filtered stats come from the view model). On RPC failure the last-good buckets are kept
// (a transient websocket drop must not blank the surface) and usageErrorAtom is set.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { aggregateBuckets, windowStartDay } from "./usagestats";
import type { DailyTokens } from "./weeklyforecast";

const DEFAULT_WINDOW_DAYS = 7;
// the weekly forecast's day-of-week shape reads a fixed four weeks of Claude history, whatever the range
const FORECAST_WINDOW_DAYS = 28;
const FORECAST_REFRESH_MS = 60 * 60 * 1000;
// the scan walks every transcript in the window: measured 1.3s-11.7s on a 2.7 GB ~/.claude/projects, past the 5s default
const USAGE_RPC_TIMEOUT_MS = 60_000;

export const usageBucketsAtom = atom<UsageBucket[]>([]) as PrimitiveAtom<UsageBucket[]>;
// what each bucket's session was: its title, project, run and role. set from the same reply as the buckets
export const usageSessionsAtom = atom<UsageSession[]>([]) as PrimitiveAtom<UsageSession[]>;
// the window days the held buckets were loaded for; null before the first success. Set only on success,
// so after a failed switch it still names what the buckets cover
export const usageHeldWindowAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;
export const allUsageStatsAtom = atom((get) => {
    const now = Date.now();
    return aggregateBuckets(get(usageBucketsAtom), now, "all", windowStartDay(get(usageHeldWindowAtom), now));
});
export const usageErrorAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
export const usageLoadedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
// Claude's daily tokens over the last FORECAST_WINDOW_DAYS; null until the first forecast load lands
export const forecastDailyAtom = atom<DailyTokens[] | null>(null) as PrimitiveAtom<DailyTokens[] | null>;

// UsageSurface toggle selections live here, not in surface-local useState: the surface unmounts on
// nav-rail switch (only the Agent surface stays mounted), so component state would reset to default
// on every tab switch. Module-level atoms keep the user's window/metric choice across unmount.
export const usageWindowAtom = atom<"7d" | "all">("7d");
export const usageMetricAtom = atom<"tokens" | "spend">("tokens");
export type UsageLens = "provider" | "work" | "workflow";
export const usageLensAtom = atom<UsageLens>("provider");
// By work: the rail scope ("all" or a project key), the run or session opened from a list with the
// scope its Back returns to, and whether the ranked list is expanded
export const usageWorkScopeAtom = atom<string>("all");
export type UsageWorkItem = { key: string; back: string };
export const usageWorkItemAtom = atom<UsageWorkItem | null>(null) as PrimitiveAtom<UsageWorkItem | null>;
export const usageListExpandedAtom = atom<boolean>(false);

// DEV-only fixture seam: a deterministic localStorage {buckets, sessions} object (see the usage-charts
// CDP scenario). Compiled out behaviorally in production because import.meta.env.DEV is false. Malformed
// or absent fixtures fall through to the RPC. `delayMs` holds the reply back so the skeleton shows, and
// `fail: true` takes the failure path; fail is read before buckets, so `{ fail: true }` alone fails.
const DEV_USAGE_FIXTURE_KEY = "wave:dev-usage-buckets";

type DevUsageFixture = { reply?: CommandGetUsageStatsRtnData; delayMs: number; fail: boolean };

function devUsageFixture(): DevUsageFixture | undefined {
    if (!import.meta.env.DEV || typeof localStorage === "undefined") return undefined;
    const raw = localStorage.getItem(DEV_USAGE_FIXTURE_KEY);
    if (raw == null) return undefined;
    try {
        const value = JSON.parse(raw);
        if (value == null) return undefined;
        const delayMs = typeof value.delayMs === "number" ? value.delayMs : 0;
        if (value.fail === true) return { delayMs, fail: true };
        if (!Array.isArray(value.buckets)) return undefined;
        const sessions = Array.isArray(value.sessions) ? value.sessions : [];
        return { reply: { buckets: value.buckets, sessions }, delayMs, fail: false };
    } catch {
        return undefined;
    }
}

// the fixture's reply cut to the window the RPC would scan (windowStartDay; 0 is all time), keeping a
// session only while one of its buckets survives
function windowedReply(reply: CommandGetUsageStatsRtnData, windowDays: number): CommandGetUsageStatsRtnData {
    const startKey = windowStartDay(windowDays, Date.now());
    if (startKey == null) return reply;
    const buckets = reply.buckets.filter((b) => b.day >= startKey);
    const kept = new Set(buckets.map((b) => `${b.harness}\u0000${b.session}`));
    const sessions = reply.sessions.filter((s) => kept.has(`${s.harness}\u0000${s.session}`));
    return { buckets, sessions };
}

// one usage scan for a window: the dev fixture when set (its delay and failure included), else the RPC
async function fetchUsage(windowDays: number): Promise<CommandGetUsageStatsRtnData> {
    const fixture = devUsageFixture();
    if (fixture != null && fixture.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, fixture.delayMs));
    }
    if (fixture?.fail) {
        throw new Error("dev usage fixture: fail");
    }
    if (fixture?.reply != null) {
        return windowedReply(fixture.reply, windowDays);
    }
    return RpcApi.GetUsageStatsCommand(TabRpcClient, { windowdays: windowDays }, { timeout: USAGE_RPC_TIMEOUT_MS });
}

export type UsageLoadView = "skeleton" | "data" | "data-with-error" | "switch-failed";

// What the detail shows. The held buckets show whenever they are the requested window, even while it
// reloads; another window shows the skeleton while it loads and, if it failed, an error panel rather
// than the held buckets under the wrong range.
export function usageLoadView(
    requestedDays: number,
    heldDays: number | null,
    loaded: boolean,
    error: boolean
): UsageLoadView {
    if (requestedDays === heldDays) return error ? "data-with-error" : "data";
    if (!loaded) return "skeleton";
    return error ? "switch-failed" : "data";
}

// Monotonic request id: the latest loadUsage wins. Replaces a single `loading` bool that silently
// dropped a window switch fired while a prior load was in flight (and let a slow prior-window response
// land after the switch and clobber the new window's data). Now a switch always issues a fresh request
// and any older, still-in-flight response is ignored on resolve.
let loadSeq = 0;
// the window the held buckets were requested for; undefined until the first load
let heldWindowDays: number | undefined;

export async function loadUsage(windowDays = DEFAULT_WINDOW_DAYS): Promise<void> {
    const seq = ++loadSeq;
    // the skeleton shows only while a different window loads. Reopening the surface, like the 60s
    // refresh, keeps the buckets it already holds on screen and replaces them when the scan returns.
    if (windowDays !== heldWindowDays) {
        heldWindowDays = windowDays;
        globalStore.set(usageLoadedAtom, false);
        // a failed switch's error belongs to that window; switching on (or back) starts clean
        globalStore.set(usageErrorAtom, false);
    }
    try {
        const reply = await fetchUsage(windowDays);
        if (seq !== loadSeq) {
            return; // a newer load superseded this one — ignore its result
        }
        globalStore.set(usageBucketsAtom, reply.buckets ?? []);
        globalStore.set(usageSessionsAtom, reply.sessions ?? []);
        globalStore.set(usageHeldWindowAtom, windowDays);
        globalStore.set(usageErrorAtom, false);
    } catch {
        if (seq !== loadSeq) {
            return;
        }
        // keep the last-good buckets and sessions; surface a subtle "couldn't refresh" instead of blanking
        globalStore.set(usageErrorAtom, true);
    } finally {
        if (seq === loadSeq) {
            globalStore.set(usageLoadedAtom, true);
        }
    }
}

// Claude's daily tokens over the last FORECAST_WINDOW_DAYS, from its oldest active day in that cut
// (zero-filled idle days), the series the weekly forecast's shape is built from
export function forecastDaily(buckets: UsageBucket[], now: number): DailyTokens[] {
    const start = windowStartDay(FORECAST_WINDOW_DAYS, now);
    const cut = buckets.filter((b) => b.day >= start);
    return aggregateBuckets(cut, now, "claude").daily.map((d) => ({
        day: d.day,
        tokens: d.byHarness.claude?.tokens ?? 0,
    }));
}

// when the forecast history was last requested; module-level so it survives the surface unmounting
let forecastRequestedAt: number | undefined;

// Loads the forecast's history at most once an hour. A failure logs, keeps the last history and lets the
// next call retry, so a dropped websocket at startup does not cost the forecast an hour.
export async function loadForecastHistory(now: number): Promise<void> {
    if (forecastRequestedAt != null && now - forecastRequestedAt < FORECAST_REFRESH_MS) {
        return;
    }
    forecastRequestedAt = now;
    try {
        const reply = await fetchUsage(FORECAST_WINDOW_DAYS);
        globalStore.set(forecastDailyAtom, forecastDaily(reply.buckets ?? [], now));
    } catch (e) {
        forecastRequestedAt = undefined;
        console.warn("usage forecast history unavailable", e);
    }
}
