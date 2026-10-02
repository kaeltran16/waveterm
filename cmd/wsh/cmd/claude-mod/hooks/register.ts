// Arc's Claude Code mod. `wsh install-agent-hooks` writes it to ~/.arc/claude-mod with the wsh path
// substituted and lists that folder in CLAUDE_CODE_PLUGIN_DIRS, so every claude launch loads it.
// outside an Arc block every hook passes straight through.
import type { Register } from "claude-code";
import { answersFor, askPayload, cardCanAsk, parseAskReply } from "./ask-core";
import { usageArgs } from "./usage-core";

const WSH = "__WSH_PATH__";

// set at session.start; a reload runs register and session.start again, so it never goes stale
let active = false;

export const register: Register = (on) => {
    on("session.start", async ($, e, next) => {
        active = Boolean((await $.env.get("WAVETERM_BLOCKID")) && (await $.env.get("WAVETERM_JWT")));
        return next(e);
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

    // the cockpit card is the answer surface: the hook answers the call itself, so claude's dialog never
    // opens. a dialog cannot be cancelled once next(e) opened it, so the two cannot race.
    on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
        if (!active || !cardCanAsk(e.questions)) {
            return next(e);
        }
        $.ui.status("Waiting for your answer in Arc's ask card");
        let out = "";
        try {
            // spawn, not run: run gives up after ten minutes, and a question can wait longer
            for await (const chunk of $.process.spawn({ argv: [WSH, "ask", "--wait"], input: askPayload(e.questions) })) {
                if (chunk.stream === "stdout") {
                    out += chunk.text;
                }
            }
        } catch (err) {
            $.ui.log(`arc: wsh ask --wait failed: ${String(err)}`, { to: "debug" });
        } finally {
            $.ui.status(undefined);
        }
        const reply = parseAskReply(out);
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
