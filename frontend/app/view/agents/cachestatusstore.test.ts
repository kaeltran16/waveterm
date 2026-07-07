// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { formatCacheCountdown } from "./cachestatusstore";

describe("formatCacheCountdown", () => {
    test("no status -> em dash", () => {
        expect(formatCacheCountdown(null, 0)).toBe("—");
    });

    test("5-minute bucket, 2 minutes elapsed -> 3m left", () => {
        const status = { lastWriteTs: 1000, oneHour: false };
        expect(formatCacheCountdown(status, (1000 + 120) * 1000)).toBe("3m left");
    });

    test("5-minute bucket, under a minute remaining -> <1m left", () => {
        const status = { lastWriteTs: 1000, oneHour: false };
        expect(formatCacheCountdown(status, (1000 + 299) * 1000)).toBe("<1m left");
    });

    test("5-minute bucket, 6 minutes elapsed -> expired", () => {
        const status = { lastWriteTs: 1000, oneHour: false };
        expect(formatCacheCountdown(status, (1000 + 360) * 1000)).toBe("expired");
    });

    test("1-hour bucket, 30 seconds elapsed -> 59m left", () => {
        const status = { lastWriteTs: 1000, oneHour: true };
        expect(formatCacheCountdown(status, (1000 + 30) * 1000)).toBe("59m left");
    });
});
