// Write a fixture scenario to public/cockpit-fixtures/active.json (served by Vite at
// /cockpit-fixtures/active.json in dev). Reload the dev app to inject it. Run from the repo root:
//   node scripts/gen-cockpit-fixtures.mjs mixed      # inject the "mixed" roster
//   node scripts/gen-cockpit-fixtures.mjs --clear    # remove the fixture (back to live)
//   node scripts/gen-cockpit-fixtures.mjs            # list scenarios

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./cockpit-fixtures/scenarios.mjs";
import { validateScenario } from "./cockpit-fixtures/validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Vite's root is frontend/tauri, so its publicDir is frontend/tauri/public (served at "/"). Repo-root
// public/ is NOT served by the dev server, so the fixture must live here to be fetchable in dev.
const outDir = join(here, "..", "frontend", "tauri", "public", "cockpit-fixtures");
const outFile = join(outDir, "active.json");

const arg = process.argv[2];
const names = Object.keys(SCENARIOS);

if (arg === "--clear" || arg === "live") {
    if (existsSync(outFile)) {
        rmSync(outFile);
        console.log("cleared active.json — reload the dev app to return to the live roster");
    } else {
        console.log("no active.json to clear");
    }
    process.exit(0);
}

if (!arg || !names.includes(arg)) {
    console.log(`usage: node scripts/gen-cockpit-fixtures.mjs <scenario|--clear>`);
    console.log(`scenarios: ${names.join(", ")}`);
    process.exit(arg ? 1 : 0);
}

const roster = SCENARIOS[arg](Date.now());
const { ok, errors } = validateScenario(roster);
if (!ok) {
    console.error(`scenario "${arg}" is invalid:\n  ${errors.join("\n  ")}`);
    process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(roster, null, 2));
console.log(`wrote ${roster.length} agents (${arg}) -> frontend/tauri/public/cockpit-fixtures/active.json`);
console.log(`reload the dev app (Ctrl+R) to inject. clear with: node scripts/gen-cockpit-fixtures.mjs --clear`);
