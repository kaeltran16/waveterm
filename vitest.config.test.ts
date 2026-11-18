import { describe, expect, it } from "vitest";
import config, { TEST_EXCLUDES } from "./vitest.config";

describe("Vitest worktree isolation", () => {
    it("excludes Wave runtime worktrees", () => {
        expect(TEST_EXCLUDES).toContain("**/.waveterm/worktrees/**");
    });

    it("excludes the gitignored .superpowers scratch dir", () => {
        expect(TEST_EXCLUDES).toContain("**/.superpowers/**");
    });

    it("gives every test 30 s, the margin a loaded full run needs for tests that spawn git or node", () => {
        expect(config.test?.testTimeout).toBe(30_000);
    });
});
