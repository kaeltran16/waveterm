// Arc's Claude Code mod. `wsh install-agent-hooks` writes it to ~/.arc/claude-mod with the wsh path
// substituted and lists that folder in CLAUDE_CODE_PLUGIN_DIRS, so every claude launch loads it.
// outside an Arc block every hook passes straight through.
import type { Register } from "claude-code";
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
};
