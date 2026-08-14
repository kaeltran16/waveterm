import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    MAX_DIFF_FILES,
    MAX_DIFF_LINES,
    SIMPLIFY_PROMPT_MARKER,
    computeDiffHash,
    decideGate,
    diffComplexity,
    isComplex,
    isExcludedPath,
    isSimplifyReviewPrompt,
    lastUserMessageText,
    parseCommitCommand,
    parseNumstat,
    readStamp,
    writeStamp,
} from "./waveterm-simplify-gate-core";

describe("waveterm-simplify-gate-core", () => {
    describe("parseCommitCommand", () => {
        it("recognizes a plain git commit", () => {
            expect(parseCommitCommand("git commit -m 'fix'")).toEqual({});
        });

        it("captures a -C repo dir override", () => {
            expect(parseCommitCommand("git -C ../other commit -m x")).toEqual({ repoDir: "../other" });
        });

        it("skips git config flags before the subcommand", () => {
            expect(parseCommitCommand("git -c user.name=pi -c core.editor=x commit")).toEqual({});
            expect(parseCommitCommand("git --no-pager commit")).toEqual({});
        });

        it("finds a commit in a compound command", () => {
            expect(parseCommitCommand("git add . && git commit -m y")).toEqual({});
            expect(parseCommitCommand("cd foo && git commit")).toEqual({});
        });

        it("rejects non-commit git commands", () => {
            expect(parseCommitCommand("git push")).toBeNull();
            expect(parseCommitCommand("git diff")).toBeNull();
            expect(parseCommitCommand("git stash")).toBeNull();
            expect(parseCommitCommand("echo git commit")).toBeNull();
        });
    });

    describe("parseNumstat", () => {
        it("sums added and deleted lines per file", () => {
            const { files, lines } = parseNumstat("3\t1\tfoo.ts\n0\t0\tbar.go\n");
            expect(files).toEqual(["foo.ts", "bar.go"]);
            expect(lines).toBe(4);
        });

        it("counts binary rows as files with zero lines", () => {
            const { files, lines } = parseNumstat("-\t-\tbin.dat\n");
            expect(files).toEqual(["bin.dat"]);
            expect(lines).toBe(0);
        });

        it("skips malformed rows", () => {
            const { files, lines } = parseNumstat("not a numstat row\n2\t1\tok.ts\n");
            expect(files).toEqual(["ok.ts"]);
            expect(lines).toBe(3);
        });
    });

    describe("isExcludedPath", () => {
        it("excludes generated and lockfile paths", () => {
            expect(isExcludedPath("dist/bundle.js")).toBe(true);
            expect(isExcludedPath("frontend/dist/x.js")).toBe(true);
            expect(isExcludedPath("node_modules/lodash/index.js")).toBe(true);
            expect(isExcludedPath("package-lock.json")).toBe(true);
            expect(isExcludedPath("pnpm-lock.yaml")).toBe(true);
            expect(isExcludedPath("yarn.lock")).toBe(true);
            expect(isExcludedPath("Cargo.lock")).toBe(true);
            expect(isExcludedPath("go.sum")).toBe(true);
            expect(isExcludedPath("frontend/types/gotypes.d.ts")).toBe(true);
            expect(isExcludedPath("frontend/app/store/wshclientapi.ts")).toBe(true);
            expect(isExcludedPath("pkg/wshrpc/wshclient/wshclient.go")).toBe(true);
        });

        it("keeps real source files", () => {
            expect(isExcludedPath("src/foo.ts")).toBe(false);
            expect(isExcludedPath("frontend/types/x.ts")).toBe(false);
            expect(isExcludedPath("pkg/wshclient/wshclient.go")).toBe(false);
            expect(isExcludedPath("distro/foo.ts")).toBe(false);
            expect(isExcludedPath("blockchain.go")).toBe(false);
        });
    });

    describe("diffComplexity / isComplex", () => {
        it("counts only non-excluded files and lines", () => {
            const c = diffComplexity("100\t5\tdist/bundle.js\n10\t2\tsrc/foo.ts\n3\t1\tpackage-lock.json\n");
            expect(c).toEqual({ lines: 12, files: 1 });
        });

        it("is complex only strictly beyond the thresholds", () => {
            expect(isComplex({ lines: 50, files: 4 })).toBe(false);
            expect(isComplex({ lines: 51, files: 1 })).toBe(true);
            expect(isComplex({ lines: 1, files: 5 })).toBe(true);
            expect(isComplex({ lines: 0, files: 0 })).toBe(false);
        });

        it("exports the thresholds the gate uses", () => {
            expect(MAX_DIFF_LINES).toBe(50);
            expect(MAX_DIFF_FILES).toBe(4);
        });
    });

    describe("computeDiffHash", () => {
        it("is deterministic and sensitive to content", () => {
            const h1 = computeDiffHash("3\t1\tfoo.ts\n");
            expect(computeDiffHash("3\t1\tfoo.ts\n")).toBe(h1);
            expect(computeDiffHash("4\t1\tfoo.ts\n")).not.toBe(h1);
        });

        it("ignores trailing whitespace differences", () => {
            expect(computeDiffHash("3\t1\tfoo.ts\n")).toBe(computeDiffHash("3\t1\tfoo.ts"));
        });
    });

    describe("decideGate", () => {
        const complexity = { lines: 60, files: 2 };
        const diffHash = "abc";

        it("lets small diffs through without evidence", () => {
            expect(decideGate({ complexity: { lines: 5, files: 1 }, hasVerifyFlag: false, stampHash: null, diffHash }).block).toBe(false);
        });

        it("blocks complex diffs without a matching stamp", () => {
            const r = decideGate({ complexity, hasVerifyFlag: false, stampHash: null, diffHash });
            expect(r.block).toBe(true);
            expect(r.reason).toContain("/simplify");
            expect(r.reason).toContain("60");
        });

        it("passes complex diffs with a matching stamp", () => {
            expect(decideGate({ complexity, hasVerifyFlag: false, stampHash: diffHash, diffHash }).block).toBe(false);
        });

        it("blocks when the stamp covers a different diff", () => {
            expect(decideGate({ complexity, hasVerifyFlag: false, stampHash: "other", diffHash }).block).toBe(true);
        });

        it("honors the --no-verify override without evidence", () => {
            expect(decideGate({ complexity, hasVerifyFlag: true, stampHash: null, diffHash }).block).toBe(false);
        });
    });

    describe("readStamp / writeStamp", () => {
        const stampDir = mkdtempSync(join(tmpdir(), "gate-stamp-"));

        it("round-trips a stamp hash", () => {
            const file = join(stampDir, "stamp.json");
            writeStamp(file, "hash-1");
            expect(readStamp(file)).toBe("hash-1");
        });

        it("returns null for a missing or corrupt stamp", () => {
            expect(readStamp(join(stampDir, "missing.json"))).toBeNull();
            const corrupt = join(stampDir, "corrupt.json");
            writeStamp(corrupt, "x");
            writeFileSync(corrupt, "not json");
            expect(readStamp(corrupt)).toBeNull();
        });
    });

    describe("isSimplifyReviewPrompt", () => {
        it("matches the /simplify follow-up header anywhere in the text", () => {
            expect(isSimplifyReviewPrompt("Review the following recently changed files and apply simplification improvements.")).toBe(true);
            expect(isSimplifyReviewPrompt("prefix\nReview the following recently changed files\nsuffix")).toBe(true);
        });

        it("rejects unrelated text", () => {
            expect(isSimplifyReviewPrompt("review my files please")).toBe(false);
            expect(isSimplifyReviewPrompt(SIMPLIFY_PROMPT_MARKER.slice(0, 10))).toBe(false);
        });
    });

    describe("lastUserMessageText", () => {
        it("returns the last user message text", () => {
            const messages = [
                { role: "user", content: "hello" },
                { role: "assistant", content: "hi" },
                { role: "user", content: "world" },
            ];
            expect(lastUserMessageText(messages)).toBe("world");
        });

        it("joins text parts of a structured content array", () => {
            const messages = [
                { role: "user", content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }] },
            ];
            expect(lastUserMessageText(messages)).toBe("a\nb");
        });

        it("returns null when there is no user message", () => {
            expect(lastUserMessageText([{ role: "assistant", content: "hi" }])).toBeNull();
            expect(lastUserMessageText([])).toBeNull();
        });
    });
});
