import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    mergeRateLimitWindows,
    readSavedRateLimits,
    recordRateLimit,
    topProviderUsage,
    type SavedSnapshot,
} from "./ratelimitstore";
import { liveWindowAgents, providerPlanUsage, type AgentVM } from "./agentsviewmodel";

describe("topProviderUsage", () => {
    const now = 1_800_000_000_000;
    it("returns the provider with the highest 5-hour pct (so both-provider case is labeled, not a bare max)", () => {
        const donuts = mergeRateLimitWindows(
            [
                { provider: "claude", usage: { fivehourpct: 40 } },
                { provider: "codex", usage: { fivehourpct: 72 } },
            ],
            {},
            now
        );
        expect(topProviderUsage(donuts)).toEqual({ provider: "codex", pct: 72 });
    });
    it("ignores windows with no 5-hour pct and is undefined when none have one", () => {
        const donuts = mergeRateLimitWindows([{ provider: "claude", usage: { weekpct: 30 } }], {}, now);
        expect(topProviderUsage(donuts)).toBeUndefined();
        expect(topProviderUsage([])).toBeUndefined();
    });
});

describe("account-level donut ignores idle agents' stale snapshots", () => {
    const now = 1_800_000_000_000;
    const active = { id: "a", name: "A", task: "", state: "working", agent: "claude", usage: { fivehourpct: 80, weekpct: 50 } } as AgentVM;
    const idleStale = { id: "b", name: "B", task: "", state: "idle", agent: "claude", usage: { fivehourpct: 20, weekpct: 10 } } as AgentVM;

    it("shows the active session's live window, not the idle snapshot, regardless of roster order", () => {
        for (const roster of [[active, idleStale], [idleStale, active]]) {
            const claude = mergeRateLimitWindows(providerPlanUsage(liveWindowAgents(roster)), {}, now).find(
                (d) => d.provider === "claude"
            );
            expect(claude?.fivehour.pct).toBe(80);
        }
    });

    it("falls back to the saved reading (marked stale) when every claude session is idle", () => {
        const saved: Record<string, SavedSnapshot> = { claude: { fivehourpct: 63, capturedAt: now } };
        const claude = mergeRateLimitWindows(providerPlanUsage(liveWindowAgents([idleStale])), saved, now).find(
            (d) => d.provider === "claude"
        );
        expect(claude?.fivehour.pct).toBe(63);
        expect(claude?.stale?.capturedAt).toBe(now);
    });
});

function mockLocalStorage(): Record<string, string> {
    const store: Record<string, string> = {};
    (globalThis as any).localStorage = {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
            store[k] = v;
        },
        removeItem: (k: string) => {
            delete store[k];
        },
        clear: () => {
            for (const k of Object.keys(store)) delete store[k];
        },
        key: () => null,
        length: 0,
    };
    return store;
}

describe("mergeRateLimitWindows", () => {
    const now = 1_800_000_000_000; // fixed epoch ms
    const live = (provider: string, usage: AgentUsage) => ({ provider, usage });

    it("prefers live and sets no stale flag", () => {
        const out = mergeRateLimitWindows([live("claude", { fivehourpct: 62, fivehourreset: 100, weekpct: 41 })], {}, now);
        expect(out).toHaveLength(1);
        expect(out[0].fivehour).toEqual({ pct: 62, reset: 100 });
        expect(out[0].week).toEqual({ pct: 41, reset: undefined });
        expect(out[0].stale).toBeUndefined();
    });

    it("falls back to a saved snapshot and marks it stale", () => {
        const saved: Record<string, SavedSnapshot> = {
            claude: { fivehourpct: 50, fivehourreset: now / 1000 + 600, weekpct: 30, capturedAt: now - 5000 },
        };
        const out = mergeRateLimitWindows([], saved, now);
        expect(out[0].fivehour).toEqual({ pct: 50, reset: now / 1000 + 600 });
        expect(out[0].stale).toEqual({ capturedAt: now - 5000 });
    });

    it("rolls a window over to empty once its reset has passed", () => {
        const saved: Record<string, SavedSnapshot> = {
            claude: { fivehourpct: 80, fivehourreset: now / 1000 - 10, weekpct: 30, weekreset: now / 1000 + 600, capturedAt: now - 5000 },
        };
        const out = mergeRateLimitWindows([], saved, now);
        expect(out[0].fivehour).toEqual({ pct: 0, reset: undefined }); // rolled over
        expect(out[0].week).toEqual({ pct: 30, reset: now / 1000 + 600 }); // still valid
    });

    it("unions live + saved providers, claude first", () => {
        const out = mergeRateLimitWindows(
            [live("codex", { fivehourpct: 10 })],
            { claude: { fivehourpct: 5, capturedAt: now } },
            now
        );
        expect(out.map((p) => p.provider)).toEqual(["claude", "codex"]);
    });
});

describe("recordRateLimit + readSavedRateLimits round-trip", () => {
    beforeEach(() => mockLocalStorage());
    afterEach(() => {
        delete (globalThis as any).localStorage;
    });

    it("persists only window fields (+capturedAt), dropping context/cost", () => {
        recordRateLimit("claude", { fivehourpct: 62, fivehourreset: 999, weekpct: 41, contextpct: 70, costusd: 1.2 });
        const saved = readSavedRateLimits();
        expect(saved.claude.fivehourpct).toBe(62);
        expect(saved.claude.weekpct).toBe(41);
        expect(saved.claude.capturedAt).toBeGreaterThan(0);
        expect((saved.claude as any).contextpct).toBeUndefined();
        expect((saved.claude as any).costusd).toBeUndefined();
    });

    it("is a no-op for usage without window fields", () => {
        recordRateLimit("claude", { contextpct: 70, costusd: 1.2 });
        expect(readSavedRateLimits()).toEqual({});
    });

    it("corrupt localStorage reads back as empty", () => {
        (globalThis as any).localStorage.setItem("wave:ratelimits", "{not json");
        expect(readSavedRateLimits()).toEqual({});
    });
});
