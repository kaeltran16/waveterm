import { describe, expect, it } from "vitest";
import { shouldPersistClaudeResume } from "./agentresumestore";

describe("shouldPersistClaudeResume", () => {
    it("resumes a claude agent only when the --continue flag is enabled", () => {
        expect(shouldPersistClaudeResume("claude", { claude: { continue: true } })).toBe(true);
    });

    it("does not resume claude when the continue flag is off, empty, or missing", () => {
        expect(shouldPersistClaudeResume("claude", { claude: { continue: false } })).toBe(false);
        expect(shouldPersistClaudeResume("claude", { claude: {} })).toBe(false);
        expect(shouldPersistClaudeResume("claude", {})).toBe(false);
        expect(shouldPersistClaudeResume("claude", undefined)).toBe(false);
    });

    it("never resumes non-claude providers, even with a continue flag set", () => {
        expect(shouldPersistClaudeResume("codex", { codex: { continue: true } })).toBe(false);
        expect(shouldPersistClaudeResume(undefined, { claude: { continue: true } })).toBe(false);
    });

    it("matches the provider case-insensitively", () => {
        expect(shouldPersistClaudeResume("Claude", { claude: { continue: true } })).toBe(true);
    });
});
