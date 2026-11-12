// Junction helpers for git worktrees on Windows. `prepare` shares the heavy build-artifact
// directories (node_modules, src-tauri/target, dist/bin) from the main checkout into the current
// worktree so `task dev` boots there in ~1 min instead of a cold npm+cargo install. `cleanup`
// removes those junction links BEFORE the worktree directory goes — a recursive delete can follow
// a junction and wipe the main checkout's copy through the link, so junction-first ordering is the
// whole point. Only junction links are ever removed; a real directory is left alone with a warning.
// `is-linked <dir>` exits 0 when dir is such a link, so `npm:install` leaves a junctioned node_modules alone:
// npm install there replaces the link with a full install of the worktree's own.
// A worktree whose package-lock.json differs from the main checkout's (a run that adds a dependency) links a shared
// install of its lock instead, made once per lock under NM_CACHE: an install per tree cost ~100 s each, and the
// main checkout's node_modules is the live dev app's, so a branch's lock is never installed there.
// Usage: node scripts/worktree-junctions.mjs prepare|cleanup [worktree-path] | is-linked <dir>
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHARE_DIRS = ["node_modules", "src-tauri/target", "dist/bin"];
const NODE_MODULES = "node_modules";
const LOCK = "package-lock.json";
const INSTALL_FILES = ["package.json", LOCK];
const NM_CACHE = join(process.env.LOCALAPPDATA || join(homedir(), ".cache"), "arc-node-modules");
const DEFAULT_INSTALL = "npm ci --no-audit --no-fund";
const CACHE_KEY_LEN = 16;
const USED_MARK = ".used";
const INSTALLING = ".installing-";
const DAY_MS = 24 * 60 * 60 * 1000;
// an entry no prepare has used for this long goes; a tree still linking it is re-pointed by its next prepare
const UNUSED_MS = 14 * DAY_MS;
// an install dir this old was left by a killed install
const STALE_INSTALL_MS = 60 * 60 * 1000;

function git(args, cwd) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
    }
    return r.stdout.trim();
}

// the first line of `git worktree list` is always the main checkout
function mainCheckout(wtPath) {
    return git(["worktree", "list"], wtPath).split("\n")[0].split(/\s+/)[0];
}

function isJunction(p) {
    try {
        return lstatSync(p).isSymbolicLink();
    } catch {
        return false;
    }
}

function realOrNull(p) {
    try {
        return realpathSync(p);
    } catch {
        return null;
    }
}

function removeLink(p) {
    if (process.platform === "win32") rmdirSync(p);
    else unlinkSync(p);
}

function lockKey(dir) {
    const p = join(dir, LOCK);
    if (!existsSync(p)) return null;
    return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, CACHE_KEY_LEN);
}

function usedAt(entry) {
    try {
        return statSync(join(entry, USED_MARK)).mtimeMs;
    } catch {
        return 0;
    }
}

function pruneCache(cacheRoot, keep) {
    const now = Date.now();
    for (const name of readdirSync(cacheRoot)) {
        if (name === keep) continue;
        const p = join(cacheRoot, name);
        const installing = name.includes(INSTALLING);
        const age = now - (installing ? statSync(p).mtimeMs : usedAt(p));
        if (age > (installing ? STALE_INSTALL_MS : UNUSED_MS)) rmSync(p, { recursive: true, force: true });
    }
}

// installs into a scratch dir renamed into place only once complete, so a failed or killed install never leaves an
// entry a later prepare would link
function installEntry(wtPath, entry, install) {
    const tmp = `${entry}${INSTALLING}${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const f of INSTALL_FILES) {
        if (existsSync(join(wtPath, f))) copyFileSync(join(wtPath, f), join(tmp, f));
    }
    console.log(`${NODE_MODULES}: ${LOCK} differs from the main checkout's; installing it once into ${entry}`);
    const r = spawnSync(install, { cwd: tmp, shell: true, stdio: "inherit" });
    if (r.status !== 0) {
        rmSync(tmp, { recursive: true, force: true });
        throw new Error(`\`${install}\` for ${wtPath}'s ${LOCK} failed (${r.error?.message ?? `exit ${r.status}`})`);
    }
    try {
        renameSync(tmp, entry);
    } catch (e) {
        // another prepare finished the same lock first
        rmSync(tmp, { recursive: true, force: true });
        if (!existsSync(join(entry, NODE_MODULES))) throw e;
    }
}

// the node_modules a worktree links: the main checkout's while their locks match, else the shared install of the
// worktree's lock, made on first use
function nodeModulesTarget(wtPath, main, { cacheRoot, install }) {
    const key = lockKey(wtPath);
    if (key === null || key === lockKey(main)) return join(main, NODE_MODULES);
    const entry = join(cacheRoot, key);
    mkdirSync(cacheRoot, { recursive: true });
    if (!existsSync(join(entry, NODE_MODULES))) installEntry(wtPath, entry, install);
    writeFileSync(join(entry, USED_MARK), "");
    pruneCache(cacheRoot, key);
    return join(entry, NODE_MODULES);
}

export function prepare(cwd, { cacheRoot = NM_CACHE, install = DEFAULT_INSTALL } = {}) {
    // resolve to the git toplevel so running from a subdir (e.g. frontend/) still junctions at the worktree root
    const wtPath = git(["rev-parse", "--show-toplevel"], cwd);
    const main = mainCheckout(wtPath);
    if (resolve(main) === resolve(wtPath)) {
        console.log("this is the main checkout; nothing to junction. run inside a worktree.");
        return;
    }
    for (const rel of SHARE_DIRS) {
        const wtDir = join(wtPath, rel);
        const linked = isJunction(wtDir);
        if (!linked && existsSync(wtDir)) {
            console.warn(`${rel}: exists as a real directory; leaving it alone (delete it first if you want a junction)`);
            continue;
        }
        if (linked && rel !== NODE_MODULES) {
            console.log(`${rel}: already a junction -> ${realOrNull(wtDir) ?? "?"}`);
            continue;
        }
        const target = rel === NODE_MODULES ? nodeModulesTarget(wtPath, main, { cacheRoot, install }) : join(main, rel);
        if (linked) {
            const current = realOrNull(wtDir);
            if (current !== null && current === realOrNull(target)) {
                console.log(`${rel}: already a junction -> ${current}`);
                continue;
            }
            // the lock changed since this link was made, or its shared install was pruned
            removeLink(wtDir);
        }
        if (!existsSync(target)) {
            console.warn(`${rel}: ${target} does not exist; skipping`);
            continue;
        }
        // junction links need their parent dir to exist (e.g. wt/dist for dist/bin)
        mkdirSync(dirname(wtDir), { recursive: true });
        symlinkSync(target, wtDir, "junction");
        console.log(`${rel}: junctioned -> ${target}`);
    }
    console.log("run `task dev`; if the main dev app is already on :9222, use");
    console.log('  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" WEBVIEW2_USER_DATA_FOLDER="$TEMP/wave-wt-profile" task dev');
    console.log("then `CDP_PORT=9223 task verify:ui`.");
}

export function cleanup(wtPath) {
    const main = mainCheckout(wtPath);    // junction links first: removing them is what keeps the main checkout's dirs alive
    for (const rel of SHARE_DIRS) {
        const d = join(wtPath, rel);
        if (!existsSync(d)) continue;
        if (isJunction(d)) {
            rmSync(d, { recursive: true, force: true });
            console.log(`${rel}: junction removed`);
            // sweep the now-empty parent (e.g. dist/) so the worktree dir removes cleanly
            for (let p = dirname(d); resolve(p) !== resolve(wtPath); p = dirname(p)) {
                try {
                    rmdirSync(p);
                } catch {
                    break;
                }
            }
        } else {
            console.warn(`${rel}: real directory, not removing`);
        }
    }
    if (resolve(main) === resolve(wtPath)) return;
    const branch = git(["branch", "--show-current"], wtPath);
    if (!branch) {
        console.error(`worktree ${wtPath} is on detached HEAD; remove it manually`);
        process.exitCode = 1;
        return;
    }
    // run git from the main checkout so the worktree dir is not a process cwd (Windows lock);
    // `git worktree remove` refuses on dirty, `git branch -d` refuses on unmerged — both guard loudly
    const r = spawnSync("git", ["worktree", "remove", wtPath], { cwd: main, encoding: "utf8" });
    if (r.status !== 0) {
        console.error(`git worktree remove failed: ${(r.stderr || r.stdout).trim()}`);
        console.error("likely a Windows file lock from a shell whose cwd is inside the worktree; leave the dir, then remove it from outside (or retry).");
        process.exitCode = 1;
        return;
    }
    console.log(`worktree removed: ${wtPath}`);
    const rb = spawnSync("git", ["branch", "-d", branch], { cwd: main, encoding: "utf8" });
    if (rb.status !== 0) {
        console.warn(`branch not deleted: ${(rb.stderr || rb.stdout).trim()}`);
    } else {
        console.log(`branch deleted: ${branch}`);
    }
}

function isLinked(dir) {
    if (!isJunction(dir)) {
        return false;
    }
    let target = "?";
    try {
        target = realpathSync(dir);
    } catch {}
    console.log(`${dir}: a link to ${target}; not installing over it`);
    return true;
}

function runCli([sub, arg]) {
    if (sub === "prepare") {
        try {
            prepare(process.cwd());
        } catch (e) {
            console.error(`prepare: ${e.message}`);
            process.exitCode = 1;
        }
    } else if (sub === "cleanup") {
        // no path arg: resolve cwd to its git toplevel (cleanup() needs the worktree root, not a subdir)
        cleanup(arg ? resolve(arg) : git(["rev-parse", "--show-toplevel"], process.cwd()));
    } else if (sub === "is-linked" && arg) {
        process.exitCode = isLinked(arg) ? 0 : 1;
    } else {
        console.error("usage: node scripts/worktree-junctions.mjs prepare|cleanup [worktree-path] | is-linked <dir>");
        process.exitCode = 2;
    }
}

// imported by the test for prepare(); run as a script otherwise
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli(process.argv.slice(2));
