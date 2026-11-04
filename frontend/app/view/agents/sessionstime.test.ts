// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { eventTime, ranLabel, startedLabel } from "./sessionstime";

const NOW = new Date(2026, 10, 4, 15, 30).getTime();

describe("sessionstime", () => {
    it("startedLabel same year and other year", () => {
        expect(startedLabel(new Date(2026, 9, 23, 9, 13).getTime(), NOW)).toBe("Oct 23 09:13");
        expect(startedLabel(new Date(2025, 9, 23, 21, 5).getTime(), NOW)).toBe("Oct 23 2025 21:05");
    });

    it("eventTime today vs another day", () => {
        expect(eventTime(new Date(2026, 10, 4, 9, 13).getTime(), NOW)).toBe("09:13");
        expect(eventTime(new Date(2026, 10, 3, 23, 59).getTime(), NOW)).toBe("Nov 3 23:59");
        expect(eventTime(new Date(2025, 10, 4, 9, 13).getTime(), NOW)).toBe("Nov 4 2025 09:13");
    });

    it("ranLabel", () => {
        expect(ranLabel(3 * 3_600_000)).toBe("ran 3h");
        expect(ranLabel(23 * 60_000)).toBe("ran 23m");
        expect(ranLabel(30_000)).toBe("ran <1m");
        expect(ranLabel(0)).toBe("");
    });
});
