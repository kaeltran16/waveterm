// what the cockpit asks of this session, as `wsh agentctl` streams it: one JSON line each. kept free
// of the engine so vitest can run it; register.ts holds the stream and the engine calls.

// what the session can be asked to do. closures over the engine: the validator follows `$` only into a
// function of the hooks file itself
export type Session = {
    submit: (text: string) => Promise<unknown>;
    command: (name: string, args: string) => Promise<unknown>;
    compact: (instructions: string) => Promise<unknown>;
};

// the whole lines a chunk completed, and what is left of the last one
export function takeLines(buffered: string): { lines: string[]; rest: string } {
    const parts = buffered.split("\n");
    const rest = parts.pop() ?? "";
    return { lines: parts.map((l) => l.trim()).filter(Boolean), rest };
}

// one thing the cockpit asked for: a prompt, which midTurn asks to join the running turn instead of
// waiting for it to end, or a compaction with these instructions
export type ControlMsg = { text: string; midTurn?: boolean } | { compact: string };

const filled = (v: unknown): v is string => typeof v === "string" && v !== "";

// one stream line's message; null for a line that asks for nothing
export function controlMsg(line: string): ControlMsg | null {
    try {
        const msg = JSON.parse(line);
        if (filled(msg?.compact)) {
            return { compact: msg.compact };
        }
        if (!filled(msg?.text)) {
            return null;
        }
        return { text: msg.text, ...(msg.midturn === true && { midTurn: true }) };
    } catch {
        return null;
    }
}

// a command name is letters, digits, _, - and a plugin's ":"; a leading word with / or . in it is a path the
// prompt starts with, which $.command.run would reject and the prompt be lost
const SLASH = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/;

const COMPACT = "compact";

// whether typing the text would run a command rather than send a prompt
export function isCommand(text: string): boolean {
    return SLASH.test(text);
}

// runs a prompt as typing it would: a leading slash is a command (a prompt when the session refuses it),
// anything else a prompt. a compaction is the session's own call, which echoes no command into the
// transcript; a session that refuses it (a headless one) runs the command
export function deliver(session: Session, msg: { text: string } | { compact: string }): Promise<unknown> {
    if ("compact" in msg) {
        return session.compact(msg.compact).catch(() => session.command(COMPACT, msg.compact));
    }
    const { text } = msg;
    const [, name, args = ""] = SLASH.exec(text) ?? [];
    if (name) {
        // the engine's rejection does not tell an unknown name from a command that refused its args, so
        // any refusal is sent as the prompt it may have been rather than lost
        return session.command(name, args).catch(() => session.submit(text));
    }
    return session.submit(text);
}

// whether the engine refused a submit: it answers `{ drop: reason }` rather than failing, as after the person's Stop
// until they next send input
export function isDropped(result: unknown): boolean {
    return typeof result === "object" && result !== null && filled((result as { drop?: unknown }).drop);
}

// the one transcript line for a text that joined the running turn, whose own row draws nothing. the
// engine leads it with the plugin's name
export function steerNotice(text: string): string {
    return `read mid-turn: ${text.replace(/\s+/g, " ").trim()}`;
}
