// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Copy package.json's version into src-tauri/tauri.conf.json so the bundled installer and
// app.getVersion() agree (package.json stays the single source of truth). Run before any
// cargo tauri dev/build — wired into `tauri:dev` and the package.json "build" script.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const version = require("../version.cjs");

const confPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const text = readFileSync(confPath, "utf8");
const key = '"version"';
const i = text.indexOf(key);
if (i >= 0) {
  const c = text.indexOf(":", i);
  const j = text.indexOf('"', c + 1);
  const k = text.indexOf('"', j + 1);
  const next = text.slice(0, j) + `"${version}"` + text.slice(k + 1);
  if (next !== text) writeFileSync(confPath, next);
}
