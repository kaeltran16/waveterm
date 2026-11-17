// Arc's Claude Code mod. `wsh install-agent-hooks` writes it to ~/.arc/claude-mod with the wsh path
// substituted and lists that folder in CLAUDE_CODE_PLUGIN_DIRS, so every claude launch loads it.
// outside an Arc block every hook passes straight through.
import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";
import { drawCacheMiss } from "./cache-band";
import { cacheMissNotice, transcriptEntries } from "./cache-core";
import { claudecmdsArgs, commandsPayload } from "./commands-core";
import { controlMsg, deliver, isDropped, steerNotice, takeLines } from "./control-core";
import type { Session } from "./control-core";
import { ALL_CATEGORIES, applyEdit, goalpostNote, goalpostRole, inspectChange, inspectCommand } from "./goalpost-core";
import type { GoalpostFinding } from "./goalpost-core";
import { denial } from "./guard-core";
import {
    hold,
    isHeld,
    joinNow,
    newQueue,
    newStep,
    personsHeld,
    putBack,
    release,
    report,
    resultsStored,
    settle,
    stepEnded,
    takeBack,
    turnEndPlan,
} from "./queue-core";
import type { Held } from "./queue-core";
import {
    isTaggable,
    mentionContext,
    mentionQuery,
    needsFetch,
    parseAgents,
    submittedTags,
    suggestions,
} from "./mention-core";
import type { AgentRow, Suggestion } from "./mention-core";
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

// the JSON of the slash-command list wavesrv last took, "" before the first. the Rendered box's `/` panel reads that
// list, so a publish sends only when the list differs from this
let lastCommands = "";

// the pending second publish after session.start, so a /clear (session.start again) does not stack timers
let commandsTimer: { cancel(): void } | null = null;

// tells wavesrv the commands Claude Code's own typeahead shows now: the bundled skills, a mod's commands and MCP
// prompts, which `~/.claude` does not hold. only inside Arc. a failed call is logged and not retried on its own:
// lastCommands stays as it was, so the next publish sends the list again
async function publishCommands($: EngineInterface): Promise<void> {
    if (!active) {
        return;
    }
    try {
        const payload = commandsPayload(await $.command.list());
        if (payload === lastCommands) {
            return;
        }
        const ran = await $.process.run([WSH, ...claudecmdsArgs()], { stdin: payload, timeoutMs: 10_000 });
        if (ran.exitCode === 0) {
            lastCommands = payload;
        } else {
            $.ui.log(`arc: wsh claudecmds set exited ${ran.exitCode}: ${ran.stderr.trim()}`, { to: "debug" });
        }
    } catch (err) {
        $.ui.log(`arc: publishing the slash commands failed: ${String(err)}`, { to: "debug" });
    }
}

// the publishes session.start owes: one now, and one once the MCP servers have connected (they do after the session
// starts). the second is a $.clock.after, not a detached sleep: a sleep's wait is the hook's own time and would bill
// to its budget. a /clear or a reload runs session.start again, so the list is sent again even when it is the same
function publishCommandsAtStart($: EngineInterface): void {
    lastCommands = "";
    void publishCommands($);
    try {
        commandsTimer?.cancel();
        commandsTimer = $.clock.after(10_000, () => void publishCommands($));
    } catch (err) {
        $.ui.log(`arc: scheduling the slash commands' second publish failed: ${String(err)}`, { to: "debug" });
    }
}

// whether the main loop's turn runs: a mid-turn text is held only then, else it runs at once
let isTurnOpen = false;

// the texts held for the main loop's next request or its turn's end. session.start makes a fresh one
let queue = newQueue("start");

// the main loop's current request: Arc's held prompts join once its response and every tool result are in
let step = newStep();

// set by the person's Stop until the next turn: the interrupted call's result ends the batch but no request
// follows it, and the engine refuses the mod's prompts until the person next sends input
let isStopping = false;

// the reports wavesrv has yet to take, sent one at a time in order
let reports: Promise<void> = Promise.resolve();

// a report is the whole held list as of the call, plus every left entry no report has carried yet. a failed
// take-back report holds its items again and reports them so: wavesrv refused it, and the box did not get them
function reportQueue($: EngineInterface, takenBack?: { request: string; items: Held[] }) {
    if (!active) {
        return;
    }
    const payload = report(queue, takenBack?.request);
    reports = reports.then(async () => {
        try {
            const ran = await $.process.run([WSH, "agentqueue", "set"], {
                stdin: JSON.stringify(payload),
                timeoutMs: 10_000,
            });
            if (ran.exitCode === 0) {
                settle(queue, payload.left);
                return;
            }
            $.ui.log(`arc: wsh agentqueue set exited ${ran.exitCode}: ${ran.stderr.trim()}`, { to: "debug" });
        } catch (err) {
            $.ui.log(`arc: reporting the queue failed: ${String(err)}`, { to: "debug" });
        }
        if (takenBack && takenBack.items.length > 0) {
            putBack(queue, takenBack.items);
            reportQueue($);
        }
    });
}

// what the cockpit's messages run through
function sessionOf($: EngineInterface): Session {
    return {
        // asUser: the model reads the engine's or the person's words bare, not as a note from a plugin
        submit: (text: string) => $.prompt.submit({ text, asUser: true }),
        command: (name: string, args: string) => $.command.run({ command: name, args }),
        compact: (instructions: string) => $.session.compact({ instructions }),
    };
}

// resolves the engine's answer to a send, failing on a refusal, which the engine answers rather than throws
async function entered(sent: Promise<unknown>): Promise<void> {
    const result = await sent;
    if (isDropped(result)) {
        throw new Error(`refused: ${(result as { drop: string }).drop}`);
    }
}

// joins Arc's held prompts to the turn, in arrival order, for the request about to go out. one the session
// refuses is held again with those after it, so the turn's end sends them in order
async function joinHeld($: EngineInterface) {
    const joined = joinNow(queue);
    for (const [i, item] of joined.entries()) {
        try {
            await steerTurn($, item.text);
        } catch (err) {
            $.ui.log(`arc: joining a mid-turn text failed: ${String(err)}`, { to: "debug" });
            putBack(queue, joined.slice(i));
            break;
        }
    }
}

// sends what the turn left held as the next prompts, in order. after the person's Stop the engine refuses them
// all, so the person's go back to the box (reported lost) and Arc's wait for the next turn. a send refused or
// failed otherwise holds its texts again, still reported, so the person can take theirs back rather than lose it
function sendHeld($: EngineInterface) {
    if (isStopping) {
        const persons = personsHeld(queue);
        if (persons.length > 0) {
            release(queue, persons);
            reportQueue($);
        }
        return;
    }
    const plan = turnEndPlan(queue);
    const session = sessionOf($);
    for (const action of plan) {
        const sent = action.kind === "command" ? deliver(session, { text: action.text }) : session.submit(action.text);
        void entered(sent).catch((err) => {
            $.ui.log(`arc: sending a held mid-turn text failed: ${String(err)}`, { to: "debug" });
            putBack(queue, action.items);
            reportQueue($);
        });
    }
    if (plan.some((action) => action.items.some((item) => item.id !== undefined))) {
        reportQueue($);
    }
}

// a person's text the engine refused at once (after their Stop, until they type): reported held and then
// missing, so wavesrv reads it as lost and the box gets it back
async function returnToBox($: EngineInterface, text: string) {
    const item = hold(queue, text, true, await $.clock.now());
    reportQueue($);
    release(queue, [item]);
    reportQueue($);
}

// one line of the cockpit's stream: a take-back answers with the person's held items, a text the running
// turn holds waits for its next request, and the rest runs at once
async function onControl($: EngineInterface, session: Session, line: string) {
    const msg = controlMsg(line);
    if (msg === null) {
        return;
    }
    if ("takeBack" in msg) {
        reportQueue($, { request: msg.takeBack, items: takeBack(queue) });
        return;
    }
    if (isHeld(msg, isTurnOpen)) {
        const isPerson = "queue" in msg && msg.queue === true;
        hold(queue, msg.text, isPerson, await $.clock.now());
        if (isPerson) {
            reportQueue($);
        }
        return;
    }
    // not awaited: a prompt resolves only when its turn starts, and the next line may be due first
    void entered(deliver(session, msg)).catch(async (err) => {
        $.ui.log(`arc: running the cockpit's prompt failed: ${String(err)}`, { to: "debug" });
        if ("queue" in msg && msg.queue === true) {
            await returnToBox($, msg.text);
        }
    });
}

// true while the cockpit's prompt stream is held, so a second session.start (a /clear) opens no second one
let listening = false;

// holds `wsh agentctl` for the session's life and runs each prompt the cockpit sends, so the engine need
// not type into the terminal. when the stream ends the engine goes back to typing
async function listenToCockpit($: EngineInterface) {
    if (listening) {
        return;
    }
    listening = true;
    const session = sessionOf($);
    let buffered = "";
    try {
        for await (const chunk of $.process.spawn({ argv: [WSH, "agentctl"] })) {
            if (chunk.stream !== "stdout") {
                continue;
            }
            const taken = takeLines(buffered + chunk.text);
            buffered = taken.rest;
            for (const line of taken.lines) {
                await onControl($, session, line);
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

// this project's other live agent tabs; throws with wsh's words when it fails or prints no roster
async function liveAgents($: EngineInterface): Promise<AgentRow[]> {
    const ran = await $.process.run([WSH, "agents", "list", "--json", "--others"]);
    if (ran.exitCode !== 0) {
        throw new Error(`wsh exited ${ran.exitCode}: ${ran.stderr.trim()}`);
    }
    return parseAgents(ran.stdout);
}

// the roster for the @@ tag being typed, fetched once per tag: a failed fetch is an empty roster until the
// next tag, so a broken wsh costs one spawn per tag, not one per keystroke
let mentionCache: { start: number; rows: Promise<AgentRow[]> } | null = null;

function typeaheadAgents($: EngineInterface, token: string, start: number): Promise<AgentRow[]> {
    if (mentionCache !== null && !needsFetch(mentionCache.start, token, start)) {
        return mentionCache.rows;
    }
    const rows = liveAgents($).catch((err): AgentRow[] => {
        $.ui.log(`arc: wsh agents list failed: ${String(err)}`, { to: "debug" });
        return [];
    });
    mentionCache = { start, rows };
    return rows;
}

export const register: Register = (on) => {
    on("session.start", async ($, e, next) => {
        active = Boolean((await $.env.get("WAVETERM_BLOCKID")) && (await $.env.get("WAVETERM_JWT")));
        isKnownNonWorker = false;
        mentionCache = null;
        // a reload or a /clear starts empty: the empty report has wavesrv hand back anything held before
        queue = newQueue(String(await $.clock.now()));
        const started = await next(e);
        if (active) {
            void listenToCockpit($);
            publishCommandsAtStart($);
            reportQueue($);
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

    // bare @ is claude code's file mention and stays untouched
    on("prompt.autocomplete", { token: /^@@/ }, async ($, e, next) => {
        if (!active) {
            return next(e);
        }
        let mine: Suggestion[] = [];
        try {
            mine = suggestions(await typeaheadAgents($, e.token, e.start), mentionQuery(e.token) ?? "");
        } catch (err) {
            $.ui.log(`arc: @@ typeahead failed: ${String(err)}`, { to: "debug" });
        }
        return { suggestions: [...mine, ...(await next(e)).suggestions] };
    });

    // the roster is fetched fresh, not from the typeahead: a tagged agent may have closed since the pick.
    // only context for this agent is attached; the user's text goes to no one else
    on("prompt.submit", async ($, e, next) => {
        let context = "";
        try {
            const tags = active && isTaggable(e) ? submittedTags(e.text) : [];
            if (tags.length > 0) {
                const roster = await liveAgents($).catch((err): { error: string } => ({
                    error: err instanceof Error ? err.message : String(err),
                }));
                context = mentionContext(tags, roster);
            }
        } catch (err) {
            $.ui.log(`arc: resolving @@ tags failed: ${String(err)}`, { to: "debug" });
        }
        return context ? next({ ...e, context: [...(e.context ?? []), context] }) : next(e);
    });

    on("turn.start", async ($, e, next) => {
        if (!e.agentId) {
            isTurnOpen = true;
            isStopping = false;
            step = newStep();
        }
        await update($, cacheMiss, () => null);
        return next(e);
    });

    // a step's whole response says how many tool calls it made; a step whose calls all finished while it still
    // streamed has its batch in now. an interrupted step joins nothing: the turn's end sends what is held
    on("turn.step", async function* ($, e, next) {
        if (e.agentId) {
            return yield* next(e);
        }
        step = newStep();
        const response = yield* next(e);
        if (stepEnded(step, response.toolUses.length) && !isStopping && !next.signal.aborted) {
            await joinHeld($);
        }
        return response;
    });

    // raised before the abort, so it is noted before the interrupted call's result arrives
    on("session.stop", ($, e, next) => {
        isStopping = isStopping || e.isTurnRunning;
        return next(e);
    });

    // the last result of a step's batch means the next request is about to go out: Arc's held prompts join it
    // then, after every result, so the model reads them at once and no later request carries them again
    on("session.append", { door: "tool-result" }, async ($, e, next) => {
        const kept = await next(e);
        if (e.agentId) {
            return kept;
        }
        const results = e.message.content.filter((block) => block.type === "tool_result").length;
        if (resultsStored(step, results) && !isStopping && !next.signal.aborted) {
            await joinHeld($);
        }
        return kept;
    });

    on("turn.complete", async ($, e, next) => {
        const wasAskInDialog = isAskInDialog && !e.agentId;
        if (wasAskInDialog) {
            isAskInDialog = false;
            await clearAsk($);
        }
        if (!e.agentId) {
            isTurnOpen = false;
            sendHeld($);
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
