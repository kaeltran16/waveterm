// Pure logic of the phone page's chat with a handed-over agent, with no DOM, so chatmodel.test.js can cover
// it; chat.js draws from it. Entries are the cockpit projectors' AgentEntry values (projectors.js).

import { formatAge } from "./model.js";

const FENCE = /^\s*```\s*([^`\s]*)/;
const EDIT_VERBS = new Set(["edited", "wrote"]);
const SECOND = 1000;
const HOUR_S = 3600;

const ENDED = {
    taken: (name) =>
        `${name} was taken back, here or at the desk, so it no longer takes messages from the phone. Hand it over again from the Agent surface.`,
    exited: (name) => `${name} exited, so it is off the phone.`,
};

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// blank lines around a fence belong to neither side
const trimBlankLines = (s) => s.replace(/^(\s*\n)+/, "").replace(/(\n\s*)+$/, "");

/**
 * A reply as text and fenced code parts. Text keeps its line breaks; there is no other markdown, and every
 * part is drawn as text, so a reply that holds markup shows that markup. An unclosed fence runs to the end.
 */
export function splitReply(text) {
    const parts = [];
    let buf = [];
    let code = null; // { lang } while inside a fence
    const flush = () => {
        if (code) {
            parts.push({ kind: "code", lang: code.lang, text: buf.join("\n") });
        } else {
            const t = trimBlankLines(buf.join("\n"));
            if (t) {
                parts.push({ kind: "text", text: t });
            }
        }
        buf = [];
    };
    for (const line of (text ?? "").split("\n")) {
        const fence = FENCE.exec(line);
        if (!fence) {
            buf.push(line);
            continue;
        }
        flush();
        code = code ? null : { lang: fence[1] };
    }
    if (code || buf.length) {
        flush();
    }
    return parts;
}

function duration(ms) {
    if (!(ms > 0)) {
        return "";
    }
    const s = Math.round(ms / SECOND);
    if (s < 60) {
        return `${s}s`;
    }
    if (s >= HOUR_S) {
        const m = Math.floor((s % HOUR_S) / 60);
        return m ? `${Math.floor(s / HOUR_S)}h ${m}m` : `${Math.floor(s / HOUR_S)}h`;
    }
    const rest = s % 60;
    return rest ? `${Math.floor(s / 60)}m ${rest}s` : `${Math.floor(s / 60)}m`;
}

function actionItem(e) {
    const item = {
        kind: "action",
        mark: e.outcome === "ok" ? "ok" : e.outcome === "fail" ? "fail" : "pending",
        verb: capitalize(e.verb),
        target: e.target ?? "",
        summary: e.summary || duration(e.durationMs),
        startedTs: e.startedTs,
    };
    if (e.detail?.kind === "edit") {
        item.adds = e.detail.files.reduce((n, f) => n + (f.adds ?? 0), 0);
        item.dels = e.detail.files.reduce((n, f) => n + (f.dels ?? 0), 0);
    }
    return item;
}

/** How long a call still running has run, or "" when its start is unknown. */
export function liveElapsed(item, now) {
    return item.startedTs > 0 ? duration(Math.max(SECOND, now - item.startedTs)) : "";
}

/** The chat's rows: the owner's messages, one-line tool calls and replies. Other entries are left out. */
export function chatItems(entries) {
    const items = [];
    for (const e of entries ?? []) {
        if (e.kind === "user") {
            items.push({ kind: "user", text: e.text });
        } else if (e.kind === "action") {
            items.push(actionItem(e));
        } else if (e.kind === "message") {
            const parts = splitReply(e.text);
            if (parts.length) {
                items.push({ kind: "reply", parts });
            }
        }
    }
    return items;
}

/**
 * What a permission wait asks: the tool call the menu waits on is the transcript's last action, still
 * without an outcome. Its whole command or path shows, since the hook's detail is cut short. With no such
 * call the card asks for approval over the row's line.
 */
export function permissionCard(entries, agent) {
    const last = (entries ?? []).findLast((e) => e.kind === "action");
    if (!last || last.outcome) {
        return { tool: "", ask: "Wants your approval", target: agent?.line ?? "" };
    }
    const verb = (last.verb ?? "").toLowerCase();
    if (verb === "ran") {
        return { tool: "Bash", ask: "Wants to run a command", target: last.target };
    }
    if (EDIT_VERBS.has(verb) || last.detail?.kind === "edit") {
        return { tool: "Edit", ask: "Wants to edit a file", target: last.target };
    }
    return { tool: last.verb, ask: "Wants to use a tool", target: last.target };
}

/** The message box for the agent's state, with Stop and the permission card when they apply. */
export function composerFor(agent) {
    const message = `Message ${agent.name}`;
    const base = { label: message, placeholder: message, disabled: false, stop: false, permission: false };
    switch (agent.state) {
        case "working":
            return { ...base, label: "Add to this turn", placeholder: "Add to this turn", stop: true };
        case "permission":
            return {
                ...base,
                label: `Deny and tell ${agent.name} why`,
                placeholder: "Deny and say what to do instead",
                permission: true,
            };
        case "input":
            return { ...base, disabled: true, note: "Needs input · answer it at the desk" };
        case "asking":
            return { ...base, disabled: true, note: "Asking you · answer it under Questions" };
        default:
            return base;
    }
}

function ageOf(agent, now) {
    return agent.since > 0 ? formatAge(now - agent.since) : "";
}

const withAge = (word, age, sep = " ") => (age ? `${word}${sep}${age}` : word);

/** A Handed over row's state chip. */
export function rowStateLabel(agent, now) {
    switch (agent.state) {
        case "permission":
            return "needs approval";
        case "input":
            return "needs input";
        case "asking":
            return "asking you";
        default:
            return withAge(agent.state, ageOf(agent, now));
    }
}

/** The chat header's state line. */
export function headerStateLabel(agent, now) {
    const age = ageOf(agent, now);
    switch (agent.state) {
        case "idle":
            return age ? `idle · replied ${age} ago` : "idle";
        case "permission":
            return withAge("needs approval", age, " · ");
        case "input":
            return withAge("needs input", age, " · ");
        case "asking":
            return withAge("asking you", age, " · ");
        default:
            return withAge(agent.state, age);
    }
}

/** Why a chat ended, for the Back at the desk page. */
export function endedText(name, reason) {
    return (ENDED[reason] ?? ENDED.taken)(name);
}

/** The handed-over tab a "#agent/<tab>" hash opens, else null. */
export function chatTab(hash) {
    const m = /^#agent\/(.+)$/.exec(hash ?? "");
    if (!m) {
        return null;
    }
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return null;
    }
}
