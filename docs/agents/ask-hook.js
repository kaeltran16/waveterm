// Copyright 2026, WaveTerm Inc.
// Licensed under the Apache License, Version 2.0.
//
// PreToolUse hook for AskUserQuestion: projects a COPY of the question into Wave's
// Agents panel via `wsh ask`, then exits 0 so Claude Code renders its native picker
// in the terminal as usual. The panel and the terminal are both live answer surfaces
// (the panel injects keystrokes into this block's PTY to drive the same native picker).
//
// Registered in ~/.claude/settings.json under hooks.PreToolUse with matcher
// "AskUserQuestion". Fail-safe: any problem -> exit 0 -> native terminal prompt.

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
    if (!parsed.tool_input?.questions?.length) {
        process.exit(0);
    }

    const wsh = path.join(
        process.env.WAVETERM_WSHBINDIR,
        process.platform === "win32" ? "wsh.exe" : "wsh"
    );

    // non-blocking projection: publish the copy to the panel, then let CC render natively.
    try {
        childProcess.spawnSync(wsh, ["ask"], {
            input: JSON.stringify(parsed.tool_input),
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5000,
        });
    } catch (_) {
        // ignore — terminal picker still renders
    }
    // no permissionDecision: CC proceeds and renders the native picker
    process.exit(0);
});
