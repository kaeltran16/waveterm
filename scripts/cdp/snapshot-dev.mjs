// Boots a dev app on a copy of the packaged Arc's store, to review surfaces on real data
// (docs/reference/surface-review.md). Each start makes a fresh copy: the databases, jarvis and memory-hygiene
// state, config and the vault (without .git, so nothing is committed or pushed). wavesrv runs with ARC_SNAPSHOT=1,
// under which it resumes no run, starts processes only in the copy's scratch dir and writes nothing to Jira.
// It takes the main dev app's ports (CDP 9222, Vite 5174), so it refuses while that app runs. Ctrl-C stops it.
//
//   node scripts/cdp/snapshot-dev.mjs
//
// Only the PID this script spawned is ever killed: the packaged Arc shares the dev app's image names.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { inUse, killTree } from "./final-verify.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCAL = process.env.LOCALAPPDATA;
const PACKAGED = join(LOCAL, "dev.arc.app");
// short on purpose: wavesrv binds data\wave.sock under it, and Windows caps a unix socket path at 108 bytes
const BASE = join(LOCAL, "arc-snap");
const DEV_PORTS = { CDP: 9222, Vite: 5174 };
const DBS = ["waveterm.db", "filestore.db"];
const DATA_DIRS = ["jarvis", "memhygiene"];
const VAULT_KEY = "memory:vaultpath";

function fail(msg) {
    console.error(`snapshot-dev: ${msg}`);
    process.exit(1);
}

// VACUUM INTO reads one consistent state while the packaged Arc keeps writing; a file copy can catch the db and
// its -wal mid-write
function copyDb(src, dest) {
    const db = new DatabaseSync(src, { readOnly: true });
    try {
        db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
    } finally {
        db.close();
    }
}

// returns the copied vault's path: the settings point at it, so the app never opens the real vault
function copyConfigAndVault() {
    const config = join(BASE, "config");
    cpSync(join(PACKAGED, "config"), config, { recursive: true });
    const settingsPath = join(config, "settings.json");
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
    const vault = join(BASE, "vault");
    const source = settings[VAULT_KEY];
    if (source && existsSync(source)) {
        cpSync(source, vault, { recursive: true, filter: (p) => basename(p) !== ".git" });
    } else {
        console.warn(`snapshot-dev: no vault at ${VAULT_KEY}=${source ?? "(unset)"}; the copy starts with an empty one`);
        mkdirSync(vault, { recursive: true });
    }
    settings[VAULT_KEY] = vault;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return vault;
}

async function main() {
    for (const [name, port] of Object.entries(DEV_PORTS)) {
        if (await inUse(port)) fail(`${name} port :${port} is taken; stop the dev app using it first`);
    }
    if (!existsSync(join(PACKAGED, "data", "db", DBS[0]))) fail(`no packaged store at ${PACKAGED}`);
    try {
        rmSync(BASE, { recursive: true, force: true });
    } catch (e) {
        fail(`cannot clear ${BASE} (${e.code}); is a previous snapshot app still running?`);
    }

    const dbDir = join(BASE, "data", "db");
    mkdirSync(dbDir, { recursive: true });
    for (const db of DBS) copyDb(join(PACKAGED, "data", "db", db), join(dbDir, db));
    for (const dir of DATA_DIRS) {
        const src = join(PACKAGED, "data", dir);
        if (existsSync(src)) cpSync(src, join(BASE, "data", dir), { recursive: true });
    }
    const vault = copyConfigAndVault();
    // wavesrv starts processes only under here (wavebase.SnapshotScratchDir)
    const scratch = join(BASE, "scratch");
    mkdirSync(scratch, { recursive: true });
    const profile = join(BASE, "webview2");
    mkdirSync(profile, { recursive: true });

    console.log(`snapshot-dev: store ${BASE}, vault ${vault}`);
    console.log(`snapshot-dev: launch agents only with cwd under ${scratch}; CDP on :${DEV_PORTS.CDP} once built`);

    // stdin stays an open pipe: `task dev` exits when its stdin closes
    const dev = spawn("task dev", {
        shell: true,
        cwd: REPO,
        stdio: ["pipe", "inherit", "inherit"],
        env: {
            ...process.env,
            ARC_DEV_DATA_DIR: BASE,
            ARC_SNAPSHOT: "1",
            ARC_DEV_NO_GLOBAL_INSTALL: "1",
            WEBVIEW2_USER_DATA_FOLDER: profile,
        },
    });
    for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, () => {
            killTree(dev.pid);
            process.exit(130);
        });
    }
    dev.on("exit", (code) => process.exit(code ?? 1));
}

main().catch((e) => fail(e?.message ?? String(e)));
