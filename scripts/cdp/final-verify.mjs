// This repo's **Final:** command. The engine runs it in the final tree with ARC_FINAL_OUT set: it starts a dev
// app from that tree on its own CDP port and WebView2 profile, runs verify.mjs against it, and copies the shots
// and contact sheet into ARC_FINAL_OUT. Exit 0 passes, verify.mjs's nonzero code fails, and EXIT_UNVERIFIED
// with the reason as the last stdout line means the UI could not be checked at all.
//
//   ARC_FINAL_OUT=<dir> node scripts/cdp/final-verify.mjs [scenario...]
//
// ARC_FINAL_DEV_CMD (default `task dev`) and ARC_FINAL_BOOT_MS (default 10 min, a cold cargo build) exist so the
// test can drive the boot path without starting a real app.
//
// The user's packaged Arc shares the dev app's image names, so only the PID this script spawned is ever killed.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXIT_UNVERIFIED = 3;

const DEFAULT_PORT = 9230;
const PORT_SCAN = 100;
const DEFAULT_BOOT_MS = 600_000;
const POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 2_000;

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

function killTree(pid) {
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

async function answers(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return res.ok;
    } catch {
        return false;
    }
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

async function main() {
    const out = process.env.ARC_FINAL_OUT;
    if (!out) unverified("ARC_FINAL_OUT is not set");
    const scenarios = process.argv.slice(2);
    const bootMs = Number(process.env.ARC_FINAL_BOOT_MS) || DEFAULT_BOOT_MS;
    const devCmd = process.env.ARC_FINAL_DEV_CMD || "task dev";

    const port = await pickPort();
    const profile = join(out, "webview2-profile");
    mkdirSync(profile, { recursive: true });
    // the dev app's output goes to a file so the last stdout line stays ours for the engine to read
    const logPath = join(out, "dev-app.log");
    const log = openSync(logPath, "a");
    console.log(`starting \`${devCmd}\` on :${port} (log: ${logPath})`);

    // stdin stays an open pipe: `task dev` exits when its stdin closes
    const dev = spawn(devCmd, {
        shell: true,
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        stdio: ["pipe", log, log],
        env: {
            ...process.env,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
            WEBVIEW2_USER_DATA_FOLDER: profile,
        },
    });
    const stop = () => killTree(dev.pid);
    for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, () => {
            stop();
            process.exit(1);
        });
    }

    let code;
    let reason;
    try {
        if (!(await waitForCdp(port, dev, bootMs))) {
            reason =
                dev.exitCode === null
                    ? `dev app did not answer on :${port}`
                    : `dev app exited with code ${dev.exitCode} before answering on :${port}`;
        } else {
            code = await runVerify(port, scenarios);
            if (existsSync("cdp-shots")) cpSync("cdp-shots", join(out, "cdp-shots"), { recursive: true });
        }
    } finally {
        stop();
    }
    if (reason) unverified(reason);
    process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => unverified(`final-verify: ${e?.message ?? e}`));
}
