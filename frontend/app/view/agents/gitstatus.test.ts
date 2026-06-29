// frontend/app/view/agents/gitstatus.test.ts
import { describe, expect, it } from "vitest";
import { capFiles, parseGitChanges } from "./gitstatus";

const NUL = "\0";

describe("parseGitChanges", () => {
    it("joins porcelain status with numstat adds/dels", () => {
        const statusZ = ` M src/auth.ts${NUL}A  src/redis.ts${NUL}`;
        const numstat = "3\t1\tsrc/auth.ts\n9\t0\tsrc/redis.ts\n";
        const r = parseGitChanges(statusZ, numstat);
        expect(r.files).toEqual([
            { path: "src/auth.ts", status: "M", adds: 3, dels: 1 },
            { path: "src/redis.ts", status: "A", adds: 9, dels: 0 },
        ]);
        expect(r.adds).toBe(12);
        expect(r.dels).toBe(1);
    });

    it("maps untracked (??) to '?' with zero counts", () => {
        const r = parseGitChanges(`?? notes.md${NUL}`, "");
        expect(r.files).toEqual([{ path: "notes.md", status: "?", adds: 0, dels: 0 }]);
    });

    it("handles deleted files", () => {
        const r = parseGitChanges(` D old.ts${NUL}`, "0\t4\told.ts\n");
        expect(r.files[0]).toEqual({ path: "old.ts", status: "D", adds: 0, dels: 4 });
    });

    it("skips the rename source field and uses the new path", () => {
        const statusZ = `R  new.ts${NUL}old.ts${NUL}`;
        const r = parseGitChanges(statusZ, "0\t0\tnew.ts\n");
        expect(r.files).toEqual([{ path: "new.ts", status: "R", adds: 0, dels: 0 }]);
    });

    it("treats binary numstat (-/-) as zero counts", () => {
        const r = parseGitChanges(` M logo.png${NUL}`, "-\t-\tlogo.png\n");
        expect(r.files[0]).toEqual({ path: "logo.png", status: "M", adds: 0, dels: 0 });
    });

    it("returns empty for a clean tree", () => {
        expect(parseGitChanges("", "")).toEqual({ files: [], adds: 0, dels: 0 });
    });
});

describe("capFiles", () => {
    const mk = (path: string) => ({ path, status: "M", adds: 0, dels: 0 });

    it("returns all files and more=0 when at or under the cap", () => {
        const files = [mk("a.ts"), mk("b.ts")];
        expect(capFiles(files, 8)).toEqual({ shown: files, more: 0 });
    });

    it("truncates to the cap and reports the remainder", () => {
        const files = Array.from({ length: 11 }, (_, i) => mk(`f${i}.ts`));
        const r = capFiles(files, 8);
        expect(r.shown).toHaveLength(8);
        expect(r.shown[0].path).toBe("f0.ts");
        expect(r.more).toBe(3);
    });

    it("handles an empty list", () => {
        expect(capFiles([], 8)).toEqual({ shown: [], more: 0 });
    });
});
