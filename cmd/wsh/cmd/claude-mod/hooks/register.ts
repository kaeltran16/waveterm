// Arc's Claude Code mod. `wsh install-agent-hooks` writes it to ~/.arc/claude-mod with the wsh path
// substituted and lists that folder in CLAUDE_CODE_PLUGIN_DIRS, so every claude launch loads it.
// outside an Arc block every hook passes straight through.
import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";
import { drawAskPicker, drawNoQuestion } from "./ask-pane";
import {
    answersFor,
    askPayload,
    cardCanAsk,
    confirmMarked,
    openPicker,
    parseAskReply,
    pickOption,
    pickerReply,
    pickerRows,
    typeOther,
} from "./ask-core";
import type { AskReply } from "./ask-core";
import type { Picker } from "../types";
import { controlMsg, deliver, endTurn, steerNotice, takeLines } from "./control-core";
import type { Turn } from "./control-core";
import { idleArgs } from "./status-core";
import { usageArgs } from "./usage-core";

const WSH = "__WSH_PATH__";

// set at session.start; a reload runs register and session.start again, so it never goes stale
let active = false;

// the session's transcript, as its latest prompt named it; a status report carries it so a cockpit
// that replays the report still follows the file. null after a reload until the next prompt
let transcriptPath: string | null = null;

// the pane the picker opens in: focused, so the arrows and Enter pick as in claude's own dialog
const ASK_PANE = "arc-ask";

// the question the terminal's picker is showing; null when none is
const picker = atom({ plugin: "arc", key: "picker" } as const, null);

// resolves the tool.call hook waiting on the picker. a module variable: a reload drops it with the
// dispatch it served
let settlePicker: ((reply: AskReply) => void) | null = null;

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

async function closePicker($: EngineInterface) {
    try {
        await update($, picker, () => null);
        await $.ui.close({ id: ASK_PANE });
    } catch (err) {
        $.ui.log(`arc: closing the ask picker failed: ${String(err)}`, { to: "debug" });
    }
}

export const register: Register = (on) => {
    on("session.start", async ($, e, next) => {
        active = Boolean((await $.env.get("WAVETERM_BLOCKID")) && (await $.env.get("WAVETERM_JWT")));
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

    on("turn.start", ($, e, next) => {
        turn.isOpen = true;
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
        for (const text of e.agentId ? [] : endTurn(turn)) {
            void $.prompt.submit({ text, asUser: true }).catch((err) =>
                $.ui.log(`arc: submitting an unread mid-turn text failed: ${String(err)}`, { to: "debug" })
            );
        }
        const args = active ? idleArgs(e, transcriptPath) : null;
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
        return next(e);
    });

    on("ui.render", { component: "Pane", requestId: ASK_PANE }, async ($, e) => {
        const shown = await read($, picker);
        const idle = drawNoQuestion($.ui.resolve(e));
        if (e.surface === "mobile" || !shown) {
            return idle;
        }
        const step = async (change: (p: Picker) => Picker) => {
            const after = await update($, picker, (p) => (p ? change(p) : p));
            const reply = after ? pickerReply(after) : null;
            if (reply) {
                settlePicker?.(reply);
            }
        };
        const drawn = drawAskPicker($.ui.resolve(e), shown, {
            pick: (n) => void step((p) => pickOption(p, n)),
            confirm: () => void step(confirmMarked),
            other: (text) => void step((p) => typeOther(p, text)),
        });
        return drawn ?? idle;
    });

    // Esc in the pane, or its close mark, dismisses the question as Esc does in claude's own dialog
    on("ui.close", { id: ASK_PANE }, ($, e, next) => {
        if (e.origin.kind === "person") {
            settlePicker?.({ answers: [], cancelled: true });
        }
        return next(e);
    });

    // the hook answers the call itself, from the cockpit card or the terminal's picker, whichever the
    // person uses first, so claude's dialog does not open. a dialog cannot be cancelled once next(e)
    // opened it, so it could not race the card; the picker can, since the mod draws and closes it.
    on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
        if (!active || !cardCanAsk(e.questions)) {
            return next(e);
        }
        let isFromPicker = false;
        const fromPicker = new Promise<AskReply>((resolve) => {
            settlePicker = (answered) => {
                isFromPicker = true;
                resolve(answered);
            };
        });
        try {
            const opening = openPicker(e.questions);
            await update($, picker, () => opening);
            const opened = await $.ui.open({
                id: ASK_PANE,
                title: "Question",
                focus: true,
                closeOnEscape: true,
                rows: pickerRows(opening),
            });
            if (!opened.isPlaced) {
                // a pane the mod opens unasked is not drawn on a narrow terminal, and nothing else a
                // mod draws takes the arrows. claude's dialog does; the settings hooks beneath show
                // the card for it
                settlePicker = null;
                await closePicker($);
                return next(e);
            }
        } catch (err) {
            // no picker: the card alone answers
            $.ui.log(`arc: ask picker failed: ${String(err)}`, { to: "debug" });
        }
        $.ui.status("Waiting for your answer here or in Arc's ask card");
        // spawn, not run: run gives up after ten minutes, and a question can wait longer
        const wait = $.process.spawn({ argv: [WSH, "ask", "--wait"], input: askPayload(e.questions) });
        const fromCard = (async () => {
            let out = "";
            try {
                for await (const chunk of wait) {
                    if (chunk.stream === "stdout") {
                        out += chunk.text;
                    }
                }
            } catch (err) {
                $.ui.log(`arc: wsh ask --wait failed: ${String(err)}`, { to: "debug" });
            }
            return parseAskReply(out);
        })();
        let reply: AskReply | null = null;
        try {
            reply = await Promise.race([fromPicker, fromCard]);
        } finally {
            settlePicker = null;
            $.ui.status(undefined);
        }
        await closePicker($);
        if (isFromPicker) {
            // ending the stream kills wsh, and the server's waiter cancel takes the card down
            void wait.return(undefined as never).catch(() => undefined);
        }
        if (reply?.cancelled) {
            return { deny: "The user dismissed the question." };
        }
        if (reply) {
            return { result: { questions: e.questions, answers: answersFor(e.questions, reply) } };
        }
        // no answer came back: take the card down so it cannot answer a question nobody is asking
        try {
            await $.process.run([WSH, "ask", "--clear"]);
        } catch (err) {
            $.ui.log(`arc: wsh ask --clear failed: ${String(err)}`, { to: "debug" });
        }
        if (next.signal.aborted) {
            return { deny: "Interrupted by the user." };
        }
        // wsh failed or hit its 30-minute ceiling: the question still reaches the user, in claude's dialog
        return next(e);
    });
};
