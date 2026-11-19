// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// pi's built-in slash commands, which `pi.getCommands()` leaves out, so the arc pi extension's published list never
// carries them: the `BUILTIN_SLASH_COMMANDS` of pi 1.5.2 (dist/core/slash-commands.js) with pi's own descriptions, in
// pi's order. One list feeds the `/` panel's built-ins and the picker check: `picker` marks the commands whose handler
// (dist/modes/interactive/interactive-mode.js) opens a full-screen picker always, or only when typed bare (with an
// argument they switch without one).

import type { SlashCommand } from "./slashpanelmodel";

export const PI_HARNESS = "pi";

type PiBuiltin = SlashCommand & { picker?: "always" | "bare" };

const b = (name: string, description: string, picker?: PiBuiltin["picker"]): PiBuiltin => ({
    name,
    description,
    source: "builtin",
    ...(picker != null ? { picker } : {}),
});

const PI_BUILTINS: PiBuiltin[] = [
    b("settings", "Open settings menu", "always"),
    b("model", "Select model (opens selector UI)", "bare"),
    b("tree", "Navigate session tree (switch branches)", "always"),
    b("thinking", "Set thinking level", "bare"),
    b("scoped-models", "Enable/disable models for Ctrl+P cycling", "always"),
    b("export", "Export session (HTML default, or specify path: .html/.jsonl)"),
    b("import", "Import a JSONL session, preserving its ID and working directory", "always"),
    b("share", "Share session via a Radius artifact or a GitHub gist"),
    b("bug", "Report a bug to the Pi developers", "always"),
    b("copy", "Copy last agent message to clipboard"),
    b("name", "Set session display name"),
    b("session", "Show session info and stats"),
    b("changelog", "Show changelog entries"),
    b("hotkeys", "Show all keyboard shortcuts"),
    b("fork", "Create a new fork from a previous user message", "always"),
    b("clone", "Duplicate the current session at the current position"),
    b("trust", "Save project trust decision for future sessions", "always"),
    b("login", "Configure provider authentication", "bare"),
    b("logout", "Remove provider authentication", "always"),
    b("new", "Start a new session"),
    b("compact", "Manually compact the session context"),
    b("resume", "Resume another session", "always"),
    b("reload", "Reload keybindings, extensions, skills, prompts, themes, and context files"),
    b("quit", "Quit pi"),
];

export const PI_BUILTIN_COMMANDS: SlashCommand[] = PI_BUILTINS;

// whether `/name`, with or without arguments after it, opens a picker in pi's TUI
export function isPiPickerCommand(name: string, hasArgs: boolean): boolean {
    const picker = PI_BUILTINS.find((c) => c.name === name)?.picker;
    return picker === "always" || (picker === "bare" && !hasArgs);
}
