import { describe, expect, it } from "vitest";
import { projectLabel } from "./projectlabel";

describe("projectLabel", () => {
    const projects = { "Krypton API": { path: "C:\\Users\\k\\IdeaProjects\\krypton" } };

    it("uses the registry name on a path match", () => {
        expect(projectLabel("C:\\Users\\k\\IdeaProjects\\krypton", projects)).toBe("Krypton API");
    });
    it("falls back to the leaf folder on a miss", () => {
        expect(projectLabel("C:\\Users\\k\\IdeaProjects\\waveterm", projects)).toBe("waveterm");
    });
    it("handles posix paths", () => {
        expect(projectLabel("/home/k/code/foo", {})).toBe("foo");
    });
    it("returns empty for empty cwd", () => {
        expect(projectLabel("", {})).toBe("");
    });
});
