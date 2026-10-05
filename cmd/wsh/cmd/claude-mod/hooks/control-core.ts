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

// one thing the cockpit asked for: a prompt, or a compaction with these instructions
export type ControlMsg = { text: string } | { compact: string };

const filled = (v: unknown): v is string => typeof v === "string" && v !== "";

// one stream line's message; null for a line that asks for nothing
export function controlMsg(line: string): ControlMsg | null {
    try {
        const msg = JSON.parse(line);
        if (filled(msg?.compact)) {
            return { compact: msg.compact };
        }
        return filled(msg?.text) ? { text: msg.text } : null;
    } catch {
        return null;
    }
}

const SLASH = /^\/(\S+)\s*([\s\S]*)$/;

const COMPACT = "compact";

// runs a prompt as typing it would: a leading slash is a command, anything else a prompt. a compaction is
// the session's own call, which echoes no command into the transcript; a session that refuses it (a
// headless one) runs the command
export function deliver(session: Session, msg: ControlMsg): Promise<unknown> {
    if ("compact" in msg) {
        return session.compact(msg.compact).catch(() => session.command(COMPACT, msg.compact));
    }
    const [, name, args = ""] = SLASH.exec(msg.text) ?? [];
    return name ? session.command(name, args) : session.submit(msg.text);
}
