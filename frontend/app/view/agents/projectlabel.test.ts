import { describe, expect, it } from "vitest";
import { channelProjectLabel, dedupeByProject, projectLabel } from "./projectlabel";

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

const ch = (oid: string, projectpath: string, name = ""): Channel => ({ oid, projectpath, name }) as Channel;
const registry = (entries: Record<string, string>): Record<string, ProjectKeywords> =>
    Object.fromEntries(Object.entries(entries).map(([name, path]) => [name, { path }]));

describe("channelProjectLabel", () => {
    it("names the registered project at the channel's path", () => {
        const projects = registry({ waveterm: "/repo/waveterm" });
        expect(channelProjectLabel(ch("c1", "/repo/waveterm", "some-old-name"), projects)).toBe("waveterm");
    });

    it("matches across separator styles, so a Windows channel path still resolves", () => {
        const projects = registry({ waveterm: "C:/Users/k/waveterm" });
        expect(channelProjectLabel(ch("c1", "C:\\Users\\k\\waveterm"), projects)).toBe("waveterm");
    });

    it("ignores a trailing slash on either side", () => {
        expect(channelProjectLabel(ch("c1", "/repo/a/"), registry({ a: "/repo/a" }))).toBe("a");
        expect(channelProjectLabel(ch("c1", "/repo/a"), registry({ a: "/repo/a/" }))).toBe("a");
    });

    it("falls back to the channel's own name when the project is not registered", () => {
        expect(channelProjectLabel(ch("c1", "/repo/gone", "legacy thread"), registry({}))).toBe("legacy thread");
    });

    it("falls back to the oid when there is no name either", () => {
        expect(channelProjectLabel(ch("c1", "", ""), registry({}))).toBe("c1");
    });

    it("is empty for no channel", () => {
        expect(channelProjectLabel(null, registry({ a: "/repo/a" }))).toBe("");
        expect(channelProjectLabel(undefined, registry({ a: "/repo/a" }))).toBe("");
    });
});

describe("dedupeByProject", () => {
    it("keeps one channel per project path, first wins", () => {
        const list = [ch("new", "/repo/a"), ch("old", "/repo/a"), ch("b", "/repo/b")];
        expect(dedupeByProject(list).map((c) => c.oid)).toEqual(["new", "b"]);
    });

    it("collapses duplicates written with different separators", () => {
        const list = [ch("new", "C:/Users/k/w"), ch("old", "C:\\Users\\k\\w")];
        expect(dedupeByProject(list).map((c) => c.oid)).toEqual(["new"]);
    });

    it("keeps every channel that has no project path — they collapse onto nothing", () => {
        const list = [ch("a", ""), ch("b", "")];
        expect(dedupeByProject(list).map((c) => c.oid)).toEqual(["a", "b"]);
    });

    it("preserves input order", () => {
        const list = [ch("b", "/repo/b"), ch("a", "/repo/a")];
        expect(dedupeByProject(list).map((c) => c.oid)).toEqual(["b", "a"]);
    });
});
