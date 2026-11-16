// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// the Rendered box's `/` panel (slashpanel.tsx): where a `/` being typed sits, which commands it lists, how it groups
// them, and the text once one is picked. The list is the one Claude Code's own typeahead shows, which the arc mod
// publishes per agent block (pkg/claudecmds/live.go) and `fromLive` reads. With none published (a mod that predates
// it, a wavesrv restart before the next publish) the panel lists `BUILTIN_COMMANDS`, copied from the 2.1.319
// binary's command definitions: `/cost` is that version's alias of `/usage`, so it carries `/usage`'s text.

export type SlashSource = "builtin" | "user" | "plugin" | "mcp";

export interface SlashCommand {
    // without the slash; a plugin's is namespaced (`superpowers:brainstorming`)
    name: string;
    description?: string;
    source: SlashSource;
    // the plugin a `plugin` command belongs to, as the live list names it
    plugin?: string;
}

const b = (name: string, description: string): SlashCommand => ({ name, description, source: "builtin" });

export const BUILTIN_COMMANDS: SlashCommand[] = [
    b("add-dir", "Add a new working directory"),
    b("clear", "Start a new session with empty context; previous session stays on disk (resumable with /resume)"),
    b("compact", "Free up context by summarizing the conversation so far"),
    b("config", "Open settings"),
    b("context", "Show current context usage"),
    b("cost", "Show session cost, plan usage, and activity stats"),
    b(
        "doctor",
        "Health-check your setup and fix issues: installation, unused extensions, duplicated or bloated memory files, slow hooks, updates, permissions"
    ),
    b("export", "Export the current conversation to a file or clipboard"),
    b("help", "Show help and available commands"),
    b("hooks", "View hook configurations for tool events"),
    b("init", "Initialize a new CLAUDE.md file with codebase documentation"),
    b("login", "Sign in with your Anthropic account"),
    b("logout", "Sign out from your Anthropic account"),
    b("mcp", "Manage MCP servers"),
    b("memory", "Edit CLAUDE.md files and memory settings"),
    b("model", "Set the AI model for Claude Code"),
    b("permissions", "Manage allow and deny tool permission rules"),
    b("plugin", "Manage Claude Code plugins"),
    b("resume", "Resume a previous conversation"),
    b("rewind", "Restore the code and/or conversation to a previous point"),
    b("status", "Show Claude Code status including version, model, account, API connectivity, and tool statuses"),
    b("usage", "Show session cost, plan usage, and activity stats"),
];

const LIVE_SOURCES: ReadonlySet<string> = new Set<SlashSource>(["builtin", "user", "plugin", "mcp"]);

// the live list's entries, in the typeahead's order; a source the panel does not know reads as a skill (`user`)
export function fromLive(
    list: { name: string; description?: string; source: string; plugin?: string }[]
): SlashCommand[] {
    return list.map((c) => ({
        name: c.name,
        ...(c.description != null ? { description: c.description } : {}),
        source: LIVE_SOURCES.has(c.source) ? (c.source as SlashSource) : "user",
        ...(c.plugin ? { plugin: c.plugin } : {}),
    }));
}

export type SlashGroup = "Built-in" | "Skills" | "Plugins" | "MCP";

const GROUP_OF: Record<SlashSource, SlashGroup> = {
    builtin: "Built-in",
    user: "Skills",
    plugin: "Plugins",
    mcp: "MCP",
};
const GROUP_ORDER: SlashGroup[] = ["Built-in", "Skills", "Plugins", "MCP"];

// `items` split into the panel's groups in GROUP_ORDER, each in the input's order, the empty ones dropped; a name
// seen before keeps its first entry
export function slashGroups(items: SlashCommand[]): { title: SlashGroup; items: SlashCommand[] }[] {
    const seen = new Set<string>();
    const by = new Map<SlashGroup, SlashCommand[]>();
    for (const c of items) {
        if (seen.has(c.name)) {
            continue;
        }
        seen.add(c.name);
        const g = GROUP_OF[c.source];
        by.set(g, [...(by.get(g) ?? []), c]);
    }
    return GROUP_ORDER.filter((g) => by.has(g)).map((g) => ({ title: g, items: by.get(g)! }));
}

// `/` as the box's first character, then the command's name up to the caret; a `/` anywhere else ("and/or", a path)
// is text
const SLASH_QUERY = /^\/([^\s/]*)$/u;

// the command word typed after the box's leading `/`, up to the caret ("" for a bare `/`), or null when the caret is
// not in one
export function slashQueryAt(text: string, caret: number): string | null {
    const found = SLASH_QUERY.exec(text.slice(0, caret));
    return found == null ? null : found[1];
}

// the commands to list for `query`, case-insensitively: name-prefix matches first, then names that hold it, each in
// the list's order
export function slashMatches(query: string, all: SlashCommand[]): SlashCommand[] {
    const q = query.toLowerCase();
    const prefix: SlashCommand[] = [];
    const inside: SlashCommand[] = [];
    for (const c of all) {
        const name = c.name.toLowerCase();
        if (name.startsWith(q)) {
            prefix.push(c);
        } else if (name.includes(q)) {
            inside.push(c);
        }
    }
    return [...prefix, ...inside];
}

// `text` with the leading `/word` (all of the word the caret sits in) replaced by `/<name>` and one space (the one
// already after it, if any), the caret after that space
export function insertSlash(text: string, caret: number, name: string): { text: string; caret: number } {
    const rest = text.slice(caret).replace(/^\S*/u, "");
    const command = `/${name}`;
    return {
        text: command + (rest.startsWith(" ") ? "" : " ") + rest,
        caret: command.length + 1,
    };
}
