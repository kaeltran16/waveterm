import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_UNVERIFIED, inUse, pickPort, pickVitePort, unlinkBuildJunctions } from "./final-verify.mjs";

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
    });

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
        const base = join(process.env.LOCALAPPDATA || join(homedir(), ".cache"), "arc-final");
        expect(env.CARGO_TARGET_DIR).toBe(join(base, "target"));
        // wavesrv binds <store>/data/wave.sock, and windows caps a unix socket path at 108 bytes
        expect(env.ARC_DEV_DATA_DIR.startsWith(join(base, "stores"))).toBe(true);
        expect(join(env.ARC_DEV_DATA_DIR, "data", "wave.sock").length).toBeLessThan(108);
        expect(existsSync(env.ARC_DEV_DATA_DIR)).toBe(false);
        expect(readFileSync(join(out, "waveapp.log"), "utf8")).toBe("boot log");
        expect(env.ARC_DEV_NO_GLOBAL_INSTALL).toBe("1");
        expect(env.WEBVIEW2_USER_DATA_FOLDER).toBe(join(out, "webview2-profile"));
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
