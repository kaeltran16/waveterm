// Arc's second Claude Code mod: draws the transcript rows of the prompts Arc puts into a session. What the
// cockpit sends goes through the arc mod, and the engine never runs a plugin's render hook on a row that plugin
// raised, so this is a mod of its own. A run's launch prompt is claude's command-line argument, so its row has no
// plugin origin and is known by its text, inside an Arc block only.
// `wsh install-agent-hooks` installs it beside the arc mod; outside Arc no such row exists.
import type { EngineInterface, Register } from "claude-code";
import type { Card } from "./prompt-core";
import { parseRunPrompt, parseStreamPrompt, planTaskTitle, pointerPath } from "./prompt-core";
import { drawPromptRow } from "./prompt-row";
import { parseWake } from "./wake-core";
import { drawWakeRow } from "./wake-row";

// the width a row is laid out for where the surface has not measured
const DEFAULT_COLUMNS = 80;

// set at session.start; a reload runs register and session.start again, so it never goes stale
let inArc = false;

// a file a row is drawn from, read once: a prompt too long for a command line, a worker's plan
const files = new Map<string, Promise<string | null>>();

function readOnce($: EngineInterface, path: string): Promise<string | null> {
    let text = files.get(path);
    if (text == null) {
        text = $.fs.read(path).catch((err: unknown) => {
            $.ui.log(`arc-view: reading ${path} failed: ${String(err)}`, { to: "debug" });
            return null;
        });
        files.set(path, text);
    }
    return text;
}

// the card for a run's launch prompt, read from its file when it was too long for a command line
async function runCard($: EngineInterface, text: string): Promise<Card | null> {
    const pointer = pointerPath(text);
    const prompt = pointer == null ? text : await readOnce($, pointer);
    const c = prompt == null ? null : parseRunPrompt(prompt);
    if (c == null) {
        return null;
    }
    if (pointer != null) {
        c.tags.push("from a file");
    }
    if (c.planTask != null) {
        const plan = await readOnce($, c.planTask.path);
        const title = plan == null ? undefined : planTaskTitle(plan, c.planTask.n);
        if (title != null) {
            c.fields.unshift({ label: "task", value: title });
        }
    }
    return c;
}

export const register: Register = (on) => {
    on("session.start", async ($, e, next) => {
        inArc = Boolean(await $.env.get("WAVETERM_BLOCKID"));
        return next(e);
    });

    // a row is drawn as what it holds; the model reads it as sent, and ctrl+o shows that text
    on("ui.render", { component: "UserMessage" }, async ($, e, next) => {
        const { text, origin, isExpanded } = e.props;
        if (!inArc || isExpanded) {
            return next(e);
        }
        const els = $.ui.resolve(e);
        const columns = e.viewport?.columns ?? DEFAULT_COLUMNS;
        if (origin.kind === "plugin" && origin.name === "arc") {
            const wake = parseWake(text);
            if (wake != null) {
                return drawWakeRow(els, wake, columns);
            }
            const sent = parseStreamPrompt(text);
            if (sent != null) {
                return drawPromptRow(els, sent);
            }
        }
        const run = await runCard($, text);
        return run != null ? drawPromptRow(els, run) : next(e);
    });
};
