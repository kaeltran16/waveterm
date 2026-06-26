// frontend/app/view/agents/agentcwd.test.ts
import { describe, expect, it } from "vitest";
import { agentCwd } from "./agentcwd";

describe("agentCwd", () => {
    it("reads cwd from a Claude record (top-level cwd)", () => {
        const lines = [
            JSON.stringify({ type: "mode", sessionId: "s" }),
            JSON.stringify({ type: "user", cwd: "C:\\Users\\k\\proj", gitBranch: "main" }),
        ];
        expect(agentCwd(lines)).toBe("C:\\Users\\k\\proj");
    });

    it("reads cwd from a Codex session_meta record (payload.cwd)", () => {
        const lines = [JSON.stringify({ type: "session_meta", payload: { cwd: "/home/k/proj" } })];
        expect(agentCwd(lines)).toBe("/home/k/proj");
    });

    it("returns null when no record carries a cwd", () => {
        expect(agentCwd([JSON.stringify({ type: "mode" })])).toBeNull();
    });

    it("skips blank and malformed lines", () => {
        const lines = ["", "not json", JSON.stringify({ cwd: "/x" })];
        expect(agentCwd(lines)).toBe("/x");
    });
});
