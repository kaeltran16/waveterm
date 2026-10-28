// Arc's Claude Code mod. `wsh install-agent-hooks` writes it to ~/.arc/claude-mod with the wsh path
// substituted and lists that folder in CLAUDE_CODE_PLUGIN_DIRS, so every claude launch loads it.
// outside an Arc block every hook passes straight through.
import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";
import { drawCacheMiss } from "./cache-band";
import { cacheMissNotice, transcriptEntries } from "./cache-core";
import { controlMsg, deliver, endTurn, steerNotice, takeLines } from "./control-core";
import type { Turn } from "./control-core";
import { ALL_CATEGORIES, applyEdit, goalpostNote, goalpostRole, inspectChange, inspectCommand } from "./goalpost-core";
import type { GoalpostFinding } from "./goalpost-core";
import { denial } from "./guard-core";
import { idleArgs } from "./status-core";
import { usageArgs } from "./usage-core";

const WSH = "__WSH_PATH__";

// set at session.start; a reload runs register and session.start again, so it never goes stale
let active = false;

// the session's transcript, as its latest prompt named it; a status report carries it so a cockpit
// that replays the report still follows the file. null after a reload until the next prompt
let transcriptPath: string | null = null;

// the last turn's cache miss, shown above the prompt until the next turn starts; null when none is
const cacheMiss = atom({ plugin: "arc", key: "cacheMiss" } as const, null);

// ponytail: turn.start does not say whose turn it is, so a background subagent starting one while the
// session is idle reads as open, and a mid-turn text sent then waits for the next turn. track turn ids
// against turn.step's agentId if that ever loses a tell
const turn: Turn = { isOpen: false, unread: [] };

// true while the cockpit's prompt stream is held, so a second session.start (a /clear) opens no second one
let listening = false;

// holds `wsh agentctl` for the session's life and runs each prompt the cockpit sends, so the engine need
// not type into the terminal. when the stream ends the engine goes back to typing
async function listenToCockpit($: EngineInterface) {
    if (listening) {
        return;
    }
    listening = true;
    const session = {
        // asUser: the model reads the engine's or the person's words bare, not as a note from a plugin
        submit: (text: string) => $.prompt.submit({ text, asUser: true }),
        steer: (text: string) => steerTurn($, text),
        command: (name: string, args: string) => $.command.run({ command: name, args }),
        compact: (instructions: string) => $.session.compact({ instructions }),
    };
    let buffered = "";
    try {
        for await (const chunk of $.process.spawn({ argv: [WSH, "agentctl"] })) {
            if (chunk.stream !== "stdout") {
                continue;
            }
            const taken = takeLines(buffered + chunk.text);
            buffered = taken.rest;
            for (const line of taken.lines) {
                const msg = controlMsg(line);
                if (msg === null) {
                    continue;
                }
                // not awaited: a prompt resolves only when its turn starts, and the next line may be due first
                void deliver(session, msg, turn).catch((err) =>
                    $.ui.log(`arc: running the cockpit's prompt failed: ${String(err)}`, { to: "debug" })
                );
            }
        }
    } catch (err) {
        $.ui.log(`arc: wsh agentctl failed: ${String(err)}`, { to: "debug" });
    } finally {
        listening = false;
    }
}

// appends text to the running turn as a row the model reads at its next request. that row draws nothing,
// so a log line the model never reads shows the person what arrived
async function steerTurn($: EngineInterface, text: string) {
    const kept = await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
    if (kept.deny !== undefined) {
        throw new Error(kept.deny);
    }
    $.ui.log(steerNotice(text));
}

// why this session may not run the shell command; null when it may, and always outside Arc
async function refusal($: EngineInterface, command: string, background?: boolean): Promise<string | null> {
    return active ? denial(command, await $.session.cwd(), background === true) : null;
}

// set once wsh answered `not a task worker`: the session's role does not change, so later findings skip the call
let isKnownNonWorker = false;

// what a change lowers the bar on; none outside Arc, and none when a detector throws, so the tool call goes on
async function goalposts($: EngineInterface, detect: () => GoalpostFinding[] | Promise<GoalpostFinding[]>) {
    if (!active) {
        return [];
    }
    try {
        return await detect();
    } catch (err) {
        $.ui.log(`arc: goalpost detection failed: ${String(err)}`, { to: "debug" });
        return [];
    }
}

// the file's text before the call; null when it is not there yet
async function currentText($: EngineInterface, path: string): Promise<string | null> {
    return (await $.fs.exists(path)) ? $.fs.read(path) : null;
}

// stores the findings on the task when this session is a run's task worker, and answers wsh's verdict;
// null when the report failed or was skipped
async function reportGoalposts($: EngineInterface, findings: GoalpostFinding[]): Promise<string | null> {
    if (isKnownNonWorker) {
        return null;
    }
    try {
        const wire = findings.map(({ rule, file, title, before, after }) => ({ rule, file, title, before, after }));
        const ran = await $.process.run([WSH, "jarvis", "dag", "goalpost", JSON.stringify(wire)]);
        if (ran.exitCode !== 0) {
            $.ui.log(`arc: wsh jarvis dag goalpost exited ${ran.exitCode}: ${ran.stderr.trim()}`, { to: "debug" });
            return null;
        }
        isKnownNonWorker = ran.stdout.trim() === "not a task worker";
        return ran.stdout;
    } catch (err) {
        $.ui.log(`arc: wsh jarvis dag goalpost failed: ${String(err)}`, { to: "debug" });
        return null;
    }
}

// runs the tool, then tells Claude what it lowered and whom to answer to. never denies and never asks:
// the task reviewer, the final report or the user judges it
async function withGoalposts<E, R extends { deny?: string; isError?: true; context?: readonly string[] }>(
    $: EngineInterface,
    findings: GoalpostFinding[],
    e: E,
    next: (e: E) => Promise<R>
): Promise<R> {
    const ran = await next(e);
    if (findings.length === 0 || ran.deny !== undefined || ran.isError) {
        return ran;
    }
    const isRunAgent = Boolean(await $.env.get("ARC_RUN_AGENT"));
    const answer = isRunAgent ? await reportGoalposts($, findings) : null;
    const note = goalpostNote(findings, goalpostRole(isRunAgent, answer));
    return { ...ran, context: [...(ran.context ?? []), note] };
}

// set while a question is in claude's own dialog, where the settings hooks beneath show the card for it.
// a question dismissed there runs no PostToolUse and no Stop hook, so the turn's end takes the card down
// and reports idle, or the cockpit reads asking until the next prompt
let isAskInDialog = false;

async function clearAsk($: EngineInterface) {
    try {
        await $.process.run([WSH, "ask", "--clear"]);
    } catch (err) {
        $.ui.log(`arc: wsh ask --clear failed: ${String(err)}`, { to: "debug" });
    }
}

// tells the person, and inside Arc the cockpit, what the turn that just ended re-billed for a missed
// prompt cache. the transcript comes through wsh, found by the session's id: the hook events that carry its
// path never reach this mod, and the mod's own file read rejects a file over 4 MiB
async function reportCacheMiss($: EngineInterface) {
    try {
        const tail = await $.process.run([WSH, "transcript-tail", await $.session.id()]);
        if (tail.exitCode !== 0) {
            // a session can end a turn before its transcript is first written
            $.ui.log(`arc: wsh transcript-tail exited ${tail.exitCode}: ${tail.stderr.trim()}`, { to: "debug" });
            return;
        }
        const notice = cacheMissNotice(transcriptEntries(tail.stdout));
        if (!notice) {
            return;
        }
        await update($, cacheMiss, () => notice);
        if (!active) {
            return;
        }
        const ran = await $.process.run([WSH, "notify", notice, "--level", "warn", "--transient"]);
        if (ran.exitCode !== 0) {
            $.ui.log(`arc: wsh notify exited ${ran.exitCode}: ${ran.stderr.trim()}`, { to: "debug" });
        }
    } catch (err) {
        $.ui.log(`arc: reporting a cache miss failed: ${String(err)}`, { to: "debug" });
    }
}

export const register: Register = (on) => {
    on("session.start", async ($, e, next) => {
        active = Boolean((await $.env.get("WAVETERM_BLOCKID")) && (await $.env.get("WAVETERM_JWT")));
        isKnownNonWorker = false;
        const started = await next(e);
        if (active) {
            void listenToCockpit($);
        }
        return started;
    });

    on("session.measure", async ($, e, next) => {
        const args = active ? usageArgs(e) : null;
        if (args) {
            try {
                const ran = await $.process.run([WSH, ...args]);
                if (ran.exitCode !== 0) {
                    $.ui.log(`arc: wsh agentstatus --usage exited ${ran.exitCode}: ${ran.stderr.trim()}`, { to: "debug" });
                }
            } catch (err) {
                // a dropped measurement self-heals on the next one, as a dropped statusLine publish did
                $.ui.log(`arc: wsh agentstatus --usage failed: ${String(err)}`, { to: "debug" });
            }
        }
        return next(e);
    });

    on("classic.UserPromptSubmit", ($, e, next) => {
        transcriptPath = e.transcript_path || null;
        return next(e);
    });

    on("turn.start", async ($, e, next) => {
        turn.isOpen = true;
        await update($, cacheMiss, () => null);
        return next(e);
    });

    // a tool's result means another request follows, and it carries every row joined so far.
    // ponytail: a text joined between the last result and a final answer's request is read and then
    // submitted again at the turn's end; twice beats never
    on("session.append", { door: "tool-result" }, ($, e, next) => {
        if (!e.agentId) {
            turn.unread = [];
        }
        return next(e);
    });

    on("turn.complete", async ($, e, next) => {
        const wasAskInDialog = isAskInDialog && !e.agentId;
        if (wasAskInDialog) {
            isAskInDialog = false;
            await clearAsk($);
        }
        for (const text of e.agentId ? [] : endTurn(turn)) {
            void $.prompt.submit({ text, asUser: true }).catch((err) =>
                $.ui.log(`arc: submitting an unread mid-turn text failed: ${String(err)}`, { to: "debug" })
            );
        }
        const args = active ? idleArgs(e, transcriptPath, wasAskInDialog) : null;
        if (args) {
            try {
                const ran = await $.process.run([WSH, ...args]);
                if (ran.exitCode !== 0) {
                    $.ui.log(`arc: wsh agentstatus --state idle exited ${ran.exitCode}: ${ran.stderr.trim()}`, { to: "debug" });
                }
            } catch (err) {
                // the idle notification still corrects the cockpit, later
                $.ui.log(`arc: wsh agentstatus --state idle failed: ${String(err)}`, { to: "debug" });
            }
        }
        // in every session, Arc's or not: the band shows the person the miss either way
        if (!e.agentId) {
            // not awaited: reading a long transcript must not hold the turn's end
            void reportCacheMiss($);
        }
        return next(e);
    });

    on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
        const notice = await read($, cacheMiss);
        return notice && !e.props.hasSurvey ? drawCacheMiss($.ui.resolve(e), notice) : next(e);
    });

    // refused in code: a prompt's rule is one the model can talk itself out of
    on("tool.call", { tool: "Bash" }, async ($, e, next) => {
        const why = await refusal($, e.command, e.run_in_background);
        if (why !== null) {
            return { deny: why };
        }
        return withGoalposts($, await goalposts($, () => inspectCommand(e.command, ALL_CATEGORIES)), e, next);
    });

    on("tool.call", { tool: "PowerShell" }, async ($, e, next) => {
        const why = await refusal($, e.command, e.run_in_background);
        if (why !== null) {
            return { deny: why };
        }
        return withGoalposts($, await goalposts($, () => inspectCommand(e.command, ALL_CATEGORIES)), e, next);
    });

    on("tool.call", { tool: "Edit" }, async ($, e, next) => {
        const findings = await goalposts($, async () => {
            const before = await currentText($, e.file_path);
            const after = before === null ? null : applyEdit(before, e.old_string, e.new_string, e.replace_all);
            return after === null ? [] : inspectChange({ path: e.file_path, before, after }, ALL_CATEGORIES);
        });
        return withGoalposts($, findings, e, next);
    });

    on("tool.call", { tool: "Write" }, async ($, e, next) => {
        const findings = await goalposts($, async () =>
            inspectChange(
                { path: e.file_path, before: await currentText($, e.file_path), after: e.content },
                ALL_CATEGORIES
            )
        );
        return withGoalposts($, findings, e, next);
    });

    // every question goes to claude's own dialog, so it reads the same at any terminal width and on every
    // machine. the settings hooks beneath show Arc's card for it, and the card answers by typing into the dialog
    on("tool.call", { tool: "AskUserQuestion" }, ($, e, next) => {
        isAskInDialog = active;
        return next(e);
    });
};
