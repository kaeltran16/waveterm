// This repo's **Final:** command. The engine runs it in the final tree with ARC_FINAL_OUT set: it starts a dev
// app from that tree, runs verify.mjs against it, and copies the shots and contact sheet into ARC_FINAL_OUT, with a
// shots.json manifest at its top.
// A dev app from the main checkout is usually running, so this one shares nothing it uses: its own CDP and Vite
// ports, WebView2 profile, store, cargo target dir and dist/bin, and it installs no global agent hooks or skills.
// Exit 0 passes, verify.mjs's nonzero code fails, and EXIT_UNVERIFIED with the reason as the last stdout line means
// the UI could not be checked at all.
//
//   ARC_FINAL_OUT=<dir> node scripts/cdp/final-verify.mjs [--isolate-claude-config] [scenario...]
//
// --isolate-claude-config gives the dev app CLAUDE_CONFIG_DIR=<store>/claude, so a scenario that switches claude's
// credential writes there and never into the user's real ~/.claude. Without it the env passes through unchanged.
//
// The app starts in two steps: `task dev:prep` builds the backend into the tree's dist/bin, then the slot's exe runs
// against it. A debug exe is tied to the tree it was built in, so cargo rebuilds it for every new tree (~0.5-2.5 min);
// when the slot's exe was built from the same src-tauri and tauri.final.json (its stamp), the stage starts vite and
// that exe directly, pointed at this tree's dist through ARC_DEV_APP_PATH, and cargo never runs.
//
// ARC_FINAL_DEV_CMD (replaces both steps), ARC_FINAL_BOOT_MS (default 10 min, a cold cargo build; it covers both
// steps), ARC_FINAL_VITE_PORT (the first port tried) and ARC_FINAL_LOCK_WAIT_MS (default 10 min) exist so the test
// can drive the boot path without a real app. The lock wait is for a free build slot.
//
// BUILD_SLOTS final stages run at once, each holding one slot: a slot is a cargo target dir, and `cargo tauri dev`
// runs the exe it builds there, so a second stage building into it would overwrite the exe the first is running.
// Those stages run in different trees: a second stage in a tree one already runs in is refused (acquireTreeLock).
//
// The user's packaged Arc shares the dev app's image names, so only the PID this script spawned is ever killed.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attach } from "./attach.mjs";

export const EXIT_UNVERIFIED = 3;

const DEFAULT_PORT = 9230;
const PORT_SCAN = 100;
const DEFAULT_BOOT_MS = 600_000;
const POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 2_000;
// frontend/tauri/vite.config.ts pins the main dev app's vite here; the final one starts past it, so a dev app
// started while this one runs still gets its port
const FIRST_VITE_PORT = 5175;
// the dirs worktree:prepare junctions into the main checkout that a build writes to. node_modules is left: npm
// install replaces its junction with a real dir without touching the main checkout's
const BUILD_JUNCTIONS = ["dist/bin", "src-tauri/target"];
const FINAL_BASE = join(process.env.LOCALAPPDATA || join(homedir(), ".cache"), "arc-final");
// each slot is a target dir outside any checkout that pays one cold cargo build and then stays warm (~4.5 GB each)
export const BUILD_SLOTS = 3;
// keeps the port scans of stages on different slots apart: they pick ports long before anything binds them
const SLOT_PORT_STRIDE = 20;
// the exe `cargo tauri dev` builds into a slot's target dir and runs from there
const DEV_EXE = "wave-tauri.exe";
// beside the slot's exe: the source key it was built from (tauriSourceKey)
const EXE_STAMP = "arc-final-source.sha1";
const PREP_CMD = "task dev:prep";
const STORE_ID_LEN = 8;
// a store's files can stay held for seconds after its dev app is killed; up to 10s before leaving it to the sweep
const STORE_DROP_RETRIES = 20;
const STORE_DROP_RETRY_MS = 500;

// slot 0 keeps the names a checkout's older copy of this script uses, so that copy and this one still exclude each
// other there
function slotPath(name, slot, base = FINAL_BASE) {
    return join(base, slot ? `${name}-${slot}` : name);
}
// where verify.mjs writes its shots, contact sheet and shots.json, relative to the tree it runs in
const SHOTS_DIR = "cdp-shots";
// with the 10 min boot and the verify run, a stage that waited this long still ends inside the engine's 30 min
// FinalTimeout (pkg/orchestrate/final.go)
const DEFAULT_LOCK_WAIT_MS = 600_000;
// how long the app gets to exit by itself once its main window is closed
const CLOSE_EXIT_MS = 15_000;
const STAYED_ALIVE = "the dev app stayed alive after its main window was closed";
// how long the killed dev app gets to report its exit and close its stdin
const RELEASE_MS = 10_000;
const LATE = Symbol("late");
// how long the loop gets to drain after the result before the stage exits anyway
const DRAIN_MS = 15_000;

// the dev app's store. wavesrv binds <store>/data/wave.sock and windows caps a unix socket path at 108 bytes, which
// a store under ARC_FINAL_OUT (itself under %TEMP%) can pass, so it lives under a short path keyed by the out dir
function storeDir(out, slot) {
    return join(slotPath("stores", slot), createHash("sha1").update(out).digest("hex").slice(0, STORE_ID_LEN));
}

// keeps the dev app's log for whoever reads the result, then drops the throwaway store
function dropStore(store, out) {
    // runs in a finally, so a failure here is reported and must not replace the result
    try {
        const log = join(store, "data", "waveapp.log");
        if (existsSync(log)) cpSync(log, join(out, "waveapp.log"));
    } catch (e) {
        console.log(`could not keep the dev app's log from ${store}: ${e.message}`);
    }
    try {
        rmSync(store, { recursive: true, force: true, maxRetries: STORE_DROP_RETRIES, retryDelay: STORE_DROP_RETRY_MS });
    } catch (e) {
        // workers reported the old "could not drop" line as a defect in six runs (09-18..10-12); the sweep makes it harmless
        console.log(`the dev app's store ${store} is still held by a file handle; the next final stage on this slot drops it (${e.code ?? e.message})`);
    }
}

// drops every store under dir, a slot's stores. Called holding that slot, when no other stage is running on it, so each
// one is a stage's that was killed before its finally ran or whose drop hit a file its dev app still held. Best-effort,
// like dropStore.
export function sweepStaleStores(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
        try {
            rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        } catch (e) {
            console.log(`could not drop the stale dev app store ${name}: ${e.message}`);
        }
    }
}

// the os drops a pipe or socket with its process, so a killed stage leaves no stale lock on windows. keyed by the
// base, which is what the stages share
export function buildLockPath(base, slot = 0) {
    const id = createHash("sha1").update(base).digest("hex").slice(0, STORE_ID_LEN) + (slot ? `-${slot}` : "");
    return process.platform === "win32" ? `\\\\.\\pipe\\arc-final-build-${id}` : join(base, `build-${id}.sock`);
}

function listenOn(path) {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.once("error", (e) => (e.code === "EADDRINUSE" ? resolve(null) : reject(e)));
        srv.listen(path, () => resolve(srv));
    });
}

// a posix socket file outlives a killed stage; one nothing answers on is dropped
async function dropStaleSocket(path) {
    if (process.platform === "win32") return;
    const live = await new Promise((resolve) => {
        const sock = connect(path);
        sock.once("connect", () => {
            sock.destroy();
            resolve(true);
        });
        sock.once("error", () => resolve(false));
    });
    if (!live) rmSync(path, { force: true });
}

// a dev app nobody locked the slot for, one started by hand with the slot's target dir (run dca34385) or one that
// outlived its stage, still runs the slot's exe, and cargo fails (exit 201) when it cannot replace it. windows refuses
// to open a running image for writing
function slotExeRunning(base, slot) {
    if (process.platform !== "win32") return false;
    try {
        closeSync(openSync(join(slotPath("target", slot, base), "debug", DEV_EXE), "r+"));
        return false;
    } catch (e) {
        return e.code === "EBUSY";
    }
}

// resolves the first free slot and its held lock (close it to release), or null when other stages kept every slot
// past waitMs
export async function acquireBuildSlot(base, waitMs, slots = BUILD_SLOTS) {
    const deadline = Date.now() + waitMs;
    for (let waited = false; ; waited = true) {
        for (let slot = 0; slot < slots; slot++) {
            const path = buildLockPath(base, slot);
            const lock = await listenOn(path);
            if (lock && !slotExeRunning(base, slot)) return { slot, lock };
            if (lock) {
                if (!waited) console.log(`slot ${slot}'s ${DEV_EXE} is running without a final stage; trying the next slot`);
                await new Promise((r) => lock.close(r));
                continue;
            }
            await dropStaleSocket(path);
        }
        if (Date.now() >= deadline) return null;
        if (!waited) console.log("waiting for another final stage to finish with a build slot");
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}

// one final stage per tree: its scenarios write the tree's public/cockpit-fixtures/active.json and cdp-shots, so a
// second stage there deletes the first's fixture at its teardown and mixes their screenshots. Keyed by the tree alone
export function treeLockPath(base, root) {
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    const id = createHash("sha1").update(key).digest("hex").slice(0, STORE_ID_LEN);
    return process.platform === "win32" ? `\\\\.\\pipe\\arc-final-tree-${id}` : join(base, `tree-${id}.sock`);
}

// resolves the tree's held lock (close it to release), or null while another stage runs in the tree
export async function acquireTreeLock(base, root) {
    const path = treeLockPath(base, root);
    const lock = await listenOn(path);
    if (lock || process.platform === "win32") return lock;
    await dropStaleSocket(path);
    return listenOn(path);
}

export function unverified(reason) {
    console.log(reason);
    process.exit(EXIT_UNVERIFIED);
}

function isFree(port) {
    return new Promise((resolve) => {
        const srv = createServer();
        srv.once("error", () => resolve(false));
        srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
}

export async function pickPort(start = DEFAULT_PORT) {
    for (let port = start; port < start + PORT_SCAN; port++) {
        if (await isFree(port)) return port;
    }
    throw new Error(`no free port in ${start}-${start + PORT_SCAN - 1}`);
}

function accepts(host, port) {
    return new Promise((resolve) => {
        const sock = connect({ host, port, timeout: PROBE_TIMEOUT_MS });
        const done = (ok) => {
            sock.destroy();
            resolve(ok);
        };
        sock.once("connect", () => done(true));
        sock.once("error", () => done(false));
        sock.once("timeout", () => done(false));
    });
}

// vite listens on ::1 only on windows, so a bind probe on 127.0.0.1 would call the port free
export async function inUse(port) {
    const hits = await Promise.all(["127.0.0.1", "::1"].map((host) => accepts(host, port)));
    return hits.some(Boolean);
}

export function killTree(pid) {
    try {
        if (process.platform === "win32") {
            execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        } else {
            process.kill(-pid, "SIGKILL");
        }
    } catch {
        // already gone
    }
}

// kills child's tree and waits for its exit and stdin close, logging a child that never reports them
async function stopChild(child, what, waitMs) {
    const exited = child.exitCode === null && child.signalCode === null ? new Promise((r) => child.once("exit", r)) : null;
    const stdinClosed = !child.stdin || child.stdin.closed ? null : new Promise((r) => child.stdin.once("close", r));
    killTree(child.pid);
    child.stdin?.destroy();
    let timer;
    const late = new Promise((r) => (timer = setTimeout(r, waitMs, LATE)));
    if ((await Promise.race([Promise.all([exited, stdinClosed]), late])) === LATE) {
        console.log(`${what} (pid ${child.pid}) did not report its exit within ${waitMs / 1000}s of being killed`);
    }
    clearTimeout(timer);
}

// kills the dev app and closes what the stage opened for it, awaiting each close: process.exit with a handle still
// closing aborts node on windows (UV_HANDLE_CLOSING, src/win/async.c:76) and turned a passing Final into exit 127.
// Runs in a finally, so a dev app that never reports its exit is logged and left rather than waited on forever
export async function releaseDevApp(dev, lock, log, waitMs = RELEASE_MS) {
    await stopChild(dev, "the dev app", waitMs);
    // a lock already closed calls back with ERR_SERVER_NOT_RUNNING, which is just as released
    await new Promise((r) => lock.close(r));
    closeSync(log);
}

async function answers(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return res.ok;
    } catch {
        return false;
    }
}

// a vite port nothing listens on, on either stack: vite on windows binds ::1 alone
export async function pickVitePort(start = FIRST_VITE_PORT) {
    for (let port = start; port < start + PORT_SCAN; port++) {
        if ((await isFree(port)) && !(await inUse(port))) return port;
    }
    throw new Error(`no free vite port in ${start}-${start + PORT_SCAN - 1}`);
}

function isLink(p) {
    try {
        return lstatSync(p).isSymbolicLink();
    } catch {
        return false;
    }
}

// removes the links alone, never what they point at: a build here must not write into the main checkout, where
// a running dev app uses the binaries
export function unlinkBuildJunctions(root) {
    for (const rel of BUILD_JUNCTIONS) {
        const p = join(root, rel);
        if (!isLink(p)) continue;
        if (process.platform === "win32") rmdirSync(p);
        else unlinkSync(p);
    }
}

// merged over src-tauri/tauri.conf.json by `cargo tauri dev --config`, which pins vite to 5174
function tauriConfig(vitePort) {
    return {
        build: {
            devUrl: `http://localhost:${vitePort}`,
            beforeDevCommand: `npx vite --config frontend/tauri/vite.config.ts --port ${vitePort} --strictPort`,
        },
    };
}

// what a debug exe is built from: src-tauri (untracked files too, so a worker's uncommitted edit counts) and the
// config `cargo tauri dev --config` compiles into it, which carries the vite port
export function tauriSourceKey(root, configText) {
    const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "src-tauri"], { cwd: root, encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        .sort();
    const hash = createHash("sha1").update(configText);
    for (const f of files) {
        const p = join(root, f);
        // tracked but deleted in the working tree
        if (!existsSync(p)) continue;
        hash.update(`\0${f}\0`).update(readFileSync(p));
    }
    return hash.digest("hex");
}

export function exeStampPath(targetDir) {
    return join(targetDir, "debug", EXE_STAMP);
}

// the stamp carries the exe's mtime too: a checkout's older copy of this script builds into slot 0 without touching
// the stamp, and the exe it leaves must not pass for the one the stamp names
function exeStamp(targetDir, key) {
    return `${key} ${statSync(join(targetDir, "debug", DEV_EXE)).mtimeMs}`;
}

export function writeExeStamp(targetDir, key) {
    writeFileSync(exeStampPath(targetDir), exeStamp(targetDir, key));
}

// the slot's exe when it was built from key, else null
export function prebuiltExe(targetDir, key) {
    try {
        return readFileSync(exeStampPath(targetDir), "utf8") === exeStamp(targetDir, key) ? join(targetDir, "debug", DEV_EXE) : null;
    } catch {
        return null;
    }
}

// resolves the child's exit code, or null when it was still running at the deadline
function exitWithin(child, ms) {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), Math.max(ms, 0));
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code ?? 1);
        });
    });
}

// resolves true once vite answers on port, false on the deadline or when it exits first
async function waitForVite(port, vite, deadline) {
    while (Date.now() < deadline && vite.exitCode === null) {
        if (await inUse(port)) return true;
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return false;
}

// resolves true once CDP answers, false on timeout or when the dev app exits first
async function waitForCdp(port, dev, bootMs) {
    const deadline = Date.now() + bootMs;
    while (Date.now() < deadline && dev.exitCode === null) {
        if (await answers(port)) return true;
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return false;
}

// verify.mjs's manifest lists files relative to cdp-shots/; the engine reads them relative to ARC_FINAL_OUT, where
// the copied dir keeps its name. A file's step is keyed by its path, so the keys move with it
export function finalManifest(manifest) {
    const under = (f) => `${SHOTS_DIR}/${f}`;
    return manifest.map((entry) => ({
        ...entry,
        files: entry.files.map(under),
        ...(entry.filesteps
            ? { filesteps: Object.fromEntries(Object.entries(entry.filesteps).map(([f, step]) => [under(f), step])) }
            : {}),
    }));
}

// writes nothing when verify.mjs never wrote its manifest: the engine then lists the pngs itself. A manifest that
// cannot be read is reported and left out the same way, so it never replaces verify's result
export function writeFinalManifest(shotsDir, out) {
    const src = join(shotsDir, "shots.json");
    if (!existsSync(src)) return;
    try {
        const manifest = JSON.parse(readFileSync(src, "utf8"));
        writeFileSync(join(out, "shots.json"), JSON.stringify(finalManifest(manifest), null, 2));
    } catch (e) {
        console.log(`could not write ${join(out, "shots.json")} from ${src}: ${e.message}`);
    }
}

function runVerify(port, scenarios) {
    const script = fileURLToPath(new URL("./verify.mjs", import.meta.url));
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [script, ...scenarios], {
            stdio: "inherit",
            env: { ...process.env, CDP_PORT: String(port) },
        });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
    });
}

// resolves to null when the window took the close, else to why it did not. Nothing in the page can throw out of it,
// so an evaluate that fails is the page dying with its window
const CLOSE_MAIN_EXPR = `(async () => {
    try {
        await window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" });
        return null;
    } catch (e) {
        return String(e?.message ?? e) || "rejected";
    }
})()`;

// closes the main window and waits for the app to exit by itself: the hidden attention-popup's webview is served on
// the same port, so a port that still answers is a host still alive. Resolves { state: "exited" | "alive" }, or
// { state: "unclosed", reason } when the window could not be closed at all
export async function closeMainWindow(port, waitMs = CLOSE_EXIT_MS) {
    let page;
    try {
        // closing needs no rpc client, and a page that never booted must still close at once
        page = await attach(port, { boot: false });
    } catch (e) {
        return { state: "unclosed", reason: `could not close the main window: ${e.message}` };
    }
    let rejection = null;
    // not awaited: the reply may never come, since the page dies with the window
    page.ev(CLOSE_MAIN_EXPR).then(
        (r) => (rejection = r),
        () => {}
    );
    try {
        for (const deadline = Date.now() + waitMs; Date.now() < deadline && !rejection; ) {
            if (!(await answers(port))) return { state: "exited" };
            await new Promise((r) => setTimeout(r, POLL_MS));
        }
    } finally {
        page.close();
    }
    if (rejection) return { state: "unclosed", reason: `could not close the main window: ${rejection}` };
    return { state: "alive" };
}

const ISOLATE_CLAUDE_CONFIG = "--isolate-claude-config";

// the flag goes anywhere among the scenario names and is never passed on to verify.mjs as one
export function parseFinalArgs(argv) {
    return {
        scenarios: argv.filter((a) => a !== ISOLATE_CLAUDE_CONFIG),
        isolateClaudeConfig: argv.includes(ISOLATE_CLAUDE_CONFIG),
    };
}

// the stage's exit code and, when it has one, its last stdout line. `close` is closeMainWindow's result, read only
// when the scenarios passed
export function finalOutcome(verifyCode, close) {
    if (verifyCode !== 0) return { code: verifyCode };
    if (close.state === "exited") return { code: 0 };
    if (close.state === "alive") return { code: 1, line: STAYED_ALIVE };
    return { code: EXIT_UNVERIFIED, line: close.reason };
}

const TIMING_PHASES = [
    ["slot", "slot wait"],
    ["prep", "prep"],
    ["app", "app"],
    ["verify", "verify"],
];

// where a stage's time went, in ms per phase; a phase it never reached is left out. Printed so worker checks and
// Finals can be measured from their transcripts and run logs
export function timingLine(timing) {
    const parts = TIMING_PHASES.filter(([key]) => timing[key] != null).map(
        ([key, label]) => `${label} ${Math.round(timing[key] / 1000)}s`
    );
    return `final-verify timing: ${parts.join(", ")}`;
}

// starts the dev app: ARC_FINAL_DEV_CMD when set, else the build steps, then the slot's exe when it was built from this
// source, else `cargo tauri dev`. Resolves { dev, vite?, stamp?, reason? }: dev is the process whose exit and CDP
// port the stage watches (the build steps' when they failed), stamp the key to record once cargo's exe answers, and
// prepMs how long the build steps took
async function startApp({ start, root, configPath, configText, targetDir, vitePort, port, deadline }) {
    const override = process.env.ARC_FINAL_DEV_CMD;
    if (override) {
        console.log(`starting \`${override}\` on :${port}, vite :${vitePort}`);
        return { dev: start(override) };
    }
    console.log(`building with \`${PREP_CMD}\``);
    const prepStart = Date.now();
    const prep = start(PREP_CMD);
    const prepCode = await exitWithin(prep, deadline - Date.now());
    const prepMs = Date.now() - prepStart;
    if (prepCode === null) return { dev: prep, prepMs, reason: `\`${PREP_CMD}\` did not finish within the boot budget` };
    if (prepCode !== 0) return { dev: prep, prepMs, reason: `\`${PREP_CMD}\` exited with code ${prepCode}` };

    const key = tauriSourceKey(root, configText);
    const exe = prebuiltExe(targetDir, key);
    if (!exe) {
        // cleared first: until the new exe answers, the slot's exe may be neither the old source nor this one
        rmSync(exeStampPath(targetDir), { force: true });
        const cmd = `npm run dev -- --config "${configPath}"`;
        console.log(`starting \`${cmd}\` on :${port}, vite :${vitePort}`);
        return { dev: start(cmd), stamp: key, prepMs };
    }
    console.log(`reusing ${exe}, built from this src-tauri: no cargo build. cdp :${port}, vite :${vitePort}`);
    const vite = start(tauriConfig(vitePort).build.beforeDevCommand);
    if (!(await waitForVite(vitePort, vite, deadline))) return { dev: vite, prepMs, reason: `vite did not answer on :${vitePort}` };
    // cargo tauri dev runs it from src-tauri
    return { dev: start(exe, { shell: false, cwd: join(root, "src-tauri") }), vite, prepMs };
}

async function main() {
    const out = process.env.ARC_FINAL_OUT;
    if (!out) unverified("ARC_FINAL_OUT is not set");
    const { scenarios, isolateClaudeConfig } = parseFinalArgs(process.argv.slice(2));
    const bootMs = Number(process.env.ARC_FINAL_BOOT_MS) || DEFAULT_BOOT_MS;
    const lockWaitMs = Number(process.env.ARC_FINAL_LOCK_WAIT_MS) || DEFAULT_LOCK_WAIT_MS;
    mkdirSync(FINAL_BASE, { recursive: true });
    const root = process.cwd();
    // refused, not waited for: two stages in one tree are a caller's mistake, and the second would only redo the first
    const treeLock = await acquireTreeLock(FINAL_BASE, root);
    if (!treeLock) unverified(`another final-verify is running in ${root}; run one at a time per tree`);
    const slotStart = Date.now();
    const held = await acquireBuildSlot(FINAL_BASE, lockWaitMs);
    if (!held) unverified(`other final stages held every build slot for ${Math.round(lockWaitMs / 1000)}s`);
    const timing = { slot: Date.now() - slotStart };
    const { slot, lock } = held;
    // two stages started together would otherwise pick the same free ports
    const portOffset = slot * SLOT_PORT_STRIDE;
    const vitePort = await pickVitePort((Number(process.env.ARC_FINAL_VITE_PORT) || FIRST_VITE_PORT) + portOffset);
    mkdirSync(out, { recursive: true });
    const configPath = join(out, "tauri.final.json");
    const configText = JSON.stringify(tauriConfig(vitePort), null, 2);
    writeFileSync(configPath, configText);
    unlinkBuildJunctions(root);
    const store = storeDir(out, slot);
    sweepStaleStores(slotPath("stores", slot));
    // the vault otherwise defaults to ~/.waveterm/vault, shared by every dev app on the machine: parallel stages
    // collided there on the initiatives a Jira scenario holds on a board key. Inside the store, it goes with it.
    const storeConfig = join(store, "config");
    mkdirSync(storeConfig, { recursive: true });
    writeFileSync(join(storeConfig, "settings.json"), JSON.stringify({ "memory:vaultpath": join(store, "vault") }));

    const port = await pickPort(DEFAULT_PORT + portOffset);
    // inside the store, so it goes with it: nothing reads it after the run, and kept in ARC_FINAL_OUT it was ~76 MB
    // a round for the 30 days the engine keeps that dir
    const profile = join(store, "webview2-profile");
    mkdirSync(profile, { recursive: true });
    const claudeEnv = {};
    if (isolateClaudeConfig) {
        claudeEnv.CLAUDE_CONFIG_DIR = join(store, "claude");
        mkdirSync(claudeEnv.CLAUDE_CONFIG_DIR, { recursive: true });
    }
    // the dev app's output goes to a file so the last stdout line stays ours for the engine to read
    const logPath = join(out, "dev-app.log");
    const log = openSync(logPath, "a");
    console.log(`dev app log: ${logPath}`);
    const targetDir = slotPath("target", slot);
    const env = {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
        WEBVIEW2_USER_DATA_FOLDER: profile,
        CARGO_TARGET_DIR: targetDir,
        // read by frontend/tauri/vite.config.ts
        ARC_VITE_CACHE_DIR: slotPath("vite", slot),
        // read by a debug build of the dev host (src-tauri/src/paths.rs) and by sync:piartifacts
        ARC_DEV_DATA_DIR: store,
        ARC_DEV_NO_GLOBAL_INSTALL: "1",
        // read by a debug build of the dev host: the slot's exe may have been built in another tree
        ARC_DEV_APP_PATH: join(root, "dist"),
        // what Taskfile's tauri:dev sets for the app
        WAVETERM_ENVFILE: join(root, ".env"),
        WAVETERM_NOCONFIRMQUIT: "1",
        ...claudeEnv,
    };
    // every process the stage started, so a signal stops them all
    const started = [];
    // stdin stays an open pipe for the app: `task dev` exits when its stdin closes
    const start = (cmd, opts = {}) => {
        const child = spawn(cmd, { shell: true, cwd: root, detached: process.platform !== "win32", stdio: ["pipe", log, log], env, ...opts });
        started.push(child);
        return child;
    };
    for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, () => {
            for (const child of started) killTree(child.pid);
            lock.close();
            process.exit(1);
        });
    }

    const deadline = Date.now() + bootMs;
    let code;
    let reason;
    let close;
    let app;
    const bootStart = Date.now();
    try {
        app = await startApp({ start, root, configPath, configText, targetDir, vitePort, port, deadline });
        timing.prep = app.prepMs;
        reason = app.reason;
        const answered = !reason && (await waitForCdp(port, app.dev, deadline - Date.now()));
        if (!reason) timing.app = Date.now() - bootStart - (app.prepMs ?? 0);
        if (!reason && !answered) {
            reason =
                app.dev.exitCode === null
                    ? `dev app did not answer on :${port}`
                    : `dev app exited with code ${app.dev.exitCode} before answering on :${port}`;
        } else if (!reason) {
            // answering, so cargo finished building the exe from this source
            if (app.stamp) writeExeStamp(targetDir, app.stamp);
            const verifyStart = Date.now();
            code = await runVerify(port, scenarios);
            timing.verify = Date.now() - verifyStart;
            if (existsSync(SHOTS_DIR)) {
                cpSync(SHOTS_DIR, join(out, SHOTS_DIR), { recursive: true });
                writeFinalManifest(SHOTS_DIR, out);
            }
            // on a failed run too: a killed app's WebView2 profile stayed held past the store drop's retries
            // (EPERM), while one that exits by itself lets go of it
            close = await closeMainWindow(port);
        }
    } finally {
        if (app?.vite) await stopChild(app.vite, "vite", RELEASE_MS);
        if (app?.dev) await releaseDevApp(app.dev, lock, log);
        else {
            // startApp threw: whatever it had started is past waiting on
            for (const child of started) killTree(child.pid);
            await new Promise((r) => lock.close(r));
            closeSync(log);
        }
        dropStore(store, out);
        await new Promise((r) => treeLock.close(r));
    }
    const outcome = reason ? { code: EXIT_UNVERIFIED, line: reason } : finalOutcome(code, close);
    // before the outcome line: the engine reads the last stdout line as the unverified reason
    console.log(timingLine(timing));
    if (outcome.line) console.log(outcome.line);
    // not process.exit: the loop drains by itself now that the stage let go of everything
    process.exitCode = outcome.code;
    setTimeout(() => {
        console.error(`final-verify: still holding ${process.getActiveResourcesInfo().join(", ")} ${DRAIN_MS / 1000}s after its result; exiting`);
        process.exit();
    }, DRAIN_MS).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => unverified(`final-verify: ${e?.message ?? e}`));
}
