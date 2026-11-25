import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    MEMORY_DID_WINDOW_MS,
    MEMORY_PROJECTS,
    buildMemoryFixture,
    indexStats,
    memoryBackupDir,
    memoryBackupsUnder,
    memoryChangeId,
    memoryFileName,
    memoryStatePath,
    settleMemoryStates,
    sha256File,
    writeMemoryBackups,
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

const NOW = 1_800_000_000_000;

const under = (root, path) => {
    const rel = relative(root, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

// every absolute path a state names: the project, its folders, and each change's files and op targets
function statePaths(state) {
    const out = [state.path, state.folder, state.ownfolder, state.formershared].filter(Boolean);
    for (const c of state.changes) {
        out.push(...c.files.map((f) => f.path));
        const op = c.op;
        out.push(
            ...[op.folder, op.indexfolder, op.tofolder, op.docpath, op.settingspath, op.settingsvalue].filter(Boolean)
        );
    }
    return out;
}

const pending = (c) => c.status !== "applied" && c.status !== "kept";
const allChanges = (fx) => Object.values(fx.states).flatMap((s) => s.changes);
const mdNames = (folder) => readdirSync(folder).filter((n) => n.endsWith(".md") && n !== "MEMORY.md");

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
        const fx = buildMemoryFixture(root, NOW);
        expect(fx.written.length).toBeGreaterThan(0);
        for (const p of fx.written) expect(under(root, p), p).toBe(true);
        for (const { path } of fx.projects) expect(under(root, path), path).toBe(true);
        for (const state of Object.values(fx.states)) {
            for (const p of statePaths(state)) expect(under(root, p), `${state.project}: ${p}`).toBe(true);
        }
        for (const b of fx.backups) {
            for (const f of b.manifest.files) expect(under(root, f.path), f.path).toBe(true);
        }
        expect(JSON.stringify(fx.states)).not.toContain(join(homedir(), ".claude"));
    }, 30_000);

    it("hashes every undecided change's files as they are on disk, and ids each change the way the backend does", () => {
        const fx = buildMemoryFixture(tempRoot(), NOW);
        const open = allChanges(fx).filter((c) => c.status === "open");
        expect(open.length).toBeGreaterThan(60);
        for (const c of open) {
            for (const f of c.files) {
                expect(f.sha256, f.path).toBe(sha256File(f.path));
                // "" = must not exist yet
                expect(existsSync(f.path), f.path).toBe(f.sha256 !== "");
            }
        }
        for (const c of allChanges(fx)) expect(c.id).toBe(memoryChangeId(c.kind, c.files));
        // a changed hash is a different change
        const [first] = open;
        expect(memoryChangeId(first.kind, [{ ...first.files[0], sha256: "0".repeat(64) }])).not.toBe(first.id);
    }, 30_000);

    it("gives each sharing state a sort entry with its sha256 for every memory in the shared folder", () => {
        const fx = buildMemoryFixture(tempRoot(), NOW);
        const sharing = Object.values(fx.states).filter((s) => s.sharedwith.length > 0);
        expect(sharing.map((s) => s.project).sort()).toEqual([MEMORY_PROJECTS.splitA, MEMORY_PROJECTS.splitB]);
        const names = mdNames(fx.paths.shared);
        expect(names.length).toBe(fx.states[MEMORY_PROJECTS.splitA].memories);
        for (const s of sharing) {
            expect(Object.keys(s.sort).sort(), s.project).toEqual([...names].sort());
            for (const n of names) expect(s.sort[n].sha256, `${s.project}: ${n}`).toBe(sha256File(join(fx.paths.shared, n)));
        }
    }, 30_000);

    it("rebuilt in the same root, drops what an earlier apply left and gives the same changes", () => {
        const root = tempRoot();
        const first = buildMemoryFixture(root, NOW);
        const settings = first.splitA.settings.op.settingspath;
        mkdirSync(join(settings, ".."), { recursive: true });
        writeFileSync(settings, "{}");
        writeFileSync(join(first.paths.ownA, "copied.md"), "left by an apply");
        writeFileSync(join(first.paths.shared, "written-later.md"), "unsorted");
        const again = buildMemoryFixture(root, NOW);
        expect(existsSync(settings)).toBe(false);
        expect(existsSync(join(first.paths.ownA, "copied.md"))).toBe(false);
        expect(existsSync(join(first.paths.shared, "written-later.md"))).toBe(false);
        expect(allChanges(again).map((c) => c.id)).toEqual(allChanges(first).map((c) => c.id));
    }, 30_000);

    it("backs up each routine change the way Apply does, so Undo finds no conflict and restores the original", () => {
        const fx = buildMemoryFixture(tempRoot(), NOW);
        const own = fx.states[MEMORY_PROJECTS.own];
        const batch = own.batches.find((b) => b.id === fx.batches.ownRoutine);
        const byApplyId = new Map(fx.backups.map((b) => [b.id, b]));
        for (const id of batch.changeids) {
            const c = own.changes.find((x) => x.id === id);
            expect(c.status).toBe("applied");
            const backup = byApplyId.get(c.applyid);
            expect(backup, c.title).toBeDefined();
            for (const [i, f] of backup.manifest.files.entries()) {
                expect(f.post, f.path).toBe(sha256File(f.path));
                const saved = backup.files.find((x) => x.rel === f.backup);
                expect(f.backup).toBe(join("files", String(i)));
                expect(sha256File(f.path) === f.pre).toBe(false);
                expect(createHash("sha256").update(saved.data).digest("hex")).toBe(f.pre);
            }
        }
    }, 30_000);

    it("measures each index the way the backend does", () => {
        const fx = buildMemoryFixture(tempRoot(), NOW);
        const own = fx.states[MEMORY_PROJECTS.own];
        expect(own.index).toEqual(indexStats(fx.paths.ownIndex));
        expect(own.index.exists).toBe(true);
        expect(fx.states[MEMORY_PROJECTS.splitA].index).toEqual(indexStats(join(fx.paths.shared, "MEMORY.md")));
        expect(fx.states[MEMORY_PROJECTS.splitA].ownindex).toEqual({ exists: false, lines: 0, bytes: 0 });
    }, 30_000);

    it("gives every board its state", () => {
        const fx = buildMemoryFixture(tempRoot(), NOW);
        const s = fx.states;
        // three projects on one shared folder: two splits waiting, one switched
        for (const name of [MEMORY_PROJECTS.splitA, MEMORY_PROJECTS.splitB]) {
            expect(s[name].folder).toBe(fx.paths.shared);
            expect(s[name].changes.find((c) => c.kind === "settings").status).toBe("open");
        }
        expect(s[MEMORY_PROJECTS.splitC].formershared).toBe(fx.paths.shared);
        expect(s[MEMORY_PROJECTS.splitC].changes.find((c) => c.kind === "settings").status).toBe("applied");
        // the big split: enough changes for its Apply's progress to be caught, moves before copies
        const shared = s[MEMORY_PROJECTS.splitA].changes.filter((c) => c.group === "shared");
        expect(shared.length).toBeGreaterThanOrEqual(40);
        expect(shared.findIndex((c) => c.kind === "copy-here")).toBeGreaterThan(fx.splitA.failAt);
        // the former-shared project: open removals, two open doc moves, a failed check
        const former = s[MEMORY_PROJECTS.former];
        expect(former.formershared).toBe(fx.paths.shared);
        expect(former.changes.filter((c) => c.kind === "remove-shared" && c.status === "open").length).toBeGreaterThan(0);
        expect(former.changes.filter((c) => c.kind === "move-to-doc" && c.status === "open").length).toBe(2);
        expect(former.lasterror).toBe("Check interrupted by a restart");
        // its applied cleanup removed a memory split-c's switched split copied: that split's Undo is refused
        const cleanup = former.batches.find((b) => b.id === fx.batches.formerCleanup);
        const removed = former.changes.filter((c) => cleanup.changeids.includes(c.id)).map((c) => join(c.op.folder, c.op.memories[0]));
        const split = s[MEMORY_PROJECTS.splitC].batches.find((b) => b.id === fx.batches.splitC);
        const copied = s[MEMORY_PROJECTS.splitC].changes
            .filter((c) => split.changeids.includes(c.id) && c.kind === "copy-here" && c.status === "applied")
            .map((c) => join(c.op.folder, c.op.memories[0]));
        expect(removed.some((p) => copied.includes(p))).toBe(true);
        expect(cleanup.at).toBeGreaterThan(split.at);
        // routine batches inside and outside the week, with skips
        const routine = Object.values(s).flatMap((st) => (st.batches ?? []).filter((b) => b.kind === "routine"));
        expect(routine.some((b) => b.at >= NOW - MEMORY_DID_WINDOW_MS && b.skipped.length > 0)).toBe(true);
        expect(routine.some((b) => b.at < NOW - MEMORY_DID_WINDOW_MS)).toBe(true);
    }, 30_000);
});

describe("writeMemoryStates", () => {
    it("writes each state under <data dir>/memhygiene and nothing else", () => {
        const fx = buildMemoryFixture(tempRoot(), NOW);
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
});

describe("memory backups", () => {
    it("writes each backup's manifest and files, and finds only the backups of files under a root", () => {
        const root = tempRoot();
        const fx = buildMemoryFixture(root, NOW);
        const dataDir = tempRoot("memory-fixtures-data-");
        writeMemoryBackups(dataDir, fx.backups);
        const [b] = fx.backups;
        expect(JSON.parse(readFileSync(join(memoryBackupDir(dataDir, b.id), "manifest.json"), "utf8"))).toEqual(b.manifest);
        expect(readFileSync(join(memoryBackupDir(dataDir, b.id), b.files[0].rel), "utf8")).toBe(b.files[0].data);
        // a backup of the user's own files is not the fixture's
        writeMemoryBackups(dataDir, [
            { id: "theirs", manifest: { ...b.manifest, applyid: "theirs", files: [{ ...b.manifest.files[0], path: join(tempRoot(), "x.md") }] }, files: [] },
        ]);
        expect(memoryBackupsUnder(dataDir, root).sort()).toEqual(fx.backups.map((x) => x.id).sort());
        expect(memoryBackupsUnder(tempRoot("memory-fixtures-empty-"), root)).toEqual([]);
    }, 30_000);
});

describe("settleMemoryStates", () => {
    it("leaves nothing waiting: every undecided change kept, no failed check, decided ones as they were", () => {
        const fx = buildMemoryFixture(tempRoot(), NOW);
        const settled = settleMemoryStates(fx.states, 1234);
        for (const s of Object.values(settled)) {
            expect(s.lasterror, s.project).toBe("");
            for (const c of s.changes) expect(pending(c), `${s.project}: ${c.title}`).toBe(false);
        }
        const applied = fx.states[MEMORY_PROJECTS.own].changes.find((c) => c.status === "applied");
        expect(settled[MEMORY_PROJECTS.own].changes.find((c) => c.id === applied.id)).toEqual(applied);
        expect(settled[MEMORY_PROJECTS.splitA].batches).toEqual(fx.states[MEMORY_PROJECTS.splitA].batches);
    }, 30_000);
});
