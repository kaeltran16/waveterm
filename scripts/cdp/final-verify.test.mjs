import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_UNVERIFIED, inUse, pickPort } from "./final-verify.mjs";

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

    it("is unverified without building when another dev app holds the vite port", async () => {
        dir = mkdtempSync(join(tmpdir(), "final-verify-"));
        const marker = join(dir, "started");
        const held = await listen(0, "::1");
        try {
            const r = await run({
                ...process.env,
                ARC_FINAL_OUT: join(dir, "out"),
                ARC_FINAL_DEV_CMD: `node -e "require('fs').writeFileSync(process.argv[1], '')" "${marker}"`,
                ARC_FINAL_VITE_PORT: String(held.address().port),
            });
            expect(r.code).toBe(EXIT_UNVERIFIED);
            expect(r.last).toMatch(/^another dev app is running/);
            expect(existsSync(marker)).toBe(false);
        } finally {
            await close(held);
        }
    });
});
