// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentAsk } from "./agentsviewmodel";
import { parseSpecReview } from "./specreview";

const ask = (header: string, question: string): AgentAsk => ({
    questions: [{ question, header, options: [{ label: "Approve" }, { label: "Request changes" }] }],
});

describe("parseSpecReview", () => {
    it("reads the path and decisions from a Spec review ask", () => {
        const q =
            "C:/repo/docs/specs/2026-09-24-auth.md\n- Redis sessions, 14-day sliding TTL\n- Accept the legacy sid cookie for one release";
        expect(parseSpecReview(ask("Spec review", q))).toEqual({
            qi: 0,
            path: "C:/repo/docs/specs/2026-09-24-auth.md",
            decisions: ["Redis sessions, 14-day sliding TTL", "Accept the legacy sid cookie for one release"],
        });
    });
    it("tolerates a backticked path, CRLF and header case", () => {
        expect(parseSpecReview(ask("spec Review ", "`/r/spec.md`\r\n- one"))?.path).toBe("/r/spec.md");
    });
    it("falls back to an ordinary question when the convention is not met", () => {
        expect(parseSpecReview(ask("Flake fix", "/r/spec.md"))).toBeNull();
        expect(parseSpecReview(ask("Spec review", "Does the spec look right?"))).toBeNull();
        expect(parseSpecReview(undefined)).toBeNull();
    });
});
