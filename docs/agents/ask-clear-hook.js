// Copyright 2026, WaveTerm Inc.
// Licensed under the Apache License, Version 2.0.
//
// PostToolUse hook for AskUserQuestion: once the question is answered (in the terminal
// OR via a keystroke injected from the Agents panel), remove the panel copy by calling
// `wsh ask --clear`. Registered in ~/.claude/settings.json under hooks.PostToolUse with
// matcher "AskUserQuestion". Fail-safe: any problem -> exit 0 (card lingers until superseded).

const path = require("path");
const childProcess = require("child_process");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
    let parsed;
    try {
        parsed = JSON.parse(input);
    } catch (_) {
        process.exit(0);
    }
    if (parsed.tool_name !== "AskUserQuestion") {
        process.exit(0);
    }
    if (!process.env.WAVETERM_BLOCKID || !process.env.WAVETERM_WSHBINDIR) {
        process.exit(0);
    }

    const wsh = path.join(
        process.env.WAVETERM_WSHBINDIR,
        process.platform === "win32" ? "wsh.exe" : "wsh"
    );

    try {
        childProcess.spawnSync(wsh, ["ask", "--clear"], { encoding: "utf8", timeout: 5000 });
    } catch (_) {
        // ignore
    }
    process.exit(0);
});
