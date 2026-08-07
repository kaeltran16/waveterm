// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runtimeMeta } from "./runtimemeta";

describe("runtimeMeta", () => {
    it("maps known providers case-insensitively", () => {
        expect(runtimeMeta("codex").id).toBe("codex");
        expect(runtimeMeta("Codex").id).toBe("codex");
        expect(runtimeMeta("claude").glyph).toBe("✳");
        expect(runtimeMeta("opencode").id).toBe("opencode");
        expect(runtimeMeta("opencode").label).toBe("opencode");
        expect(runtimeMeta("Opencode").id).toBe("opencode");
    });

    it("falls back to claude for unknown/undefined providers", () => {
        expect(runtimeMeta(undefined).id).toBe("claude");
        expect(runtimeMeta("antigravity").id).toBe("claude");
        expect(runtimeMeta("").id).toBe("claude");
    });
});
