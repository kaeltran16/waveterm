// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Settings surface's shape as data: which sections exist, which group they sit under, and the
// title/description/config-key of every row. Rendering stays in settingssurface.tsx — this file is
// what lets the left pane count and search rows it does not render, and it is the single source of
// each row's prose so the index and the detail pane cannot disagree.

import { parseJiraError } from "@/app/view/jarvis/jiraticket";
import { formatAgo } from "./agentsviewmodel";
import { RUNTIME_FLAGS, type Runtime } from "./launch";

// Where a row's value lives. "synced" travels with settings.json; "local" stays on this machine
// (localStorage prefs, and the OS secret store). Read-only build info leaves it off — a provenance
// dot on "App version" would claim something untrue.
export type RowScope = "synced" | "local";

export type SettingRowDef = {
    id: string;
    title: string;
    desc: string;
    // The real config/storage key, shown under the row so a setting can be found in settings.json.
    // Left off by a row that stores no setting (the vault sync remote lives in the vault's git config).
    key?: string;
    scope?: RowScope;
    // Set when `key` is a wconfig settings key. Those rows get their changed mark by diffing the merged
    // value against the shipped default, and revert by deleting the user's override; every other row's
    // value lives somewhere only the surface knows how to reach.
    config?: boolean;
    // A New Agent launch flag's runtime. The section holds every runtime's flags, so the changed count and
    // Reset section see a flag set on any of them; the body shows one runtime's at a time.
    runtime?: Runtime;
};

export type SettingSectionDef = {
    id: string;
    name: string;
    blurb: string;
    group: string;
    rows: SettingRowDef[];
};

export type SettingGroup = {
    label: string;
    sections: SettingSectionDef[];
};

export const GROUP_ORDER = ["Cockpit", "Agents", "Data", "Build"] as const;

// The secret pkg/consult/openrouter.go reads. Named for the embedding lane that first stored it; the name
// stays because renaming it would orphan every key already stored. Never read back into the UI.
// Underscore, not colon: SetSecret validates against the shell env-var charset and rejects colons.
export const OPENROUTER_SECRET_NAME = "jarvis_embedapikey";

// The secret pkg/jira reads the API token from. Written with SetSecretsCommand, never read back.
export const JIRA_SECRET_NAME = "JIRA_API_TOKEN";

// The skim mod (claude/arc-skim-mod) and the userConfig fields its plugin.json declares; pkg/claudemod writes only these
export const SKIM_PLUGIN = "arc-skim";
export const SKIM_FIELDS = [
    {
        field: "highlight",
        title: "Highlight must-read sentences",
        desc: "Claude marks the sentences of a long reply worth reading, and they draw bold. Off, Claude is not asked, so it costs no tokens.",
    },
    {
        field: "dim",
        title: "Dim the rest",
        desc: "Grey a long explanation around its marked sentences. /skim in a claude session flips it too.",
    },
] as const;

// An option is on unless stored false, as the mod reads it (settingsOf in claude/arc-skim-mod/hooks/highlight-core.ts)
export function isModOptionOn(options: Record<string, unknown> | null, field: string): boolean {
    return options?.[field] !== false;
}

const THEME_OVERRIDE_KEY = "cockpit.theme.overrides";
const LAUNCH_FLAGS_KEY = "agent.launch.flags";

// Runtimes the flag editor lists. Terminal stays out (it isn't an agent); pi is included even though
// its catalog is empty so its no-flags state renders in the editor instead of the row vanishing.
export const FLAG_RUNTIMES: { id: Runtime; name: string }[] = [
    { id: "claude", name: "Claude" },
    { id: "codex", name: "Codex" },
    { id: "opencode", name: "OpenCode" },
    { id: "pi", name: "Pi" },
];

export function settingsSections(): SettingSectionDef[] {
    return [
        {
            id: "appearance",
            name: "Appearance",
            blurb: "Base palette and the four role colors every surface derives from.",
            group: "Cockpit",
            rows: [
                {
                    id: "appearance.theme",
                    title: "Theme",
                    desc: "Base palette for every surface. Tints and gradients recompute from it.",
                    key: "cockpit.theme.preset",
                    scope: "local",
                },
                {
                    id: "appearance.accent",
                    title: "Accent",
                    desc: "Primary actions, active nav, links.",
                    key: THEME_OVERRIDE_KEY,
                    scope: "local",
                },
                {
                    id: "appearance.success",
                    title: "Working / accept",
                    desc: "Live agents, accepted diffs.",
                    key: THEME_OVERRIDE_KEY,
                    scope: "local",
                },
                {
                    id: "appearance.warning",
                    title: "Asking / attention",
                    desc: "Awaiting your reply.",
                    key: THEME_OVERRIDE_KEY,
                    scope: "local",
                },
                {
                    id: "appearance.error",
                    title: "Blocked / reject",
                    desc: "Errors, discarded changes.",
                    key: THEME_OVERRIDE_KEY,
                    scope: "local",
                },
            ],
        },
        {
            id: "fonts",
            name: "Fonts",
            blurb: "Three faces: the app, code surfaces, and the terminal.",
            group: "Cockpit",
            rows: [
                {
                    id: "fonts.sans",
                    title: "Interface font",
                    desc: "App-wide UI text — nav, panels, labels.",
                    key: "cockpit.font.sans",
                    scope: "local",
                },
                {
                    id: "fonts.mono",
                    title: "Code font",
                    desc: "Inline code, diffs, and file trees.",
                    key: "cockpit.font.mono",
                    scope: "local",
                },
                {
                    id: "fonts.term",
                    title: "Terminal font",
                    desc: "Monospace face inside agent terminals.",
                    key: "term:fontfamily",
                    scope: "synced",
                    config: true,
                },
            ],
        },
        {
            id: "general",
            name: "General",
            blurb: "What opens at launch and what the Agent surface shows by default.",
            group: "Cockpit",
            rows: [
                {
                    id: "general.startup",
                    title: "Startup surface",
                    desc: "Which surface opens when the app launches.",
                    key: "cockpit.startup.surface",
                    scope: "local",
                },
                {
                    id: "general.rail",
                    title: "Show details rail by default",
                    desc: "The per-agent git/details rail on the Agent surface.",
                    key: "agent.rail.visible",
                    scope: "local",
                },
            ],
        },
        {
            id: "remote",
            name: "Remote",
            blurb: "Answer agent questions from your phone through your Cloudflare tunnel, while you turn it on. Set it up with the tunnel and Access details below, or with wsh remote setup.",
            group: "Cockpit",
            rows: [
                {
                    id: "remote.mode",
                    title: "Remote mode",
                    desc: "While on, what waits on you reaches your phone, and you can answer agent questions from it. The phone can turn it off too.",
                    key: "secretstore · arc_remote",
                    scope: "local",
                },
                {
                    id: "remote.status",
                    title: "Status",
                    desc: "Setup, the tunnel, the public address, and whether a phone has subscribed.",
                },
                {
                    id: "remote.tunneltoken",
                    title: "Tunnel token",
                    desc: "The named tunnel's connector token, from Zero Trust > Networks > Tunnels. Write-only: Arc never shows it again. Paste a refreshed one to replace it.",
                },
                {
                    id: "remote.hostname",
                    title: "Hostname",
                    desc: "The tunnel's public hostname, e.g. arc.example.com. Its service must be http://localhost on the port below.",
                },
                {
                    id: "remote.port",
                    title: "Local port",
                    desc: "Where the phone listener binds on this machine.",
                },
                {
                    id: "remote.team",
                    title: "Access team",
                    desc: "Your Zero Trust team name: acme for acme.cloudflareaccess.com.",
                },
                {
                    id: "remote.aud",
                    title: "Access audience tag",
                    desc: "The AUD tag of the Access application that guards the hostname.",
                },
                {
                    id: "remote.email",
                    title: "Owner email",
                    desc: "The only Access identity Arc lets in, whatever the Access policy allows.",
                },
            ],
        },
        {
            id: "newagent",
            name: "New Agent",
            blurb: "Launch flags reused for every new agent, per runtime.",
            group: "Agents",
            rows: [
                {
                    id: "newagent.remember",
                    title: "Remember flags",
                    desc: "Reuse the enabled flags for every new agent instead of clearing after launch.",
                    key: "agent.launch.remember",
                    scope: "local",
                },
                {
                    id: "newagent.runtime",
                    title: "Runtime",
                    desc: "Which runtime's flag set you're editing.",
                    key: LAUNCH_FLAGS_KEY,
                    scope: "local",
                },
                ...FLAG_RUNTIMES.flatMap(({ id: runtime }) =>
                    RUNTIME_FLAGS[runtime].map((f) => ({
                        id: flagRowId(runtime, f.id),
                        title: f.flag,
                        desc: f.desc,
                        key: LAUNCH_FLAGS_KEY,
                        scope: "local" as const,
                        runtime,
                    }))
                ),
            ],
        },
        {
            id: "claudeaccount",
            name: "Claude account",
            blurb: "Which Claude.ai login new claude sessions use. Arc saves every login it sees, so moving to another account is one click.",
            group: "Agents",
            rows: [
                {
                    id: "claudeaccount.accounts",
                    title: "Accounts",
                    desc: "Every claude session launches with the active account. Switching saves the active login first, so its tokens are current when you come back to it.",
                    key: "~/.claude/.credentials.json · ~/.claude.json · secrets.enc",
                    scope: "local",
                },
                {
                    id: "claudeaccount.add",
                    title: "Add an account",
                    desc: "Run /login in any claude session and sign in with the other account. Arc saves it the next time it checks.",
                },
            ],
        },
        {
            id: "skim",
            name: "Skim",
            blurb: "The Claude Code mod that draws the few sentences of a long reply worth reading in bold. Claude Code's /config shows the same two settings.",
            group: "Agents",
            rows: SKIM_FIELDS.map((f) => ({
                id: `skim.${f.field}`,
                title: f.title,
                desc: f.desc,
                key: `~/.claude/settings.json · pluginConfigs.${SKIM_PLUGIN}.${f.field}`,
                scope: "local" as const,
            })),
        },
        {
            id: "run",
            name: "Run defaults",
            blurb: "Backend-authoritative harness and model for new runs.",
            group: "Agents",
            rows: [
                {
                    id: "run.route",
                    title: "Run route",
                    desc: "Harness and resolved model for new runs.",
                    key: "harness.preference",
                    scope: "synced",
                },
            ],
        },
        {
            id: "terminal",
            name: "Terminal",
            blurb: "Defaults for every agent terminal.",
            group: "Agents",
            rows: [
                {
                    id: "terminal.fontsize",
                    title: "Font size",
                    desc: "Default font size for agent terminals (px).",
                    key: "term:fontsize",
                    scope: "synced",
                    config: true,
                },
                {
                    id: "terminal.cursor",
                    title: "Cursor style",
                    desc: "Shape of the terminal caret.",
                    key: "term:cursor",
                    scope: "synced",
                    config: true,
                },
                {
                    id: "terminal.cursorblink",
                    title: "Cursor blink",
                    desc: "Pulse the caret when the terminal is focused.",
                    key: "term:cursorblink",
                    scope: "synced",
                    config: true,
                },
                {
                    id: "terminal.scrollback",
                    title: "Scrollback",
                    desc: "Lines of history kept per terminal.",
                    key: "term:scrollback",
                    scope: "synced",
                    config: true,
                },
                {
                    id: "terminal.copyonselect",
                    title: "Copy on select",
                    desc: "Copy highlighted text to the clipboard automatically.",
                    key: "term:copyonselect",
                    scope: "synced",
                    config: true,
                },
            ],
        },
        {
            id: "memory",
            name: "Vault",
            blurb: "Where Jarvis reads records, decisions and attachments from.",
            group: "Data",
            rows: [
                {
                    id: "memory.vaultpath",
                    title: "Vault path",
                    desc: "Validated on change — the folder must exist. Empty falls back to the default vault.",
                    key: "memory:vaultpath",
                    scope: "local",
                    config: true,
                },
                {
                    id: "memory.remote",
                    title: "Sync remote",
                    desc: "A private git remote that keeps the vault, initiatives and portable settings the same on every machine. Empty turns sync off.",
                },
            ],
        },
        {
            id: "headless",
            name: "Headless AI",
            blurb: "The runtime behind session classify, continuity, the volunteer judge and pi titles.",
            group: "Data",
            rows: [
                {
                    id: "headless.runtime",
                    title: "Runtime",
                    desc: "Which engine powers background AI features. Empty means OpenRouter, the backend default.",
                    key: "headless:runtime",
                    scope: "synced",
                    config: true,
                },
                {
                    id: "headless.apikey",
                    title: "OpenRouter API key",
                    desc: "OS secret store — never in settings, never shown again.",
                    key: "keychain",
                    scope: "local",
                },
                {
                    id: "headless.cheap",
                    title: "Cheap model",
                    desc: "The OpenRouter model for session classify, continuity, the volunteer judge and pi titles. Used only when the runtime is OpenRouter.",
                    key: "headless:openroutercheapmodel",
                    scope: "synced",
                    config: true,
                },
            ],
        },
        {
            id: "jira",
            name: "Jira",
            blurb: "Your Jira Cloud site, for Check Jira, Make initiative and Post to Jira. Arc talks to Jira only when you use one of them.",
            group: "Data",
            rows: [
                {
                    id: "jira.site",
                    title: "Site",
                    desc: "Your Jira Cloud address.",
                    key: "jira:site",
                    scope: "synced",
                    config: true,
                },
                {
                    id: "jira.email",
                    title: "Account email",
                    desc: "The Atlassian account the API token belongs to.",
                    key: "jira:email",
                    scope: "synced",
                    config: true,
                },
                {
                    id: "jira.token",
                    title: "API token",
                    desc: "Kept in Arc's encrypted secret store, never in settings.json. Agents reach Jira through wsh and never see it.",
                    key: `secretstore · ${JIRA_SECRET_NAME}`,
                    scope: "local",
                },
                {
                    id: "jira.connection",
                    title: "Connection",
                    desc: "Arc signs in to your site with the email and token above.",
                },
            ],
        },
        {
            id: "storage",
            name: "Storage",
            blurb: "What Arc and its agents keep on this machine, which run left it, and whether anything still needs it.",
            group: "Data",
            rows: [],
        },
        {
            id: "about",
            name: "About",
            blurb: "Versions of the shell and the backend it spawned.",
            group: "Build",
            rows: [
                { id: "about.app", title: "App version", desc: "This shell.", key: "tauri.conf.json" },
                {
                    id: "about.server",
                    title: "Backend version",
                    desc: "The wavesrv this app spawned.",
                    key: "dist/bin",
                },
                {
                    id: "about.buildtime",
                    title: "Backend build time",
                    desc: "When the wavesrv binary was stamped.",
                    key: "dist/bin",
                },
                { id: "about.platform", title: "Platform", desc: "Host the shell reported at boot.", key: "runtime" },
            ],
        },
    ];
}

// Row id for one runtime's launch flag. Runtime-qualified: the same flag id ("skip-permissions") is a
// different row on claude than on codex, and the changed-count has to tell them apart.
export function flagRowId(runtime: Runtime, flagId: string): string {
    return `newagent.flag.${runtime}.${flagId}`;
}

// Every settings key a row stores under, primary first. Empty for a row that stores no setting.
export function rowKeys(row: SettingRowDef): string[] {
    return row.key == null ? [] : [row.key];
}

export function rowMatches(row: SettingRowDef, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return true;
    }
    return `${row.title} ${row.desc} ${rowKeys(row).join(" ")}`.toLowerCase().includes(q);
}

// The one-line sync state under the Sync remote field. null is "not loaded yet".
export function vaultStatusLine(s: VaultStatusRtnData | null): string {
    if (s == null) {
        return "";
    }
    if (s.off === "no-git") {
        return "Sync off — git not found";
    }
    if (s.off === "no-remote") {
        return "Sync off — no remote";
    }
    let line: string;
    if (s.running) {
        line = "Syncing…";
    } else if (s.lasterror) {
        line = `Sync failed: ${s.lasterror}`;
    } else if (s.lastsuccessts) {
        line = `Last synced ${formatAgo(Date.now() - s.lastsuccessts)}`;
    } else {
        line = "Not synced yet";
    }
    const conflicts = s.conflicts?.length ?? 0;
    if (conflicts > 0) {
        line += `, ${conflicts} conflict ${conflicts === 1 ? "copy" : "copies"}`;
    }
    const malformed = s.malformedefforts?.length ?? 0;
    if (malformed > 0) {
        line += `, ${malformed} malformed ${malformed === 1 ? "effort" : "efforts"}`;
    }
    return line;
}

// the Sync now button. `clicking` is the local in-flight flag, set before the RPC so the row reads
// syncing at once; `status.running` also covers a sync started at launch or on window focus.
export function vaultSyncButton(s: VaultStatusRtnData | null, clicking: boolean): { enabled: boolean; label: string } {
    if (clicking || s?.running) {
        return { enabled: false, label: "Syncing…" };
    }
    return { enabled: s != null && !s.off, label: "Sync now" };
}

// what a rejected Sync now puts in the row's error note. a sync's own failure is already in the reloaded
// status as `lasterror` (shown by the status line), so only an RPC failure gets a note: the status has no
// error, could not be loaded, or still runs (the RPC timeout fired mid-sync).
export function vaultSyncFailureNote(err: string, reloaded: VaultStatusRtnData | null): string | null {
    if (reloaded == null || reloaded.running || !reloaded.lasterror) {
        return err;
    }
    return null;
}

const JIRA_SITE_RE = /^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/i;

// null when the site may be saved: empty disconnects, otherwise only a Jira Cloud address is accepted
export function jiraSiteError(site: string): string | null {
    const s = site.trim();
    if (s === "" || JIRA_SITE_RE.test(s)) {
        return null;
    }
    return "Use your Jira Cloud address: https://<name>.atlassian.net";
}

export type JiraConnectionLine = {
    tone: "idle" | "ok" | "error";
    text: string;
    // set once Arc has tried the site at least once
    checked?: string;
};

// the names pkg/jira's not-configured message uses for each missing piece
const JIRA_MISSING_NAME: Record<string, string> = { site: "site", email: "account email", token: "API token" };

function joinAnd(items: string[]): string {
    return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// the Connection row's state line. Reads the status wavesrv keeps in memory; it never calls Jira.
export function jiraConnectionLine(conn: JiraConnection, now: number): JiraConnectionLine {
    if (!conn.configured) {
        return {
            tone: "idle",
            text: `Add your ${joinAnd((conn.missing ?? []).map((m) => JIRA_MISSING_NAME[m] ?? m))} to connect.`,
        };
    }
    if (conn.checkedts == null && !conn.error) {
        return { tone: "idle", text: "Not checked yet" };
    }
    const checked = conn.checkedts != null ? `Checked ${formatAgo(now - conn.checkedts)}` : undefined;
    if (conn.ok) {
        return { tone: "ok", text: `Connected as ${conn.displayname ?? "you"}`, checked };
    }
    return { tone: "error", text: parseJiraError(conn.error ?? "").message, checked };
}

// A query naming the section itself (its name or blurb) finds all of it, Storage included, which has no rows.
export function sectionMatches(section: SettingSectionDef, query: string): boolean {
    const q = query.trim().toLowerCase();
    return q !== "" && `${section.name} ${section.blurb}`.toLowerCase().includes(q);
}

// A section the query names is kept whole; any other has its non-matching rows dropped, and is dropped once
// none is left. An empty query returns the sections unchanged (identity, not a copy of every row) so callers
// can skip the filtered path.
export function filterSections(sections: SettingSectionDef[], query: string): SettingSectionDef[] {
    if (query.trim() === "") {
        return sections;
    }
    return sections
        .map((s) => (sectionMatches(s, query) ? s : { ...s, rows: s.rows.filter((r) => rowMatches(r, query)) }))
        .filter((s) => s.rows.length > 0 || sectionMatches(s, query));
}

// The rows a search leaves showing in one section, or null for all of them: no search, or one naming the section.
export function visibleRowIds(section: SettingSectionDef | null, query: string): Set<string> | null {
    if (section == null || query.trim() === "" || sectionMatches(section, query)) {
        return null;
    }
    return new Set(section.rows.filter((r) => rowMatches(r, query)).map((r) => r.id));
}

// The runtime whose flags the New Agent body shows: the one picked, unless a search leaves none of its flags
// standing while another runtime's match, which then shows instead of an empty list.
export function shownFlagRuntime(picked: Runtime, visible: ReadonlySet<string> | null): Runtime {
    const anyVisible = (r: Runtime) => RUNTIME_FLAGS[r].some((f) => visible!.has(flagRowId(r, f.id)));
    if (visible == null || anyVisible(picked)) {
        return picked;
    }
    return FLAG_RUNTIMES.find((r) => anyVisible(r.id))?.id ?? picked;
}

export function groupSections(sections: SettingSectionDef[]): SettingGroup[] {
    return GROUP_ORDER.map((label) => ({ label, sections: sections.filter((s) => s.group === label) })).filter(
        (g) => g.sections.length > 0
    );
}

// Which section the detail pane shows. A search that filters the selected section away moves the
// selection to the first surviving one rather than leaving the pane blank.
export function resolveSelection(sections: SettingSectionDef[], wanted: string): string | null {
    if (sections.length === 0) {
        return null;
    }
    return sections.some((s) => s.id === wanted) ? wanted : sections[0].id;
}

export function changedCount(section: SettingSectionDef, changed: ReadonlySet<string>): number {
    return section.rows.filter((r) => changed.has(r.id)).length;
}

export function countLabel(n: number): string {
    return `${n} ${n === 1 ? "setting" : "settings"}`;
}
