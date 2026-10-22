import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
    BUILD_SLOTS,
    EXIT_UNVERIFIED,
    acquireBuildSlot,
    buildLockPath,
    closeMainWindow,
    finalManifest,
    finalOutcome,
    inUse,
    pickPort,
    pickVitePort,
    sweepStaleStores,
    unlinkBuildJunctions,
    writeFinalManifest,
} from "./final-verify.mjs";

const SCRIPT = fileURLToPath(new URL("./final-verify.mjs", import.meta.url));

function listen(port, host = "127.0.0.1") {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.once("error", reject);
        srv.listen(port, host, () => resolve(srv));
    });
}

async function freePort() {
    const probe = await listen(0);
    const port = probe.address().port;
    await close(probe);
    return port;
}

const close = (srv) => new Promise((r) => srv.close(r));

// spawn the real CLI: the engine only sees the exit code and the last stdout line
function run(env) {
    return new Promise((resolve) => {
        execFile(process.execPath, [SCRIPT], { env, timeout: 30_000 }, (err, stdout) => {
            const lines = stdout.trim().split(/\r?\n/);
            resolve({ code: err ? err.code : 0, killed: Boolean(err?.killed), last: lines[lines.length - 1] });
        });
    });
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe("pickPort", () => {
    it("skips a port another process holds", async () => {
        const held = await listen(0);
        const port = held.address().port;
        try {
            expect(await pickPort(port)).toBeGreaterThan(port);
        } finally {
            await close(held);
        }
    });

    it("returns the start port when it is free", async () => {
        const probe = await listen(0);
        const port = probe.address().port;
        await close(probe);
        expect(await pickPort(port)).toBe(port);
    });
});

describe("inUse", () => {
    // vite on windows listens on ::1 alone
    it.each(["127.0.0.1", "::1"])("sees a listener on %s", async (host) => {
        const held = await listen(0, host);
        try {
            expect(await inUse(held.address().port)).toBe(true);
        } finally {
            await close(held);
        }
    });

    it("is false for a port nobody listens on", async () => {
        expect(await inUse(await freePort())).toBe(false);
    });
});

// each test points LOCALAPPDATA at its own dir, so it never shares the build lock or a store with a real final stage
describe("final-verify.mjs", () => {
    let dir;
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    it("is unverified when ARC_FINAL_OUT is not set", async () => {
        const env = { ...process.env };
        delete env.ARC_FINAL_OUT;
        const r = await run(env);
        expect(r.code).toBe(EXIT_UNVERIFIED);
        expect(r.last).toBe("ARC_FINAL_OUT is not set");
    });

    it("is unverified when the dev app never answers CDP, and stops the process it started", async () => {
        dir = mkdtempSync(join(tmpdir(), "final-verify-"));
        const pidFile = join(dir, "dev.pid");
        const fakeDev = join(dir, "fake-dev.cjs");
        writeFileSync(fakeDev, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);

        const r = await run({
            ...process.env,
            LOCALAPPDATA: join(dir, "localappdata"),
            ARC_FINAL_OUT: join(dir, "out"),
            ARC_FINAL_BOOT_MS: "3000",
            ARC_FINAL_DEV_CMD: `node "${fakeDev}"`,
            ARC_FINAL_VITE_PORT: String(await freePort()),
        });

        expect(r.killed).toBe(false);
        expect(r.code).toBe(EXIT_UNVERIFIED);
        expect(r.last).toMatch(/^dev app did not answer on :\d+$/);
        expect(existsSync(pidFile)).toBe(true);
        expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    }, 30_000);

    // a dev app is running on the vite port most of the time here: the final one takes another port, and builds
    // and stores everything where the running one cannot see it
    it("starts the dev app on its own vite port, target dir, store and no global install", async () => {
        dir = mkdtempSync(join(tmpdir(), "final-verify-"));
        const out = join(dir, "out");
        const envFile = join(dir, "env.json");
        const fakeDev = join(dir, "fake-dev.cjs");
        // stands in for the dev app: records its env and writes a log into the store it was given
        writeFileSync(
            fakeDev,
            `const fs = require("fs"), path = require("path");
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
const data = path.join(process.env.ARC_DEV_DATA_DIR, "data");
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, "waveapp.log"), "boot log");
`
        );
        const held = await listen(0, "::1");
        const heldPort = held.address().port;
        try {
            const r = await run({
                ...process.env,
                LOCALAPPDATA: join(dir, "localappdata"),
                ARC_FINAL_OUT: out,
                ARC_FINAL_BOOT_MS: "3000",
                ARC_FINAL_DEV_CMD: `node "${fakeDev}"`,
                ARC_FINAL_VITE_PORT: String(heldPort),
            });
            expect(r.code).toBe(EXIT_UNVERIFIED);
            expect(r.last).toMatch(/^dev app exited with code 0 before answering on :\d+$/);
        } finally {
            await close(held);
        }

        const cfg = JSON.parse(readFileSync(join(out, "tauri.final.json"), "utf8"));
        const port = Number(new URL(cfg.build.devUrl).port);
        expect(port).toBeGreaterThan(heldPort);
        expect(cfg.build.beforeDevCommand).toContain(`--port ${port} --strictPort`);

        const env = JSON.parse(readFileSync(envFile, "utf8"));
        const base = join(dir, "localappdata", "arc-final");
        expect(env.CARGO_TARGET_DIR).toBe(join(base, "target"));
        // wavesrv binds <store>/data/wave.sock, and windows caps a unix socket path at 108 bytes: measured on the
        // real base, since this test's base sits under a longer temp dir
        expect(dirname(env.ARC_DEV_DATA_DIR)).toBe(join(base, "stores"));
        const realBase = join(process.env.LOCALAPPDATA || join(homedir(), ".cache"), "arc-final");
        expect(join(realBase, "stores", basename(env.ARC_DEV_DATA_DIR), "data", "wave.sock").length).toBeLessThan(108);
        expect(existsSync(env.ARC_DEV_DATA_DIR)).toBe(false);
        expect(readFileSync(join(out, "waveapp.log"), "utf8")).toBe("boot log");
        expect(env.ARC_DEV_NO_GLOBAL_INSTALL).toBe("1");
        // the profile lives in the store, so dropping the store drops it
        expect(env.WEBVIEW2_USER_DATA_FOLDER).toBe(join(env.ARC_DEV_DATA_DIR, "webview2-profile"));
        expect(existsSync(join(out, "webview2-profile"))).toBe(false);
    });
});

// a final stage runs the exe it builds in its slot's cargo target dir, so stages overlap only on different slots
describe("final-verify.mjs build slots", () => {
    let dir;
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    // a dev app that logs its start and end to a shared file, records its env in its out dir and exits after holdMs
    function fakeDevEnv(name, logFile, holdMs) {
        const fakeDev = join(dir, "fake-dev.cjs");
        writeFileSync(
            fakeDev,
            `const fs = require("fs"), path = require("path");
fs.appendFileSync(${JSON.stringify(logFile)}, "start\\n");
fs.writeFileSync(path.join(process.env.ARC_FINAL_OUT, "env.json"), JSON.stringify(process.env));
setTimeout(() => fs.appendFileSync(${JSON.stringify(logFile)}, "end\\n"), ${holdMs});
`
        );
        return {
            ...process.env,
            LOCALAPPDATA: join(dir, "localappdata"),
            ARC_FINAL_OUT: join(dir, name),
            ARC_FINAL_BOOT_MS: "10000",
            ARC_FINAL_DEV_CMD: `node "${fakeDev}"`,
        };
    }

    function makeBase() {
        dir = mkdtempSync(join(tmpdir(), "final-lock-"));
        const base = join(dir, "localappdata", "arc-final");
        mkdirSync(base, { recursive: true });
        return base;
    }

    // takes every free slot, as that many running stages would
    async function holdSlots(base, count) {
        const held = [];
        for (let i = 0; i < count; i++) held.push((await acquireBuildSlot(base, 0)).lock);
        return held;
    }

    async function runTwo(logFile) {
        const stages = await Promise.all(["out-a", "out-b"].map((name) => run(fakeDevEnv(name, logFile, 1500))));
        for (const r of stages) {
            expect(r.code).toBe(EXIT_UNVERIFIED);
            expect(r.last).toMatch(/^dev app exited with code 0 before answering on :\d+$/);
        }
        return readFileSync(logFile, "utf8").trim().split(/\r?\n/);
    }

    it("runs two final stages at once, each on its own target dir, stores and ports", async () => {
        makeBase();
        expect(await runTwo(join(dir, "dev.log"))).toEqual(["start", "start", "end", "end"]);

        const read = (name, file) => JSON.parse(readFileSync(join(dir, name, file), "utf8"));
        const [a, b] = ["out-a", "out-b"].map((name) => ({
            env: read(name, "env.json"),
            devUrl: read(name, "tauri.final.json").build.devUrl,
        }));
        expect(a.env.CARGO_TARGET_DIR).not.toBe(b.env.CARGO_TARGET_DIR);
        expect(dirname(a.env.ARC_DEV_DATA_DIR)).not.toBe(dirname(b.env.ARC_DEV_DATA_DIR));
        expect(a.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).not.toBe(b.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS);
        expect(a.devUrl).not.toBe(b.devUrl);
    }, 30_000);

    // node_modules is a junction to the main checkout's, so its .vite cache is shared with every dev app on the
    // machine: one re-optimizing mid-boot swaps react's chunks under another and loads two copies of react
    it("gives each slot its own vite cache, outside node_modules", async () => {
        const base = makeBase();
        await runTwo(join(dir, "dev.log"));

        const [a, b] = ["out-a", "out-b"].map((name) => JSON.parse(readFileSync(join(dir, name, "env.json"), "utf8")));
        expect(a.ARC_VITE_CACHE_DIR).not.toBe(b.ARC_VITE_CACHE_DIR);
        for (const env of [a, b]) {
            expect(dirname(env.ARC_VITE_CACHE_DIR)).toBe(base);
            expect(env.ARC_VITE_CACHE_DIR).not.toContain("node_modules");
        }
    }, 30_000);

    it("runs two final stages one after the other when one slot is free", async () => {
        const base = makeBase();
        const first = await acquireBuildSlot(base, 0);
        const held = await holdSlots(base, BUILD_SLOTS - 1);
        await close(first.lock);
        try {
            expect(await runTwo(join(dir, "dev.log"))).toEqual(["start", "end", "start", "end"]);
        } finally {
            await Promise.all(held.map(close));
        }
    }, 30_000);

    it("is unverified when other final stages keep every slot past the wait", async () => {
        const base = makeBase();
        const held = await holdSlots(base, BUILD_SLOTS);
        try {
            expect(await acquireBuildSlot(base, 0)).toBeNull();
            const r = await run({ ...fakeDevEnv("out", join(dir, "dev.log"), 0), ARC_FINAL_LOCK_WAIT_MS: "1500" });
            expect(r.code).toBe(EXIT_UNVERIFIED);
            expect(r.last).toBe("other final stages held every build slot for 2s");
            expect(existsSync(join(dir, "dev.log"))).toBe(false);
        } finally {
            await Promise.all(held.map(close));
        }
    });

    it("is free once the stage holding it is killed", async () => {
        const base = makeBase();
        const holder = spawn(process.execPath, [
            "-e",
            `require("net").createServer().listen(${JSON.stringify(buildLockPath(base))}, () => console.log("held"));`,
        ]);
        await new Promise((resolve) => holder.stdout.once("data", resolve));
        expect(await acquireBuildSlot(base, 0, 1)).toBeNull();
        holder.kill("SIGKILL");
        await new Promise((resolve) => holder.once("exit", resolve));

        const held = await acquireBuildSlot(base, 5000, 1);
        expect(held).toEqual({ slot: 0, lock: expect.anything() });
        await close(held.lock);
    });

    // run dca34385: a worker started its own dev app with slot 0's target dir, so the next stage on slot 0 got the lock
    // and cargo then could not replace the exe that app ran
    it.skipIf(process.platform !== "win32")("skips a slot whose exe a dev app started without the lock is running", async () => {
        const base = makeBase();
        const exe = join(base, "target", "debug", "wave-tauri.exe");
        mkdirSync(dirname(exe), { recursive: true });
        copyFileSync(process.execPath, exe);
        const app = spawn(exe, ["-e", `console.log("up"); setTimeout(() => {}, 30000);`]);
        await new Promise((resolve) => app.stdout.once("data", resolve));
        try {
            const held = await acquireBuildSlot(base, 0);
            expect(held.slot).toBe(1);
            await close(held.lock);
        } finally {
            app.kill("SIGKILL");
            await new Promise((resolve) => app.once("exit", resolve));
        }
        const held = await acquireBuildSlot(base, 0);
        expect(held.slot).toBe(0);
        await close(held.lock);
    });
});

describe("pickVitePort", () => {
    it("skips a port a dev app holds on ::1 alone", async () => {
        const held = await listen(0, "::1");
        const port = held.address().port;
        try {
            expect(await pickVitePort(port)).toBeGreaterThan(port);
        } finally {
            await close(held);
        }
    });
});

describe("unlinkBuildJunctions", () => {
    let dir;
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    it("removes the build-output links and leaves what they point at", () => {
        dir = mkdtempSync(join(tmpdir(), "final-junctions-"));
        const main = join(dir, "main");
        const tree = join(dir, "tree");
        for (const rel of ["dist/bin", "src-tauri/target"]) {
            mkdirSync(join(main, rel), { recursive: true });
            writeFileSync(join(main, rel, "keep.txt"), "x");
            mkdirSync(join(tree, rel, ".."), { recursive: true });
            symlinkSync(join(main, rel), join(tree, rel), "junction");
        }
        mkdirSync(join(tree, "node_modules"));

        unlinkBuildJunctions(tree);

        for (const rel of ["dist/bin", "src-tauri/target"]) {
            expect(existsSync(join(tree, rel))).toBe(false);
            expect(existsSync(join(main, rel, "keep.txt"))).toBe(true);
        }
        expect(existsSync(join(tree, "node_modules"))).toBe(true);
    });

    it("leaves a real directory alone", () => {
        dir = mkdtempSync(join(tmpdir(), "final-junctions-"));
        mkdirSync(join(dir, "dist", "bin"), { recursive: true });
        writeFileSync(join(dir, "dist", "bin", "wavesrv.x64.exe"), "x");
        unlinkBuildJunctions(dir);
        expect(existsSync(join(dir, "dist", "bin", "wavesrv.x64.exe"))).toBe(true);
    });
});

describe("sweepStaleStores", () => {
    let dir;
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    it("drops every store a killed or half-cleaned stage left", () => {
        dir = mkdtempSync(join(tmpdir(), "final-stores-"));
        for (const id of ["aaaa1111", "bbbb2222"]) {
            mkdirSync(join(dir, id, "data", "db"), { recursive: true });
            writeFileSync(join(dir, id, "data", "db", "waveterm.db"), "x");
        }

        sweepStaleStores(dir);

        expect(existsSync(join(dir, "aaaa1111"))).toBe(false);
        expect(existsSync(join(dir, "bbbb2222"))).toBe(false);
    });

    it("is a no-op when no stage has made a store yet", () => {
        dir = mkdtempSync(join(tmpdir(), "final-stores-"));
        expect(() => sweepStaleStores(join(dir, "missing"))).not.toThrow();
    });
});

describe("finalOutcome", () => {
    const exited = { state: "exited" };
    const alive = { state: "alive" };
    const unclosed = { state: "unclosed", reason: "could not close the main window: no page" };

    // the close is not tried after a failed run, so there is no close result to read
    it.each([[1], [2], [EXIT_UNVERIFIED]])("keeps the scenarios' exit code %i whatever the close showed", (code) => {
        for (const close of [undefined, exited, alive, unclosed]) {
            expect(finalOutcome(code, close)).toEqual({ code });
        }
    });

    it("passes when the scenarios passed and the app exited by itself", () => {
        expect(finalOutcome(0, exited)).toEqual({ code: 0 });
    });

    it("fails, and is not unverified, when the app stayed alive after its main window was closed", () => {
        expect(finalOutcome(0, alive)).toEqual({
            code: 1,
            line: "the dev app stayed alive after its main window was closed",
        });
    });

    it("is unverified with the reason when the main window could not be closed", () => {
        expect(finalOutcome(0, unclosed)).toEqual({ code: EXIT_UNVERIFIED, line: unclosed.reason });
    });
});

describe("closeMainWindow", () => {
    it("is unclosed when nothing answers on the port", async () => {
        const r = await closeMainWindow(await freePort());
        expect(r.state).toBe("unclosed");
        expect(r.reason).toMatch(/^could not close the main window: cannot reach CDP on :\d+/);
    });

    it("is unclosed when the app has no cockpit page to attach to", async () => {
        // a host whose only page is the hidden popup's
        const popup = [{ type: "page", url: "http://localhost:5174/popup.html" }];
        const srv = createHttpServer((_req, res) => res.end(JSON.stringify(popup)));
        await new Promise((resolve) => srv.listen(0, resolve));
        try {
            const r = await closeMainWindow(srv.address().port);
            expect(r.state).toBe("unclosed");
            expect(r.reason).toMatch(/^could not close the main window: no page target on :\d+/);
        } finally {
            srv.closeAllConnections();
            await close(srv);
        }
    });

    // a CDP host with one cockpit page; onClose(srv, wss) answers the close invoke's Runtime.evaluate: a value to reply
    // with, or undefined to never reply
    async function fakeCdpHost(onClose) {
        const srv = createHttpServer((req, res) => {
            const ws = `ws://127.0.0.1:${srv.address().port}/page`;
            res.end(JSON.stringify([{ type: "page", url: "http://localhost:5174/", webSocketDebuggerUrl: ws }]));
        });
        const wss = new WebSocketServer({ server: srv });
        wss.on("connection", (ws) =>
            ws.on("message", (data) => {
                const { id, method } = JSON.parse(data);
                if (method !== "Runtime.evaluate") return ws.send(JSON.stringify({ id, result: {} }));
                const value = onClose(srv, wss);
                if (value !== undefined) ws.send(JSON.stringify({ id, result: { result: { value } } }));
            })
        );
        await new Promise((resolve) => srv.listen(0, resolve));
        const stop = async () => {
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            srv.closeAllConnections();
            if (srv.listening) await close(srv);
        };
        return { port: srv.address().port, stop };
    }

    it("is exited when the app stops answering after the close", async () => {
        const host = await fakeCdpHost((srv, wss) => {
            for (const ws of wss.clients) ws.terminate();
            srv.closeAllConnections();
            srv.close();
        });
        try {
            expect(await closeMainWindow(host.port, 5000)).toEqual({ state: "exited" });
        } finally {
            await host.stop();
        }
    });

    it("is alive when the app keeps answering past the wait", async () => {
        const host = await fakeCdpHost(() => undefined);
        try {
            expect(await closeMainWindow(host.port, 1500)).toEqual({ state: "alive" });
        } finally {
            await host.stop();
        }
    });

    it("is unclosed with the invoke's error when the close is rejected", async () => {
        const host = await fakeCdpHost(() => "window not found");
        try {
            expect(await closeMainWindow(host.port, 5000)).toEqual({
                state: "unclosed",
                reason: "could not close the main window: window not found",
            });
        } finally {
            await host.stop();
        }
    });
});

describe("finalManifest", () => {
    it("prefixes every file with cdp-shots/ and keeps the rest of the entry", () => {
        const steps = [{ step: "a", state: "pass" }];
        expect(
            finalManifest([
                { name: "runs", files: ["runs.png", "nested/open.png"], steps },
                { name: "empty", files: [], steps: [] },
            ])
        ).toEqual([
            { name: "runs", files: ["cdp-shots/runs.png", "cdp-shots/nested/open.png"], steps },
            { name: "empty", files: [], steps: [] },
        ]);
    });
});

describe("writeFinalManifest", () => {
    let dir;
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    it("writes the prefixed manifest at the top of the out dir", () => {
        dir = mkdtempSync(join(tmpdir(), "final-manifest-"));
        const shots = join(dir, "cdp-shots");
        const out = join(dir, "out");
        mkdirSync(shots);
        mkdirSync(out);
        writeFileSync(join(shots, "shots.json"), JSON.stringify([{ name: "runs", files: ["runs.png"], steps: [] }]));

        writeFinalManifest(shots, out);

        expect(JSON.parse(readFileSync(join(out, "shots.json"), "utf8"))).toEqual([
            { name: "runs", files: ["cdp-shots/runs.png"], steps: [] },
        ]);
    });

    it("writes nothing when verify never wrote a manifest", () => {
        dir = mkdtempSync(join(tmpdir(), "final-manifest-"));
        const out = join(dir, "out");
        mkdirSync(out);

        writeFinalManifest(join(dir, "cdp-shots"), out);

        expect(existsSync(join(out, "shots.json"))).toBe(false);
    });

    it("writes nothing and does not throw when the manifest is unreadable", () => {
        dir = mkdtempSync(join(tmpdir(), "final-manifest-"));
        const shots = join(dir, "cdp-shots");
        const out = join(dir, "out");
        mkdirSync(shots);
        mkdirSync(out);
        writeFileSync(join(shots, "shots.json"), "{not json");

        expect(() => writeFinalManifest(shots, out)).not.toThrow();
        expect(existsSync(join(out, "shots.json"))).toBe(false);
    });
});
