import { describe, expect, it } from "vitest";
import type { AgentActionEntry } from "./agentsviewmodel";
import { ChartCard } from "./chartcard";
import { blockRendererFor, isGitDiffCommand, toolRendererKey } from "./renderregistry";

const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b";
const GO_TEST = "--- FAIL: TestX (0.00s)\n    x_test.go:3: bad\nFAIL\tpkg/x\t0.1s";

function bash(command: string, output: string): AgentActionEntry {
    return { kind: "action", verb: "ran", target: command, detail: { kind: "bash", command, output, exit: 0 } };
}

describe("toolRendererKey", () => {
    it("renders images first, whatever the tool", () => {
        const a: AgentActionEntry = { ...bash("git diff", DIFF), images: [{ mediaType: "image/png", data: "AAAA" }] };
        expect(toolRendererKey(a)).toBe("image");
        expect(toolRendererKey({ kind: "action", verb: "read", target: "x.png", images: [a.images[0]] })).toBe("image");
    });
    it("renders a git diff or git show whose output parses", () => {
        expect(toolRendererKey(bash("git diff HEAD~1", DIFF))).toBe("git-diff");
        expect(toolRendererKey(bash("git -C ../repo show abc123", DIFF))).toBe("git-diff");
    });
    it("renders a go test or vitest run whose output parses", () => {
        expect(toolRendererKey(bash("go test ./pkg/x", GO_TEST))).toBe("test");
        expect(toolRendererKey(bash("npx vitest run a.test.ts", " Tests  2 passed (2)"))).toBe("test");
    });
    it("renders a final-verify run whose output parses", () => {
        expect(toolRendererKey(bash("node scripts/cdp/final-verify.mjs final-stage", "\n# s\n  PASS  1. a"))).toBe(
            "test"
        );
    });
    it("returns null when the output does not parse", () => {
        expect(toolRendererKey(bash("git diff", ""))).toBeNull();
        expect(toolRendererKey(bash("go test ./...", "no idea what this is"))).toBeNull();
    });
    it("returns null for other commands, other tools and no detail", () => {
        expect(toolRendererKey(bash("cat x.diff", DIFF))).toBeNull();
        expect(toolRendererKey({ kind: "action", verb: "read", target: "x" })).toBeNull();
        expect(
            toolRendererKey({ kind: "action", verb: "read", target: "x", detail: { kind: "read", snippet: DIFF } })
        ).toBeNull();
    });
});

describe("isGitDiffCommand", () => {
    it("matches git diff and git show, with global flags and in a compound command", () => {
        expect(isGitDiffCommand("git diff")).toBe(true);
        expect(isGitDiffCommand("git --no-pager diff --cached")).toBe(true);
        expect(isGitDiffCommand("cd repo && git show HEAD")).toBe(true);
        expect(isGitDiffCommand("git log -p")).toBe(false);
        expect(isGitDiffCommand("git stash show")).toBe(false);
        expect(isGitDiffCommand("echo git differs")).toBe(false);
        expect(isGitDiffCommand("git -c a=b -C ../r diff")).toBe(true);
    });
    it("answers a long run of git flags without backtracking blow-up", () => {
        const start = performance.now();
        expect(isGitDiffCommand("git " + "-a ".repeat(60) + "status")).toBe(false);
        expect(performance.now() - start).toBeLessThan(100);
    });
});

describe("blockRendererFor", () => {
    it("maps the chart language to ChartCard", () => {
        expect(blockRendererFor("chart")).toBe(ChartCard);
    });
    it("has no renderer for other or missing languages", () => {
        expect(blockRendererFor(undefined)).toBeUndefined();
        expect(blockRendererFor("ts")).toBeUndefined();
    });
    it("does not resolve inherited object keys", () => {
        expect(blockRendererFor("constructor")).toBeUndefined();
        expect(blockRendererFor("toString")).toBeUndefined();
    });
});
