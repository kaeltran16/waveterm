import { describe, expect, it } from "vitest";
import { shouldPersistClaudeResume } from "./agentresumestore";

describe("shouldPersistClaudeResume", () => {
    it("resumes a claude agent when Remember flags is on", () => {
        expect(shouldPersistClaudeResume("claude", true)).toBe(true);
    });

    it("does not resume claude when Remember flags is off (user wants a clean slate)", () => {
        expect(shouldPersistClaudeResume("claude", false)).toBe(false);
    });

    it("never resumes non-claude providers, even when Remember flags is on", () => {
        expect(shouldPersistClaudeResume("codex", true)).toBe(false);
        expect(shouldPersistClaudeResume(undefined, true)).toBe(false);
    });

    it("matches the provider case-insensitively", () => {
        expect(shouldPersistClaudeResume("Claude", true)).toBe(true);
    });
});
