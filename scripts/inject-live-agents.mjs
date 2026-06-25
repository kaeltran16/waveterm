// DEV live-pipeline injector. Run from inside a Wave terminal (wsh must be authenticated). Creates
// one terminal block per fake agent, drives each with `wsh agentstatus` / `wsh ask`, and writes a
// fake Claude-Code transcript JSONL so the live narration path renders. Tears everything down with
// --clear (reads the state file it wrote on inject).
//
//   node scripts/inject-live-agents.mjs mixed     # create + drive the "mixed" roster
//   node scripts/inject-live-agents.mjs --clear   # delete created blocks + transcripts
//
// If Task 7's probe showed bare createblock terminals don't surface, switch createBlock() to read
// pre-opened sessions via `wsh blocks list --view=term --json` instead (see plan Task 7 fallback).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCENARIOS } from "./cockpit-fixtures/scenarios.mjs";
import { validateScenario } from "./cockpit-fixtures/validate.mjs";

const STATE_FILE = join(tmpdir(), "wave-fake-agents.json");

function wsh(args, input) {
    return execFileSync("wsh", args, { input, encoding: "utf8" });
}

// AgentEntry[] -> Claude-Code transcript JSONL (reverse of frontend transcriptprojection.ts).
const TOOL_BY_VERB = { ran: "Bash", edited: "Edit", wrote: "Write", read: "Read", grep: "Grep", glob: "Glob", spawned: "Task" };
function inputFor(tool, target) {
    if (tool === "Bash") return { command: target };
    if (tool === "Read" || tool === "Edit" || tool === "Write") return { file_path: target };
    if (tool === "Grep" || tool === "Glob") return { pattern: target };
    return { description: target };
}
function transcriptLines(task, entries) {
    const lines = [];
    if (task) lines.push(JSON.stringify({ type: "ai-title", aiTitle: task }));
    (entries ?? []).forEach((e, i) => {
        if (e.kind === "message") {
            lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: e.text }] } }));
        } else if (e.kind === "user") {
            lines.push(JSON.stringify({ type: "user", message: { content: e.text } }));
        } else if (e.kind === "action") {
            const tool = TOOL_BY_VERB[e.verb] ?? "Bash";
            const id = `t${i}`;
            lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: tool, input: inputFor(tool, e.target) }] } }));
            if (e.outcome) {
                lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: e.outcome === "fail" }] } }));
            }
        }
    });
    return lines.join("\n") + "\n";
}

const STATE_FLAG = { asking: "waiting", working: "working", idle: "idle" };

function inject(scenarioName) {
    const build = SCENARIOS[scenarioName];
    if (!build) {
        console.error(`unknown scenario "${scenarioName}". options: ${Object.keys(SCENARIOS).join(", ")}`);
        process.exit(1);
    }
    const roster = build(Date.now());
    const { ok, errors } = validateScenario(roster);
    if (!ok) {
        console.error(`scenario invalid:\n  ${errors.join("\n  ")}`);
        process.exit(1);
    }
    const tdir = mkdtempSync(join(tmpdir(), "wave-fake-"));
    const created = [];
    for (const a of roster) {
        const out = wsh(["createblock", "term"]);
        const oid = (out.match(/created block (\S+)/) ?? [])[1];
        if (!oid) {
            console.error(`could not parse block id from: ${out}`);
            continue;
        }
        const oref = `block:${oid}`;
        const tpath = join(tdir, `${oid}.jsonl`);
        writeFileSync(tpath, transcriptLines(a.task, a.previousInfo));
        const statusArgs = ["agentstatus", "-b", oref, "--state", STATE_FLAG[a.state], "--agent", a.agent || "claude", "--transcript", tpath];
        if (a.model) statusArgs.push("--model", a.model);
        if (a.task) statusArgs.push("--title", a.task);
        if (a.activity) statusArgs.push("--detail", a.activity);
        wsh(statusArgs);
        if (a.usage) {
            const u = a.usage;
            const usageArgs = ["agentstatus", "-b", oref, "--usage"];
            if (u.contextpct != null) usageArgs.push("--context-pct", String(u.contextpct));
            if (u.contextmax != null) usageArgs.push("--context-max", String(u.contextmax));
            if (u.costusd != null) usageArgs.push("--cost-usd", String(u.costusd));
            if (u.fivehourpct != null) usageArgs.push("--five-hour-pct", String(u.fivehourpct));
            if (u.fivehourreset != null) usageArgs.push("--five-hour-reset", String(u.fivehourreset));
            if (u.weekpct != null) usageArgs.push("--week-pct", String(u.weekpct));
            if (u.weekreset != null) usageArgs.push("--week-reset", String(u.weekreset));
            wsh(usageArgs);
        }
        if (a.state === "asking" && a.ask?.questions?.length) {
            const payload = JSON.stringify({
                questions: a.ask.questions.map((q) => ({
                    question: q.question,
                    header: q.header ?? "",
                    multiSelect: q.multiSelect ?? false,
                    options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
                })),
            });
            wsh(["ask", "-b", oref], payload);
        }
        created.push({ oid, oref, tpath });
        console.log(`+ ${a.name} (${a.state}) -> ${oref}`);
    }
    writeFileSync(STATE_FILE, JSON.stringify({ tdir, created }, null, 2));
    console.log(`injected ${created.length} agents. tear down with: node scripts/inject-live-agents.mjs --clear`);
}

function clear() {
    if (!existsSync(STATE_FILE)) {
        console.log("nothing to clear (no state file)");
        return;
    }
    const { tdir, created } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    for (const { oref } of created) {
        try { wsh(["ask", "-b", oref, "--clear"]); } catch {}
        try { wsh(["deleteblock", "-b", oref]); } catch {}
        console.log(`- removed ${oref}`);
    }
    try { rmSync(tdir, { recursive: true, force: true }); } catch {}
    rmSync(STATE_FILE, { force: true });
    console.log("cleared.");
}

const arg = process.argv[2];
if (arg === "--clear") {
    clear();
} else if (arg) {
    inject(arg);
} else {
    console.log("usage: node scripts/inject-live-agents.mjs <scenario|--clear>");
    console.log(`scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
}
