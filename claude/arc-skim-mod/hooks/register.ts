// skim: highlights the sentences of a reply worth reading (highlight-core.ts). claude marks them, the mod strips the
// marks before the reply is stored and draws them in the terminal alone, dimming the rest of an explanation.
// based on ttqteo/claude-skim (MIT, see LICENSE); `wsh install-agent-hooks` installs it beside the arc mods.
// two /config rows control it: highlight (off: claude is not asked to mark) and dim (/skim flips it).
import type { EngineInterface, Register } from "claude-code";
import { atom, read, update } from "claude-code";
import type { Ask } from "../types";
import type { Kept, Mark, Settings } from "./highlight-core";
import {
    askOf,
    canSkim,
    DIM_KEY,
    hashText,
    HIGHLIGHT_SECTION,
    isAskInView,
    isKept,
    keepMarks,
    layout,
    parseMarks,
    rowsFromAsk,
    settingAfter,
    settingsOf,
    shownMarks,
    submitContext,
} from "./highlight-core";
import type { Palette } from "./highlight-row";
import { drawAskLine, drawHighlighted, paletteFor } from "./highlight-row";

// the width a row is laid out for where the surface has not measured
const DEFAULT_COLUMNS = 80;

// the columns a reply's text loses to the bullet before it
const REPLY_INDENT = 2;

// the marks of stored replies, by the hash of the text stored, kept across sessions so a resumed one still draws them
const STORE_KEY = "highlightMarks";

// how often the band learns whether the question has scrolled out of view: a render hook may not write state
const ASK_POLL_MS = 250;

// the engine's scan reads an atom's plugin and key as literals, so PLUGIN is spelled out here
const ask = atom({ plugin: "arc-skim", key: "ask" } as const, null);
const isAskHidden = atom({ plugin: "arc-skim", key: "isAskHidden" } as const, false);

// module copies, refilled at session.start after a reload
let byHash = new Map<string, Mark[]>();
let palette: Palette = paletteFor(undefined);
let settings: Settings = settingsOf({});
let askNow: Ask | null = null;
// what the ask's row last reported about its rows; the timer carries it into state
let isAskOutOfView = false;
let stopAskPoll: (() => void) | null = null;
// whether this load's prompt.compose hook ran on an interactive prompt, and whether a prompt already carried the ask
let isComposed = false;
let hasTold = false;
let isInteractive = true;

function storedKept(value: unknown): Kept {
    return isKept(value) ? value : [];
}

async function setAsk($: EngineInterface, next: Ask | null) {
    askNow = next;
    isAskOutOfView = false;
    await update($, isAskHidden, () => false);
    await update($, ask, () => next);
}

export const register: Register = (on, options) => {
    settings = settingsOf(options);

    on("session.start", async ($, e, next) => {
        isInteractive = e.isInteractive;
        byHash = new Map(storedKept(await $.store.get(STORE_KEY)));
        palette = paletteFor((await $.config.list()).find((row) => row.key === "theme")?.value);
        askNow = await read($, ask);
        await $.command.register({
            name: "skim",
            description: "Turn the dimming of explanations off or on (the arc-skim dim row of /config)",
        });
        // a session start after /clear or a resume would otherwise leave the last one's timer running beside it
        stopAskPoll?.();
        stopAskPoll = $.clock.every(ASK_POLL_MS, () => {
            void read($, isAskHidden).then((isHidden) => {
                if (isHidden !== isAskOutOfView) {
                    void update($, isAskHidden, () => isAskOutOfView);
                }
            });
        });
        return next(e);
    });

    // a /config change to the theme or to one of the mod's rows, as written
    on("config.set", async ($, e, next) => {
        const done = await next(e);
        if (done.deny) {
            return done;
        }
        if (e.key === "theme") {
            palette = paletteFor(done.value);
        }
        settings = settingAfter(settings, e.key, done.value);
        $.ui.invalidate("ui.render");
        return done;
    });

    // the one fixed section asking claude to mark; a headless run draws nothing, so it is not told
    on("prompt.compose", async ($, e, next) => {
        const composed = await next(e);
        if (e.traits.includes("print") || e.traits.includes("bare")) {
            return composed;
        }
        isComposed = true;
        if (!settings.isHighlightOn) {
            return composed;
        }
        return {
            sections: [
                ...composed.sections,
                { id: "skim:highlight", text: HIGHLIGHT_SECTION, scope: "session" as const },
            ],
        };
    });

    // the reply is stored, sent again and copied without its marks; they are kept apart under the stored text.
    // stripped with highlighting off too, so a reply marked before the switch never stores its marks
    on("session.append", { door: "response" }, async ($, e, next) => {
        const content = [...e.message.content];
        // the row's last text, which says what the reply leaves waiting on the person
        let last: Ask | null | undefined;
        const found: [string, Mark[]][] = [];
        content.forEach((block, i) => {
            if (block.type !== "text" || typeof block.text !== "string") {
                return;
            }
            const { clean, marks } = parseMarks(block.text);
            const hash = hashText(clean);
            const question = askOf(marks);
            last = question ? { hash, text: question } : null;
            if (marks.length > 0) {
                found.push([hash, marks]);
                content[i] = { ...block, text: clean };
            }
        });
        if (found.length > 0) {
            // every session writes the one list: read it again so a parallel session's marks are not written over
            const stored = storedKept(await $.store.get(STORE_KEY));
            const kept = found.reduce((all, [hash, marks]) => keepMarks(all, hash, marks), stored);
            byHash = new Map(kept);
            await $.store.set(STORE_KEY, kept);
        }
        if (last !== undefined && !e.agentId) {
            await setAsk($, settings.isHighlightOn ? last : null);
        }
        return found.length > 0 ? next({ ...e, message: { ...e.message, content } }) : next(e);
    });

    // the person answered, or moved on; and the ask rides with the prompt where the system prompt never took it
    on("prompt.submit", async ($, e, next) => {
        if (askNow) {
            await setAsk($, null);
        }
        const context = settings.isHighlightOn
            ? submitContext({ isInteractive, isCommand: !!e.command, isComposed, hasTold })
            : null;
        if (!context) {
            return next(e);
        }
        hasTold = true;
        return next({ ...e, context: [...(e.context ?? []), context] });
    });

    // flips the dim row; a plugin's own $.config.set reaches none of its hooks, so the copy is set here
    on("command.run", { command: "skim" }, async ($) => {
        const isDimOn = !settings.isDimOn;
        const result = await $.config.set({ key: DIM_KEY, value: isDimOn });
        if (result.deny) {
            $.ui.toast(`Skim: ${result.deny}`);
            return {};
        }
        settings = { ...settings, isDimOn };
        $.ui.invalidate("ui.render");
        $.ui.toast(
            isDimOn
                ? "Skim on: an explanation dims all but its highlighted sentences"
                : "Skim off: explanations draw in full"
        );
        return {};
    });

    // marked while it streams, stored without the marks once done: either way the marked sentences draw highlighted
    on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
        const { clean, marks: written } = parseMarks(e.props.text);
        const hash = hashText(clean);
        if (askNow?.hash === hash && e.props.onScreen !== undefined) {
            const columns = (e.viewport?.columns ?? DEFAULT_COLUMNS) - REPLY_INDENT;
            isAskOutOfView = !isAskInView(e.props.onScreen, rowsFromAsk(clean, askNow.text, columns));
        }
        const all = written.length > 0 ? written : (byHash.get(hash) ?? []);
        const marks = shownMarks(all);
        if (!settings.isHighlightOn || e.surface !== "terminal" || e.props.isSummary || marks.length === 0) {
            return written.length > 0 ? next({ ...e, props: { ...e.props, text: clean } }) : next(e);
        }
        // a brainstorm turn, its last mark the question waiting on the person, draws in full: its options are to be
        // read. so does a reply marked through most of its length
        const isSkim = askOf(all) === null && canSkim(clean, marks) && settings.isDimOn;
        return drawHighlighted($.ui.resolve(e), layout(clean, marks, isSkim), isSkim, palette, e.props.isFirstOfReply);
    });

    // the question the last reply asks, above the prompt while its rows are out of view (the fullscreen terminal
    // reports them; the main screen does not, and the line never shows there)
    on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
        const waiting = await read($, ask);
        const isHidden = await read($, isAskHidden);
        if (!waiting || !isHidden || e.props.hasSurvey || e.surface !== "terminal") {
            return next(e);
        }
        return drawAskLine($.ui.resolve(e), waiting.text, await next(e));
    });
};
