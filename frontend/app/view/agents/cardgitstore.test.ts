import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diffStatsByIdAtom, diffStatsFromChanges, refreshCardGit, sharedCheckoutCount } from "./cardgitstore";
import type { GitChanges } from "./gitstatus";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { GitChangesCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("./agentcwdresolve", () => ({ resolveCwd: vi.fn(async () => "C:/src/demo") }));
vi.mock("./agentsessionstore", () => ({ ensureSessionStart: vi.fn(async () => null) }));

describe("refreshCardGit", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        globalStore.set(diffStatsByIdAtom, {});
    });

    it("logs a failed read and leaves no stats for the id", async () => {
        globalStore.set(diffStatsByIdAtom, { a1: { files: 3, adds: 4, dels: 5 } });
        vi.mocked(RpcApi.GitChangesCommand).mockRejectedValueOnce(new Error("git exploded"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await refreshCardGit("a1", "t.jsonl");
        expect("a1" in globalStore.get(diffStatsByIdAtom)).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain("a1");
        expect(warn.mock.calls[0]).toContainEqual(expect.objectContaining({ message: "git exploded" }));
    });
});

describe("diffStatsFromChanges", () => {
    it("counts files from the change list and passes through add/del totals", () => {
        const ch: GitChanges = {
            files: [
                { path: "a.ts", status: "M", adds: 3, dels: 1 },
                { path: "b.ts", status: "A", adds: 10, dels: 0 },
            ],
            adds: 13,
            dels: 1,
        };
        expect(diffStatsFromChanges(ch)).toEqual({ files: 2, adds: 13, dels: 1 });
    });

    it("is zero across the board for a clean repo", () => {
        expect(diffStatsFromChanges({ files: [], adds: 0, dels: 0 })).toEqual({ files: 0, adds: 0, dels: 0 });
    });
});

describe("sharedCheckoutCount", () => {
    it("counts every card in the same checkout, this one included", () => {
        const cwd = { a: "C:/src/demo", b: "C:/src/demo", c: "C:/src/other" };
        expect(sharedCheckoutCount("a", cwd)).toBe(2);
        expect(sharedCheckoutCount("c", cwd)).toBe(1);
    });

    it("does not share across worktrees of one repo", () => {
        const cwd = { a: "C:/src/demo", b: "C:/src/demo-wt/feature", c: "C:/src/demo/.worktrees/x" };
        expect(sharedCheckoutCount("a", cwd)).toBe(1);
        expect(sharedCheckoutCount("b", cwd)).toBe(1);
    });

    it("matches case, slash and trailing-separator variants of one path", () => {
        const cwd = { a: "C:\\Src\\Demo\\", b: "c:/src/demo", c: "C:/SRC/DEMO/" };
        expect(sharedCheckoutCount("a", cwd)).toBe(3);
    });

    it("is 1 for a lone card and 0 for a card with no resolved cwd", () => {
        expect(sharedCheckoutCount("a", { a: "C:/src/demo" })).toBe(1);
        expect(sharedCheckoutCount("z", { a: "C:/src/demo" })).toBe(0);
    });
});
