// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { RUNTIME_FLAGS } from "./launch";
import {
    changedCount,
    countLabel,
    filterSections,
    flagRowId,
    groupSections,
    isModOptionOn,
    JIRA_SECRET_NAME,
    jiraConnectionLine,
    jiraSiteError,
    OPENROUTER_SECRET_NAME,
    resolveSelection,
    rowKeys,
    rowMatches,
    settingsSections,
    SKIM_FIELDS,
    SKIM_PLUGIN,
    vaultStatusLine,
    vaultSyncButton,
    vaultSyncFailureNote,
    type SettingSectionDef,
} from "./settingsmodel";

const sections = () => settingsSections("claude");

describe("vault sync rows", () => {
    it("treats the vault path as machine-local", () => {
        const row = sections()
            .find((s) => s.id === "memory")!
            .rows.find((r) => r.id === "memory.vaultpath")!;
        expect(row.scope).toBe("local");
    });

    it("offers a sync remote row that stores no setting", () => {
        const row = sections()
            .find((s) => s.id === "memory")!
            .rows.find((r) => r.id === "memory.remote")!;
        expect(row.key).toBeUndefined();
        expect(row.config).toBeUndefined();
    });
});

describe("claude account section", () => {
    it("sits in Agents directly after New Agent", () => {
        const agents = groupSections(sections()).find((g) => g.label === "Agents")!;
        const ids = agents.sections.map((s) => s.id);
        expect(ids.indexOf("claudeaccount")).toBe(ids.indexOf("newagent") + 1);
    });

    it("has an Accounts row and an Add an account row, neither a config row", () => {
        const section = sections().find((s) => s.id === "claudeaccount")!;
        expect(section.name).toBe("Claude account");
        expect(section.rows.map((r) => [r.id, r.title])).toEqual([
            ["claudeaccount.accounts", "Accounts"],
            ["claudeaccount.add", "Add an account"],
        ]);
        expect(section.rows.every((r) => r.config === undefined)).toBe(true);
        expect(section.rows[0].scope).toBe("local");
    });
});

describe("vaultStatusLine", () => {
    it("says nothing until the status loads", () => {
        expect(vaultStatusLine(null)).toBe("");
    });

    it("explains why sync is off", () => {
        expect(vaultStatusLine({ off: "no-remote" })).toBe("Sync off — no remote");
        expect(vaultStatusLine({ off: "no-git" })).toBe("Sync off — git not found");
    });

    it("reports a running sync, a failure and a success", () => {
        expect(vaultStatusLine({ running: true })).toBe("Syncing…");
        expect(vaultStatusLine({ lasterror: "push rejected" })).toBe("Sync failed: push rejected");
        expect(vaultStatusLine({ lastsuccessts: Date.now() - 5 * 60_000 })).toBe("Last synced 5m ago");
        expect(vaultStatusLine({})).toBe("Not synced yet");
    });

    it("appends conflict and malformed counts only when non-zero", () => {
        const ok = { lastsuccessts: Date.now() };
        expect(vaultStatusLine({ ...ok, conflicts: [], malformedefforts: [] })).toBe("Last synced just now");
        expect(vaultStatusLine({ ...ok, conflicts: ["a", "b"], malformedefforts: ["x"] })).toBe(
            "Last synced just now, 2 conflict copies, 1 malformed effort"
        );
    });
});

describe("vaultSyncButton", () => {
    it("is disabled and reads Syncing… while a sync runs, from a click or from launch/focus", () => {
        const syncing = { enabled: false, label: "Syncing…" };
        expect(vaultSyncButton({ running: true }, false)).toEqual(syncing);
        expect(vaultSyncButton({}, true)).toEqual(syncing);
    });

    it("is disabled but keeps its label when sync is off", () => {
        const off = { enabled: false, label: "Sync now" };
        expect(vaultSyncButton({ off: "no-git" }, false)).toEqual(off);
        expect(vaultSyncButton({ off: "no-remote" }, false)).toEqual(off);
    });

    it("stays enabled after a failed sync so the user can retry", () => {
        expect(vaultSyncButton({ lasterror: "push rejected" }, false)).toEqual({ enabled: true, label: "Sync now" });
    });

    it("is enabled when idle", () => {
        expect(vaultSyncButton({ lastsuccessts: Date.now() }, false)).toEqual({ enabled: true, label: "Sync now" });
    });

    it("is disabled until the status loads", () => {
        expect(vaultSyncButton(null, false)).toEqual({ enabled: false, label: "Sync now" });
    });
});

describe("vaultSyncFailureNote", () => {
    it("leaves a sync's own failure to the status line", () => {
        expect(vaultSyncFailureNote("push rejected", { lasterror: "push rejected" })).toBeNull();
    });

    it("notes a timeout that fired while the sync still runs", () => {
        expect(vaultSyncFailureNote("timeout", { running: true, lasterror: "old error" })).toBe("timeout");
    });

    it("notes a rejection the status does not explain", () => {
        expect(vaultSyncFailureNote("rpc closed", { lastsuccessts: Date.now() })).toBe("rpc closed");
    });

    it("notes a rejection when the status could not be reloaded", () => {
        expect(vaultSyncFailureNote("rpc closed", null)).toBe("rpc closed");
    });
});

describe("settingsSections", () => {
    it("gives every row a unique id", () => {
        const ids = sections().flatMap((s) => s.rows.map((r) => r.id));
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("lists the flags of the runtime being edited, and only those", () => {
        const rows = sections().find((s) => s.id === "newagent")!.rows;
        expect(rows.map((r) => r.id)).toEqual([
            "newagent.remember",
            "newagent.runtime",
            ...RUNTIME_FLAGS.claude.map((f) => flagRowId("claude", f.id)),
        ]);
        const codex = settingsSections("codex").find((s) => s.id === "newagent")!.rows;
        expect(codex.some((r) => r.title === "--verbose")).toBe(false);
    });

    it("renders a runtime with an empty flag catalog as a section with no flag rows", () => {
        const rows = settingsSections("pi").find((s) => s.id === "newagent")!.rows;
        expect(rows.map((r) => r.id)).toEqual(["newagent.remember", "newagent.runtime"]);
    });

    it("offers the OpenRouter key where the OpenRouter models are set", () => {
        const headless = sections().find((s) => s.id === "headless")!;
        const key = headless.rows.find((r) => r.id === "headless.apikey")!;
        expect(key.key).toBe("keychain");
        expect(key.scope).toBe("local");
        expect(key.config).toBeUndefined();
    });

    it("reads the OpenRouter key from the secret it has always been stored under", () => {
        // renaming it would orphan every stored key; pkg/consult/openrouter.go reads the same name
        expect(OPENROUTER_SECRET_NAME).toBe("jarvis_embedapikey");
    });

    it("has no embeddings section", () => {
        expect(sections().some((s) => s.id === "embeddings")).toBe(false);
        const keys = sections().flatMap((s) => s.rows.map((r) => r.key ?? ""));
        expect(keys.some((k) => k.startsWith("jarvis:embed"))).toBe(false);
    });

    it("leaves read-only build info without a provenance scope", () => {
        const about = sections().find((s) => s.id === "about")!;
        expect(about.rows.every((r) => r.scope === undefined)).toBe(true);
    });

    it("marks exactly the wconfig-backed rows as config rows", () => {
        const rows = sections().flatMap((s) => s.rows);
        const config = rows.filter((r) => r.config).flatMap(rowKeys);
        expect(config).toEqual([
            "term:fontfamily",
            "term:fontsize",
            "term:cursor",
            "term:cursorblink",
            "term:scrollback",
            "term:copyonselect",
            "memory:vaultpath",
            "headless:runtime",
            "headless:openroutercheapmodel",
            "jira:site",
            "jira:email",
        ]);
    });

    it("lists Headless AI without an audit route or a mid model", () => {
        const headless = sections().find((s) => s.id === "headless")!;
        expect(headless.rows.map((r) => r.id)).toEqual(["headless.runtime", "headless.apikey", "headless.cheap"]);
        const prose = [headless.blurb, ...headless.rows.flatMap((r) => [r.title, r.desc])].join(" ").toLowerCase();
        for (const gone of ["mid model", "gatekeeper", "decompose"]) {
            expect(prose).not.toContain(gone);
        }
    });
});

describe("settingsSections run route and groups", () => {
    it("leaves the backend-authoritative run route off the config path", () => {
        const route = sections()
            .find((s) => s.id === "run")!
            .rows.find((r) => r.id === "run.route")!;
        expect(route.scope).toBe("synced");
        expect(route.config).toBeUndefined();
    });

    it("puts every section in a known group", () => {
        const grouped = groupSections(sections()).flatMap((g) => g.sections);
        expect(grouped).toHaveLength(sections().length);
    });
});

describe("rowMatches", () => {
    const row = { id: "terminal.fontsize", title: "Font size", desc: "Default font size (px).", key: "term:fontsize" };

    it("matches an empty query", () => {
        expect(rowMatches(row, "   ")).toBe(true);
    });

    it("matches on title, description and config key, case-insensitively", () => {
        expect(rowMatches(row, "FONT")).toBe(true);
        expect(rowMatches(row, "px")).toBe(true);
        expect(rowMatches(row, "term:fontsize")).toBe(true);
    });

    it("does not match unrelated text", () => {
        expect(rowMatches(row, "scrollback")).toBe(false);
    });
});

describe("filterSections", () => {
    it("returns the sections untouched for an empty query", () => {
        const all = sections();
        expect(filterSections(all, "")).toBe(all);
    });

    it("drops non-matching rows and then empty sections", () => {
        const found = filterSections(sections(), "scrollback");
        expect(found.map((s) => s.id)).toEqual(["terminal"]);
        expect(found[0].rows.map((r) => r.id)).toEqual(["terminal.scrollback"]);
    });

    it("reaches rows in sections the query does not name", () => {
        const found = filterSections(sections(), "caret");
        expect(found.map((s) => s.id)).toEqual(["terminal"]);
        expect(found[0].rows.map((r) => r.id)).toEqual(["terminal.cursor", "terminal.cursorblink"]);
    });

    it("returns nothing when no row matches", () => {
        expect(filterSections(sections(), "zzzz")).toEqual([]);
    });
});

describe("resolveSelection", () => {
    it("keeps the wanted section when it survived the filter", () => {
        expect(resolveSelection(sections(), "terminal")).toBe("terminal");
    });

    it("falls back to the first surviving section", () => {
        expect(resolveSelection(filterSections(sections(), "scrollback"), "about")).toBe("terminal");
    });

    it("returns null when the filter emptied the list", () => {
        expect(resolveSelection([], "terminal")).toBeNull();
    });
});

describe("changedCount", () => {
    const section: SettingSectionDef = {
        id: "terminal",
        name: "Terminal",
        blurb: "",
        group: "Agents",
        rows: [
            { id: "a", title: "A", desc: "", key: "a" },
            { id: "b", title: "B", desc: "", key: "b" },
        ],
    };

    it("counts only this section's changed rows", () => {
        expect(changedCount(section, new Set(["a", "elsewhere"]))).toBe(1);
        expect(changedCount(section, new Set())).toBe(0);
    });
});

describe("settingsSections static rows", () => {
    const rowsOf = (id: string) => sections().find((s) => s.id === id)!.rows;
    const THEME_KEY = "cockpit.theme.overrides";

    it("lists the Appearance rows with their titles, keys and scope", () => {
        expect(rowsOf("appearance").map((r) => [r.id, r.title, r.key, r.scope])).toEqual([
            ["appearance.theme", "Theme", "cockpit.theme.preset", "local"],
            ["appearance.accent", "Accent", THEME_KEY, "local"],
            ["appearance.success", "Working / accept", THEME_KEY, "local"],
            ["appearance.warning", "Asking / attention", THEME_KEY, "local"],
            ["appearance.error", "Blocked / reject", THEME_KEY, "local"],
        ]);
    });

    it("lists the Fonts rows with their titles, keys and scope", () => {
        expect(rowsOf("fonts").map((r) => [r.id, r.title, r.key, r.scope])).toEqual([
            ["fonts.sans", "Interface font", "cockpit.font.sans", "local"],
            ["fonts.mono", "Code font", "cockpit.font.mono", "local"],
            ["fonts.term", "Terminal font", "term:fontfamily", "synced"],
        ]);
    });

    it("lists the General rows with their titles, keys and scope", () => {
        expect(rowsOf("general").map((r) => [r.id, r.title, r.key, r.scope])).toEqual([
            ["general.startup", "Startup surface", "cockpit.startup.surface", "local"],
            ["general.rail", "Show details rail by default", "agent.rail.visible", "local"],
        ]);
    });

    it("lists no rows for Storage, whose detail pane draws its own content", () => {
        expect(rowsOf("storage")).toEqual([]);
    });

    it("lists the About rows with their titles and keys, none carrying a scope", () => {
        expect(rowsOf("about").map((r) => [r.id, r.title, r.key, r.scope])).toEqual([
            ["about.app", "App version", "tauri.conf.json", undefined],
            ["about.server", "Backend version", "dist/bin", undefined],
            ["about.buildtime", "Backend build time", "dist/bin", undefined],
            ["about.platform", "Platform", "runtime", undefined],
        ]);
    });

    it("gives every row prose to read, as the detail pane and the search index show the same text", () => {
        for (const s of sections()) {
            for (const r of s.rows) {
                expect(r.title, r.id).not.toBe("");
                expect(r.desc, r.id).not.toBe("");
            }
        }
    });
});

describe("countLabel", () => {
    it("singularizes one", () => {
        expect(countLabel(1)).toBe("1 setting");
        expect(countLabel(4)).toBe("4 settings");
    });
});

describe("skim rows", () => {
    it("lists one row per option the mod declares, kept on this machine", () => {
        const skim = sections().find((s) => s.id === "skim");
        expect(skim?.group).toBe("Agents");
        expect(skim?.rows.map((r) => r.id)).toEqual(SKIM_FIELDS.map((f) => `skim.${f.field}`));
        expect(skim?.rows.every((r) => r.scope === "local" && !r.config)).toBe(true);
        expect(skim?.rows[0]?.key).toContain(`pluginConfigs.${SKIM_PLUGIN}.highlight`);
    });

    it("reads an option as on unless it is stored false", () => {
        expect(isModOptionOn(null, "dim")).toBe(true);
        expect(isModOptionOn({}, "dim")).toBe(true);
        expect(isModOptionOn({ dim: true }, "dim")).toBe(true);
        expect(isModOptionOn({ dim: false }, "dim")).toBe(false);
        expect(isModOptionOn({ dim: false }, "highlight")).toBe(true);
    });
});

describe("jira section", () => {
    const jira = () => sections().find((s) => s.id === "jira")!;

    it("sits in Data between Headless AI and Storage", () => {
        const data = groupSections(sections()).find((g) => g.label === "Data")!;
        const ids = data.sections.map((s) => s.id);
        expect(ids.indexOf("jira")).toBe(ids.indexOf("headless") + 1);
        expect(ids.indexOf("storage")).toBe(ids.indexOf("jira") + 1);
    });

    it("has the board's four rows", () => {
        expect(jira().name).toBe("Jira");
        expect(jira().rows.map((r) => [r.id, r.title, r.key, r.scope])).toEqual([
            ["jira.site", "Site", "jira:site", "synced"],
            ["jira.email", "Account email", "jira:email", "synced"],
            ["jira.token", "API token", "secretstore · JIRA_API_TOKEN", "local"],
            ["jira.connection", "Connection", undefined, undefined],
        ]);
        expect(jira().rows[0].desc).toBe("Your Jira Cloud address.");
        expect(jira().rows[2].desc).toContain("never in settings.json");
    });

    it("stores the token under the secret pkg/jira reads", () => {
        expect(JIRA_SECRET_NAME).toBe("JIRA_API_TOKEN");
    });
});

describe("jiraSiteError", () => {
    it("asks for the https address when the scheme is missing", () => {
        expect(jiraSiteError("acme.atlassian.net")).toMatch(/https:\/\/<name>\.atlassian\.net/);
    });

    it("accepts a Jira Cloud address, with or without a trailing slash", () => {
        expect(jiraSiteError("https://acme.atlassian.net")).toBeNull();
        expect(jiraSiteError("https://acme.atlassian.net/")).toBeNull();
    });

    it("rejects other hosts, paths and plain http", () => {
        expect(jiraSiteError("http://acme.atlassian.net")).not.toBeNull();
        expect(jiraSiteError("https://acme.example.com")).not.toBeNull();
        expect(jiraSiteError("https://acme.atlassian.net/jira")).not.toBeNull();
    });

    it("lets an empty site through, which disconnects", () => {
        expect(jiraSiteError("")).toBeNull();
    });
});

describe("jiraConnectionLine", () => {
    const NOW = 1_000_000_000_000;

    it("names what is missing", () => {
        expect(jiraConnectionLine({ configured: false, ok: false, missing: ["token"] }, NOW)).toEqual({
            tone: "idle",
            text: "Add your API token to connect.",
        });
        expect(jiraConnectionLine({ configured: false, ok: false, missing: ["site", "email"] }, NOW).text).toBe(
            "Add your site and account email to connect."
        );
        expect(
            jiraConnectionLine({ configured: false, ok: false, missing: ["site", "email", "token"] }, NOW).text
        ).toBe("Add your site, account email and API token to connect.");
    });

    it("says not checked yet before any attempt", () => {
        expect(jiraConnectionLine({ configured: true, ok: false }, NOW)).toEqual({
            tone: "idle",
            text: "Not checked yet",
        });
    });

    it("reports who is connected and when it was checked", () => {
        const line = jiraConnectionLine(
            { configured: true, ok: true, displayname: "Fixture User", checkedts: NOW - 3 * 60_000 },
            NOW
        );
        expect(line).toEqual({ tone: "ok", text: "Connected as Fixture User", checked: "Checked 3m ago" });
    });

    it("shows Jira's own message when the last call failed", () => {
        const line = jiraConnectionLine(
            {
                configured: true,
                ok: false,
                checkedts: NOW - 60_000,
                error: "EC-JIRA-HTTP 401: Client must be authenticated.",
            },
            NOW
        );
        expect(line.tone).toBe("error");
        expect(line.text).toBe("Client must be authenticated.");
        expect(line.checked).toBe("Checked 1m ago");
    });

    it("shows the unreachable cause as it is", () => {
        const line = jiraConnectionLine(
            { configured: true, ok: false, checkedts: NOW, error: "EC-JIRA-UNREACHABLE: dial tcp: no such host" },
            NOW
        );
        expect(line.text).toBe("dial tcp: no such host");
    });
});
