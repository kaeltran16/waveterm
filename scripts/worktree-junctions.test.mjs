import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepare } from "./worktree-junctions.mjs";

const script = fileURLToPath(new URL("./worktree-junctions.mjs", import.meta.url));

function isLinked(dir) {
    return spawnSync(process.execPath, [script, "is-linked", dir], { encoding: "utf8" });
}

// npm:install runs `is-linked node_modules || npm install`, so exit 0 is what skips the install
describe("is-linked", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-junctions-"));
    const main = join(root, "main-node_modules");
    mkdirSync(main);
    // rm unlinks a junction rather than following it
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it("exits 0 for a junction to another checkout's node_modules", () => {
        const link = join(root, "linked");
        symlinkSync(main, link, "junction");
        const r = isLinked(link);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("not installing over it");
    });

    it("exits 1 for a real node_modules, so a checkout's install runs", () => {
        const real = join(root, "real");
        mkdirSync(real);
        expect(isLinked(real).status).toBe(1);
    });

    it("exits 1 when node_modules does not exist yet", () => {
        expect(isLinked(join(root, "missing")).status).toBe(1);
    });
});

function gitIn(cwd, ...args) {
    const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

describe("prepare: node_modules", () => {
    let root, main, cache, counter, install;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "wt-prepare-"));
        main = join(root, "main");
        cache = join(root, "cache");
        counter = join(root, "installs.log");
        // stands in for npm ci: makes the install's node_modules and counts the runs
        install = `node -e "require('fs').mkdirSync('node_modules/pkg',{recursive:true});require('fs').appendFileSync(process.argv[1],'x')" "${counter}"`;
        mkdirSync(join(main, "node_modules"), { recursive: true });
        writeFileSync(join(main, "package.json"), "{}");
        writeFileSync(join(main, "package-lock.json"), "v1");
        writeFileSync(join(main, ".gitignore"), "node_modules\n");
        gitIn(main, "init", "-q");
        gitIn(main, "add", ".");
        gitIn(main, "commit", "-q", "-m", "init");
    });
    // rm unlinks a junction rather than following it
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    function worktree(name, lock) {
        const wt = join(root, name);
        gitIn(main, "worktree", "add", "-q", "-b", name, wt);
        if (lock) writeFileSync(join(wt, "package-lock.json"), lock);
        return wt;
    }
    const installs = () => (existsSync(counter) ? readFileSync(counter, "utf8").length : 0);
    const linkOf = (wt) => realpathSync(join(wt, "node_modules"));

    it("links the main checkout's node_modules while the locks match", () => {
        const wt = worktree("same");
        prepare(wt, { cacheRoot: cache, install });
        expect(linkOf(wt)).toBe(realpathSync(join(main, "node_modules")));
        expect(installs()).toBe(0);
    });

    it("installs a changed lock once and links every tree with that lock to it", () => {
        const a = worktree("a", "v2");
        const b = worktree("b", "v2");
        prepare(a, { cacheRoot: cache, install });
        prepare(b, { cacheRoot: cache, install });
        expect(installs()).toBe(1);
        expect(linkOf(b)).toBe(linkOf(a));
        expect(linkOf(a)).not.toBe(realpathSync(join(main, "node_modules")));
        expect(existsSync(join(a, "node_modules", "pkg"))).toBe(true);
    });

    it("leaves no shared install and no link when the install fails", () => {
        const wt = worktree("bad", "v3");
        expect(() => prepare(wt, { cacheRoot: cache, install: `node -e "process.exit(3)"` })).toThrow(/exit 3/);
        expect(readdirSync(cache)).toEqual([]);
        expect(existsSync(join(wt, "node_modules"))).toBe(false);
    });

    it("re-points a link made before the tree's lock changed", () => {
        const wt = worktree("later");
        prepare(wt, { cacheRoot: cache, install });
        writeFileSync(join(wt, "package-lock.json"), "v4");
        prepare(wt, { cacheRoot: cache, install });
        expect(installs()).toBe(1);
        expect(linkOf(wt)).not.toBe(realpathSync(join(main, "node_modules")));
        expect(existsSync(join(wt, "node_modules", "pkg"))).toBe(true);
    });
});
