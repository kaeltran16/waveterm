// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure projection of a Codex rollout transcript (JSONL lines) into AgentEntry[].
// No React, no Wave runtime imports. Deterministic; no LLM. Sibling of transcriptprojection.ts
// (Claude Code); both produce the shared AgentEntry[] contract, selected via the projection registry.
//
// Codex records are {timestamp, type, payload}. Only `response_item` carries the real conversation;
// `event_msg` holds guardian/auto-review noise plus a duplicate of every assistant turn, so it is
// ignored wholesale. session_meta/turn_context/reasoning/ghost_snapshot are skipped too.

import type { AgentEntry, CardTask } from "./agentsviewmodel";

const VERB_BY_TOOL: Record<string, string> = {
    shell_command: "ran",
    apply_patch: "edited",
    update_plan: "updated plan",
};

// Codex injects synthetic context as user input_text wrappers (the env primer and any invoked
// skill's full SKILL.md body); neither is something the user typed, so both are dropped.
function isInjectedContext(text: string): boolean {
    return text.startsWith("<environment_context") || text.startsWith("<skill>");
}

function verbFor(name: string): string {
    return VERB_BY_TOOL[name] ?? name.toLowerCase();
}

function baseName(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] || p;
}

// function_call.arguments is a JSON string; the command is the salient target.
function shellTarget(argsRaw: unknown): string {
    if (typeof argsRaw !== "string") {
        return "";
    }
    try {
        const a = JSON.parse(argsRaw);
        if (typeof a?.command === "string") {
            return a.command;
        }
    } catch {
        // malformed arguments — no target
    }
    return "";
}

// update_plan.arguments is a JSON string {plan:[{step,status}]}; the in-progress step is the
// salient "current step" target. Empty when the plan has no in-progress step (e.g. all done).
function planTarget(argsRaw: unknown): string {
    if (typeof argsRaw !== "string") {
        return "";
    }
    try {
        const a = JSON.parse(argsRaw);
        const plan = Array.isArray(a?.plan) ? a.plan : [];
        const current = plan.find((s: any) => s?.status === "in_progress");
        return typeof current?.step === "string" ? current.step : "";
    } catch {
        return "";
    }
}

// custom_tool_call (apply_patch).input is a raw patch; the first touched file is the target.
function patchTarget(input: unknown): string {
    if (typeof input !== "string") {
        return "";
    }
    const m = input.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
    return m ? baseName(m[1].trim()) : "";
}

// A tool output is an error iff it reports a non-zero exit code: shell outputs lead with
// "Exit code: N"; custom-tool outputs are JSON carrying metadata.exit_code.
function outputIsError(output: unknown): boolean {
    if (typeof output !== "string") {
        return false;
    }
    const m = output.match(/Exit code:\s*(\d+)/);
    if (m) {
        return m[1] !== "0";
    }
    try {
        const parsed = JSON.parse(output);
        if (typeof parsed?.metadata?.exit_code === "number") {
            return parsed.metadata.exit_code !== 0;
        }
    } catch {
        // not JSON — treat as non-error
    }
    return false;
}

type ActionEntry = AgentEntry & { kind: "action" };

/** Pure: project codex rollout JSONL lines into ordered entries. assistant output_text -> message;
 *  user input_text -> user (the synthetic <environment_context> primer is dropped); function_call /
 *  custom_tool_call -> action; *_output -> outcome on the matching action by call_id (fail on a
 *  non-zero exit; ok only for "ran", matching the Claude projection). */
export function projectCodexTranscript(lines: string[]): AgentEntry[] {
    const entries: AgentEntry[] = [];
    const actionById = new Map<string, ActionEntry>();
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec?.type !== "response_item") {
            continue;
        }
        const p = rec.payload;
        if (p == null) {
            continue;
        }
        if (p.type === "message") {
            const content = Array.isArray(p.content) ? p.content : [];
            if (p.role === "assistant") {
                for (const block of content) {
                    if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim() !== "") {
                        entries.push({ kind: "message", text: block.text });
                    }
                }
                continue;
            }
            if (p.role === "user") {
                for (const block of content) {
                    if (block?.type !== "input_text" || typeof block.text !== "string") {
                        continue;
                    }
                    if (block.text.trim() === "" || isInjectedContext(block.text)) {
                        continue;
                    }
                    entries.push({ kind: "user", text: block.text });
                }
            }
            continue;
        }
        if (p.type === "function_call" || p.type === "custom_tool_call") {
            if (typeof p.name !== "string") {
                continue;
            }
            const target =
                p.type === "function_call"
                    ? p.name === "update_plan"
                        ? planTarget(p.arguments)
                        : shellTarget(p.arguments)
                    : patchTarget(p.input);
            const action: ActionEntry = { kind: "action", verb: verbFor(p.name), target };
            entries.push(action);
            if (typeof p.call_id === "string") {
                actionById.set(p.call_id, action);
            }
            continue;
        }
        if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
            if (typeof p.call_id !== "string") {
                continue;
            }
            const action = actionById.get(p.call_id);
            if (action == null) {
                continue;
            }
            if (outputIsError(p.output)) {
                action.outcome = "fail";
            } else if (action.verb === "ran") {
                action.outcome = "ok";
            }
        }
    }
    return entries;
}

/** Pure: the card task list from the LATEST update_plan tool call, or undefined if the agent never
 *  wrote a plan (Codex's TodoWrite-equivalent). `completed` -> done; every other status not-done.
 *  Steps with a non-string `step` are skipped; an empty plan yields []. Malformed arguments (JSON
 *  parse failure) or an absent `plan` array are ignored — they don't count as "a plan seen". */
export function extractCodexTasks(lines: string[]): CardTask[] | undefined {
    let latest: unknown[] | undefined;
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec?.type !== "response_item") {
            continue;
        }
        const p = rec.payload;
        if (p?.type !== "function_call" || p.name !== "update_plan" || typeof p.arguments !== "string") {
            continue;
        }
        try {
            const a = JSON.parse(p.arguments);
            if (Array.isArray(a?.plan)) {
                latest = a.plan;
            }
        } catch {
            // malformed arguments — not a plan we can read
        }
    }
    if (latest == null) {
        return undefined;
    }
    const tasks: CardTask[] = [];
    for (const s of latest) {
        const step = s as any;
        if (typeof step?.step !== "string") {
            continue;
        }
        tasks.push({ text: step.step, done: step.status === "completed" });
    }
    return tasks;
}
