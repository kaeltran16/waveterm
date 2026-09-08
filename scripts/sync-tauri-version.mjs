// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// package.json is the single source of truth for the app version. Every other file that carries a
// copy is listed in SITES below and gets rewritten from it, so the installer, the Rust crate, and
// app.getVersion() can't drift apart.
//
//   node scripts/sync-tauri-version.mjs           write package.json's version into every site
//   node scripts/sync-tauri-version.mjs --check    report drift and exit 1, writing nothing
//
// Run before any cargo tauri dev/build — wired into `tauri:dev`, `tauri:build`, and `check:version`.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const version = require("../version.cjs");

// Each site is matched by a regex with three groups: everything up to the version literal, the
// literal itself, and the closing quote. Patching group 2 in place leaves the rest of the file's
// hand-formatting untouched (a JSON.parse/stringify round-trip would reflow tauri.conf.json).
const SITES = [
    {
        label: "src-tauri/tauri.conf.json",
        url: new URL("../src-tauri/tauri.conf.json", import.meta.url),
        re: /("version"\s*:\s*")([^"]*)(")/,
    },
    {
        // Unused at runtime (Tauri reads the version from tauri.conf.json) but kept in step so the
        // crate metadata isn't quietly wrong. `[^[]*?` keeps the match inside the [package] block.
        label: "src-tauri/Cargo.toml",
        url: new URL("../src-tauri/Cargo.toml", import.meta.url),
        re: /(\[package\][^[]*?\nversion\s*=\s*")([^"]*)(")/,
    },
];

const check = process.argv.includes("--check");
const drift = [];

for (const site of SITES) {
    const text = readFileSync(site.url, "utf8");
    const m = text.match(site.re);
    if (!m) {
        // A silent skip here is how a site rots: the version stops being synced and nothing says so.
        console.error(`version site not found in ${site.label} — its format changed, update SITES`);
        process.exit(2);
    }
    if (m[2] === version) {
        continue;
    }
    drift.push(`${site.label}: ${m[2]}`);
    if (!check) {
        writeFileSync(site.url, text.replace(site.re, `$1${version}$3`));
    }
}

if (check && drift.length > 0) {
    console.error(`version drift (package.json is ${version}):`);
    for (const d of drift) {
        console.error(`  ${d}`);
    }
    console.error("run `task tauri:sync-version` to fix");
    process.exit(1);
}
if (check) {
    console.log(`version ${version} consistent across ${SITES.length} sites`);
}
