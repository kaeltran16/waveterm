import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeRateLimitWindows, readSavedRateLimits, recordRateLimit, type SavedSnapshot } from "./ratelimitstore";

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
