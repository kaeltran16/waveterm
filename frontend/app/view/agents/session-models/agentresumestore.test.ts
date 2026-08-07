import { describe, expect, it } from "vitest";
import { shouldPersistResume } from "./agentresumestore";

describe("shouldPersistResume", () => {
    it("resumes a claude or opencode agent when Remember flags is on", () => {
        expect(shouldPersistResume("claude", true)).toBe(true);
        expect(shouldPersistResume("opencode", true)).toBe(true);
    });

    it("does not resume when Remember flags is off (user wants a clean slate)", () => {
        expect(shouldPersistResume("opencode", false)).toBe(false);
    });

    it("never resumes codex/antigravity/unknown providers", () => {
        expect(shouldPersistResume("codex", true)).toBe(false);
        expect(shouldPersistResume("antigravity", true)).toBe(false);
        expect(shouldPersistResume(undefined, true)).toBe(false);
    });

    it("matches the provider case-insensitively", () => {
        expect(shouldPersistResume("OpEnCoDe", true)).toBe(true);
    });
});
