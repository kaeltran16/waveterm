import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    buildMemoryFixture,
    indexStats,
    MEMORY_LONG_TOKEN,
    MEMORY_PROJECTS,
    MEMORY_TIGHT_EVIDENCE,
    MEMORY_UNREADABLE_STATE,
    memoryChangeId,
    memoryFileName,
    memoryStatePath,
    settleMemoryStates,
    sha256File,
    writeMemoryStates,
} from "./memory-fixtures.mjs";

const roots = [];
function tempRoot(prefix = "memory-fixtures-test-") {
    const r = mkdtempSync(join(tmpdir(), prefix));
    roots.push(r);
    return r;
}
afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const under = (root, path) => {
    const rel = relative(root, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

// every absolute path a state names: the project, its folders, and each change's files and op targets
function statePaths(state) {
    const out = [state.path, state.folder, state.ownfolder].filter(Boolean);
    for (const c of state.changes) {
        out.push(...c.files.map((f) => f.path));
        const op = c.op;
        out.push(
            ...[op.folder, op.indexfolder, op.tofolder, op.docpath, op.settingspath, op.settingsvalue].filter(Boolean)
        );
    }
    return out;
}

describe("memoryFileName mirrors pkg/memhygiene FileName", () => {
    it("matches the Go test's fixed example", () => {
        expect(memoryFileName("SIEM/a b:c")).toBe("SIEM_a_b_c-5e870e11.json");
    });

    it("keeps names that differ only in unsafe characters apart", () => {
        const names = ["a/b", "a:b", "a b", "a*b"].map(memoryFileName);
        expect(new Set(names).size).toBe(4);
        for (const n of names) expect(n).not.toMatch(/[\\/:*?"<>| ]/);
    });

    it("cuts the stem to 60 characters before the hash", () => {
        expect(memoryFileName("x".repeat(80))).toMatch(/^x{60}-[0-9a-f]{8}\.json$/);
    });
});

describe("buildMemoryFixture", () => {
    it("writes only under its temp root and names no path outside it", () => {
        const root = tempRoot();
        const fx = buildMemoryFixture(root);
        expect(fx.written.length).toBeGreaterThan(0);
        for (const p of fx.written) expect(under(root, p), p).toBe(true);
        for (const { path } of fx.projects) expect(under(root, path), path).toBe(true);
        for (const state of Object.values(fx.states)) {
            for (const p of statePaths(state)) expect(under(root, p), `${state.project}: ${p}`).toBe(true);
        }
        expect(JSON.stringify(fx.states)).not.toContain(join(homedir(), ".claude"));
    }, 30_000);

    it("hashes every file a change names as it is on disk, and ids the change the way the backend does", () => {
        const fx = buildMemoryFixture(tempRoot());
        const changes = Object.values(fx.states).flatMap((s) => s.changes);
        expect(changes.length).toBe(15);
        for (const c of changes) {
            for (const f of c.files) {
                expect(f.sha256, f.path).toBe(sha256File(f.path));
                // "" = must not exist yet
                expect(existsSync(f.path), f.path).toBe(f.sha256 !== "");
            }
            expect(c.id).toBe(memoryChangeId(c.kind, c.files));
        }
        // a changed hash is a different change
        const [first] = changes;
        expect(memoryChangeId(first.kind, [{ ...first.files[0], sha256: "0".repeat(64) }])).not.toBe(first.id);
    }, 30_000);

    it("measures each index the way the backend does", () => {
        const fx = buildMemoryFixture(tempRoot());
        const own = fx.states[MEMORY_PROJECTS.own];
        expect(own.index).toEqual(indexStats(fx.paths.ownIndex));
        expect(own.index).toEqual({ exists: true, lines: 7, bytes: readFileSync(fx.paths.ownIndex).length });
        expect(fx.states[MEMORY_PROJECTS.splitA].ownindex).toEqual({ exists: false, lines: 0, bytes: 0 });
    }, 30_000);

    it("gives the own project five changes and split-a the split's three groups", () => {
        const fx = buildMemoryFixture(tempRoot());
        expect(fx.states[MEMORY_PROJECTS.own].changes.map((c) => c.kind)).toEqual([
            "trim",
            "delete",
            "merge",
            "move-to-doc",
            "add-to-index",
        ]);
        expect(fx.states[MEMORY_PROJECTS.splitA].changes.map((c) => `${c.group}:${c.kind}`)).toEqual([
            "shared:move-here",
            "shared:move-here",
            "shared:copy-here",
            "own:delete",
            "switch:settings",
        ]);
        expect(fx.states[MEMORY_PROJECTS.fresh]).toBeUndefined();
        expect(fx.states[MEMORY_PROJECTS.checking].checking).toBe(true);
    }, 30_000);

    it("gives the setup review steps what they read (D5)", () => {
        const fx = buildMemoryFixture(tempRoot(), 1_000_000_000_000);
        const changes = Object.values(fx.states).flatMap((s) => s.changes);
        // F20: an evidence text runs straight into its code quote
        const tight = changes.flatMap((c) => c.evidence).find((e) => e.code !== "" && !/\s$/.test(e.text));
        expect(tight).toEqual(MEMORY_TIGHT_EVIDENCE);
        // F21: a move-here with the shared folder's and the own folder's MEMORY.md
        const move = fx.splitChanges.moveBuild;
        expect(move.diffs.map((d) => d.path)).toEqual([join(fx.paths.shared, "MEMORY.md"), join(fx.paths.ownA, "MEMORY.md")]);
        // F23: a diff line with an unbroken 120-character token
        expect(MEMORY_LONG_TOKEN).toMatch(/^\S{120}$/);
        const lines = changes.flatMap((c) => c.diffs.flatMap((d) => d.lines.map((l) => l.text)));
        expect(lines.some((t) => t.includes(MEMORY_LONG_TOKEN))).toBe(true);
        expect(readFileSync(fx.paths.harvested, "utf8")).toContain(MEMORY_LONG_TOKEN);
        // F10: an applied change whose backup is past
        expect(fx.expiredChange).toMatchObject({ status: "applied" });
        expect(fx.expiredChange.backupuntil).toBeGreaterThan(0);
        expect(fx.expiredChange.backupuntil).toBeLessThan(1_000_000_000_000);
        expect(fx.states[MEMORY_PROJECTS.expired].changes).toEqual([fx.expiredChange]);
        // F8: a kept-sharing project with a pending shared change
        const kept = fx.states[MEMORY_PROJECTS.kept];
        expect(kept.sharedwith.length).toBeGreaterThan(0);
        expect(kept.changes.map((c) => `${c.group}:${c.kind}:${c.status}`)).toEqual([
            "shared:move-here:open",
            "switch:settings:kept",
        ]);
        // F12: a registered project whose state file is not JSON
        expect(fx.projects.map((p) => p.name)).toContain(MEMORY_PROJECTS.unreadable);
        expect(fx.states[MEMORY_PROJECTS.unreadable]).toBeUndefined();
        expect(() => JSON.parse(fx.brokenStates[MEMORY_PROJECTS.unreadable])).toThrow();
    }, 30_000);

    it("has a trim whose passage occurs once in a crlf file", () => {
        const fx = buildMemoryFixture(tempRoot());
        const text = readFileSync(fx.paths.trim, "utf8");
        expect(text).toContain("\r\n");
        expect(text.split(fx.trim.old).length).toBe(2);
    }, 30_000);
});

describe("writeMemoryStates", () => {
    it("writes each state under <data dir>/memhygiene and nothing else", () => {
        const fx = buildMemoryFixture(tempRoot());
        const dataDir = tempRoot("memory-fixtures-data-");
        const paths = writeMemoryStates(dataDir, fx.states);
        expect(readdirSync(dataDir)).toEqual(["memhygiene"]);
        const names = Object.keys(fx.states);
        expect(readdirSync(join(dataDir, "memhygiene")).sort()).toEqual(names.map(memoryFileName).sort());
        expect(paths).toEqual(names.map((n) => memoryStatePath(dataDir, n)));
        expect(JSON.parse(readFileSync(memoryStatePath(dataDir, MEMORY_PROJECTS.own), "utf8"))).toEqual(
            fx.states[MEMORY_PROJECTS.own]
        );
    }, 30_000);

    it("writes a broken state as is", () => {
        const fx = buildMemoryFixture(tempRoot());
        const dataDir = tempRoot("memory-fixtures-data-");
        writeMemoryStates(dataDir, fx.brokenStates);
        expect(readFileSync(memoryStatePath(dataDir, MEMORY_PROJECTS.unreadable), "utf8")).toBe(MEMORY_UNREADABLE_STATE);
    }, 30_000);
});

describe("settleMemoryStates", () => {
    it("leaves no change to review and keeps decided ones as they were", () => {
        const fx = buildMemoryFixture(tempRoot());
        const settled = settleMemoryStates(fx.states, 1234);
        for (const s of Object.values(settled)) {
            for (const c of s.changes) expect(["applied", "kept"]).toContain(c.status);
        }
        const failed = settled[MEMORY_PROJECTS.failed].changes[0];
        expect(failed).toEqual(fx.states[MEMORY_PROJECTS.failed].changes[0]);
        expect(settled[MEMORY_PROJECTS.own].changes[0].decidedat).toBe(1234);
    }, 30_000);

    it("leaves every project checked with no failure, the unchecked ones included", () => {
        const fx = buildMemoryFixture(tempRoot());
        const settled = settleMemoryStates({ ...fx.states, ...fx.uncheckedStates }, 1234);
        expect(Object.keys(settled).sort()).toEqual(Object.values(MEMORY_PROJECTS).sort());
        for (const s of Object.values(settled)) {
            expect(s.checkedat, s.project).toBeGreaterThan(0);
            expect(s.lasterror, s.project).toBe("");
            expect(s.checking, s.project).toBe(false);
        }
        expect(settled[MEMORY_PROJECTS.own].checkedat).toBe(fx.states[MEMORY_PROJECTS.own].checkedat);
    }, 30_000);
});
