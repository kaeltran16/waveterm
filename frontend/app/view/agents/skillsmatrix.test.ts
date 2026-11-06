// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    adoptCount,
    adoptKeep,
    adoptResultText,
    adoptSkip,
    copyDelta,
    KEEP_LEAVE,
    KEEP_VAULT,
    keepHint,
    manageLabel,
    piSkillsLine,
    skillFilePath,
    skillGroups,
    skillNote,
    skillRows,
    skillsSummary,
    type SkillKeep,
} from "./skillsmatrix";

const COLUMNS: AgentSyncSkillColumn[] = [
    { runtime: "claude", label: "Claude Code", present: true },
    { runtime: "codex", label: "Codex", present: true },
    { runtime: "opencode", label: "OpenCode", present: true },
    { runtime: "pi", label: "Pi", present: false },
];

function move(runtime: string, name: string, over: Partial<AgentSyncSkillMove> = {}): AgentSyncSkillMove {
    return { runtime, name, from: `C:\\h\\${runtime}\\skills\\${name}`, seed: false, bodydiff: false, ...over };
}

function data(over: Partial<CommandAgentSyncSkillsRtnData> = {}): CommandAgentSyncSkillsRtnData {
    return {
        skills: [],
        columns: COLUMNS,
        skillsroot: "C:\\vault\\skills",
        unmanaged: [],
        unresolved: [],
        linked: [],
        ...over,
    };
}

// one skill of each kind: translate (body differs), lint (key delta), commit + wrangler (same in two),
// graphify (only in claude), review-spec (only in codex), vaulted (managed)
function sample(): CommandAgentSyncSkillsRtnData {
    return data({
        skills: [
            {
                name: "vaulted",
                description: "A canonical skill.",
                states: { claude: "synced", codex: "differs", opencode: "unmanaged", pi: "absent" },
            },
        ],
        unmanaged: [
            move("claude", "commit", { seed: true }),
            move("claude", "graphify", { seed: true }),
            move("claude", "lint", { seed: true }),
            move("claude", "translate", { seed: true }),
            move("claude", "vaulted"),
            move("claude", "wrangler", { seed: true }),
            move("codex", "commit"),
            move("codex", "lint", { keys: ["description"] }),
            move("codex", "review-spec", { seed: true }),
            move("codex", "translate", { bodydiff: true }),
            move("codex", "wrangler"),
        ],
        unresolved: ["translate"],
    });
}

function groupsOf(d: CommandAgentSyncSkillsRtnData, keep: SkillKeep = {}) {
    return skillGroups(d, keep).map((g) => ({ title: g.title, names: g.rows.map((r) => r.name) }));
}

describe("skillGroups", () => {
    it("puts every skill in one group, in the spec's order, each with its members", () => {
        expect(groupsOf(sample())).toEqual([
            { title: "Needs a decision", names: ["translate"] },
            { title: "Differs between harnesses", names: ["lint"] },
            { title: "Same copy in 2 harnesses", names: ["commit", "wrangler"] },
            { title: "Only in Claude Code", names: ["graphify"] },
            { title: "Only in Codex", names: ["review-spec"] },
            { title: "Own copy beside the vault", names: ["vaulted"] },
        ]);
    });

    it("sends a skill found in one harness to Only in <label>", () => {
        const groups = groupsOf(data({ unmanaged: [move("opencode", "solo", { seed: true })] }));
        expect(groups).toEqual([{ title: "Only in OpenCode", names: ["solo"] }]);
    });

    it("keeps an unresolved skill in Needs a decision until it has a keep", () => {
        expect(groupsOf(sample())[0]).toEqual({ title: "Needs a decision", names: ["translate"] });
        const kept = groupsOf(sample(), { translate: "codex" });
        expect(kept.find((g) => g.title === "Needs a decision")).toBeUndefined();
        expect(kept.find((g) => g.title === "Differs between harnesses")?.names).toEqual(["lint", "translate"]);
    });

    it("ignores a keep that names a runtime holding no copy", () => {
        expect(groupsOf(sample(), { translate: "opencode" })[0]).toEqual({
            title: "Needs a decision",
            names: ["translate"],
        });
    });

    it("splits identical copies by how many harnesses hold them, widest first", () => {
        const groups = groupsOf(
            data({
                unmanaged: [
                    move("claude", "a", { seed: true }),
                    move("claude", "b", { seed: true }),
                    move("codex", "a"),
                    move("codex", "b"),
                    move("opencode", "b"),
                ],
            })
        );
        expect(groups).toEqual([
            { title: "Same copy in 3 harnesses", names: ["b"] },
            { title: "Same copy in 2 harnesses", names: ["a"] },
        ]);
    });

    it("shows a vault skill's stray copy as its cell, not as a second row", () => {
        const names = skillGroups(sample(), {}).flatMap((g) => g.rows.map((r) => r.name));
        expect(names.filter((n) => n === "vaulted")).toHaveLength(1);
    });

    it("orders Only-in groups by harness column, whatever order the copies were found in", () => {
        const groups = groupsOf(
            data({
                unmanaged: [
                    move("opencode", "o", { seed: true }),
                    move("codex", "x", { seed: true }),
                    move("claude", "c", { seed: true }),
                ],
            })
        );
        expect(groups).toEqual([
            { title: "Only in Claude Code", names: ["c"] },
            { title: "Only in Codex", names: ["x"] },
            { title: "Only in OpenCode", names: ["o"] },
        ]);
    });

    it("runs the widest Same-copy group first even when a narrower skill is found first", () => {
        const groups = groupsOf(
            data({
                unmanaged: [
                    move("claude", "narrow", { seed: true }),
                    move("codex", "narrow"),
                    move("claude", "wide", { seed: true }),
                    move("codex", "wide"),
                    move("opencode", "wide"),
                ],
            })
        );
        expect(groups.map((g) => g.title)).toEqual(["Same copy in 3 harnesses", "Same copy in 2 harnesses"]);
    });

    it("sorts the skills inside a group by name", () => {
        const groups = groupsOf(
            data({
                unmanaged: [
                    move("claude", "zeta", { seed: true }),
                    move("claude", "alpha", { seed: true }),
                    move("claude", "mid", { seed: true }),
                ],
            })
        );
        expect(groups).toEqual([{ title: "Only in Claude Code", names: ["alpha", "mid", "zeta"] }]);
    });
});

describe("skillRows cells", () => {
    function cells(name: string, keep: SkillKeep = {}) {
        return skillRows(sample(), keep)
            .find((r) => r.name === name)!
            .cells.map((c) => c.label);
    }

    it("maps managed states, and a column that is not set up reads as nothing", () => {
        expect(cells("vaulted")).toEqual(["Synced", "Not synced", "Own copy", "—"]);
    });

    it("shows a shipped skill Claude loads from the Arc plugin under its arc: name", () => {
        const d = data({ skills: [{ name: "runs", states: { claude: "plugin", codex: "synced" } }] });
        const cell = skillRows(d, {})[0].cells[0];
        expect(cell).toMatchObject({ label: "Plugin", tone: "ok", title: "Loaded as arc:runs from the Arc plugin" });
    });

    it("shows what each unmanaged copy carries", () => {
        expect(cells("translate")).toEqual(["Differs", "Body differs", "—", "—"]);
        expect(cells("lint")).toEqual(["Differs", "description", "—", "—"]);
        expect(cells("commit")).toEqual(["Own copy", "Own copy", "—", "—"]);
        expect(cells("graphify")).toEqual(["Only here", "—", "—", "—"]);
    });

    it("shows which copy a keep chooses and which it replaces", () => {
        expect(cells("translate", { translate: "codex" })).toEqual(["Replaced", "Kept", "—", "—"]);
    });

    it("lists a skill's copies in column order, whatever order they were found in", () => {
        const d = data({
            unmanaged: [
                move("opencode", "scrambled"),
                move("claude", "scrambled", { seed: true }),
                move("codex", "scrambled"),
                move("claude", "ordered", { seed: true }),
                move("codex", "ordered"),
                move("opencode", "ordered"),
            ],
        });
        const copies = (name: string) =>
            skillRows(d, {})
                .find((r) => r.name === name)!
                .copies.map((c) => c.runtime);
        expect(copies("scrambled")).toEqual(["claude", "codex", "opencode"]);
        expect(copies("ordered")).toEqual(["claude", "codex", "opencode"]);
    });

    it("titles a managed cell with the harness's overrides, and leaves the title off when it has none", () => {
        const d = data({
            skills: [
                {
                    name: "tuned",
                    states: { claude: "synced", codex: "differs", opencode: "synced" },
                    deltas: { claude: ["description", "model"], codex: ["tools"] },
                },
            ],
        });
        const cells = skillRows(d, {})[0].cells;
        expect(cells[0]).toStrictEqual({
            runtime: "claude",
            label: "Synced",
            tone: "ok",
            title: "Overrides description, model",
        });
        expect(cells[1]).toStrictEqual({
            runtime: "codex",
            label: "Not synced",
            tone: "warn",
            title: "Overrides tools",
        });
        expect(cells[2]).toStrictEqual({ runtime: "opencode", label: "Synced", tone: "ok", title: undefined });
    });
});

describe("adopt", () => {
    it("excludes an unresolved skill without a keep from the count and the keep map", () => {
        // commit, graphify, lint, review-spec, wrangler; vaulted's stray copy stays until Replace is chosen
        expect(adoptCount(sample(), {})).toBe(5);
        expect(adoptKeep(sample(), {})).toEqual({});
    });

    it("counts an unresolved skill once it has a keep, and sends that keep", () => {
        expect(adoptCount(sample(), { translate: "claude" })).toBe(6);
        expect(adoptKeep(sample(), { translate: "claude" })).toEqual({ translate: "claude" });
    });

    it("sends no keep for a resolved skill, a missing copy, or a managed skill", () => {
        const d = { ...sample(), unresolved: ["translate", "vaulted"] };
        expect(adoptKeep(d, { lint: "codex", translate: "pi", vaulted: "claude" })).toEqual({});
        expect(adoptCount(d, { vaulted: "claude" })).toBe(5);
    });

    it("labels the button", () => {
        expect(manageLabel(18)).toBe("Manage 18 skills in Arc");
        expect(manageLabel(1)).toBe("Manage 1 skill in Arc");
    });
});

describe("skillsSummary", () => {
    it("counts every skill once and the ones Arc manages", () => {
        expect(skillsSummary(sample())).toBe("7 skills · 1 managed by Arc");
    });

    it("says none when the vault holds no skill", () => {
        expect(skillsSummary(data({ unmanaged: [move("claude", "x", { seed: true })] }))).toBe(
            "1 skill · none managed by Arc"
        );
    });
});

describe("skillFilePath", () => {
    const rows = () => skillRows(sample(), {});

    it("opens the vault copy of a managed skill", () => {
        const r = rows().find((x) => x.name === "vaulted")!;
        expect(skillFilePath(r, "C:\\vault\\skills", {})).toBe("C:\\vault\\skills\\vaulted\\SKILL.md");
    });

    it("opens the kept copy, else the base copy", () => {
        const r = rows().find((x) => x.name === "translate")!;
        expect(skillFilePath(r, "", {})).toBe("C:\\h\\claude\\skills\\translate\\SKILL.md");
        expect(skillFilePath(r, "", { translate: "codex" })).toBe("C:\\h\\codex\\skills\\translate\\SKILL.md");
    });
});

describe("copyDelta", () => {
    it("names the base copy, the overrides, or a body difference", () => {
        const copies = skillRows(sample(), {}).find((x) => x.name === "lint")!.copies;
        expect(copies.map(copyDelta)).toEqual(["Base copy", "Overrides description"]);
        const t = skillRows(sample(), {}).find((x) => x.name === "translate")!.copies;
        expect(copyDelta(t[1])).toBe("Body text differs");
    });
});

describe("links", () => {
    const link = (runtime: string, name: string, target: string): AgentSyncSkillLink => ({
        runtime,
        name,
        path: `C:\\h\\${runtime}\\skills\\${name}`,
        target,
    });

    it("lists a non-vault link in its own group, never counted toward Manage", () => {
        const d = data({
            unmanaged: [move("claude", "solo", { seed: true })],
            linked: [link("codex", "shared-tool", "D:\\tools\\shared-tool")],
        });
        expect(groupsOf(d)).toEqual([
            { title: "Only in Claude Code", names: ["solo"] },
            { title: "Linked from another folder", names: ["shared-tool"] },
        ]);
        const row = skillRows(d, {}).find((r) => r.name === "shared-tool")!;
        expect(row.kind).toBe("linked");
        expect(row.cells[1]).toMatchObject({ label: "Link", title: "D:\\tools\\shared-tool" });
        expect(row.cells[0].label).toBe("—");
        expect(adoptCount(d, {})).toBe(1);
        expect(adoptSkip(d, {})).toEqual([]);
    });

    it("drops a junction's \\??\\ prefix from the target it shows", () => {
        const d = data({ linked: [link("claude", "j", "\\??\\D:\\tools\\j")] });
        expect(skillRows(d, {})[0].cells[0].title).toBe("D:\\tools\\j");
    });

    it("reads a vault skill's linked harness entry as Link, in the warn tone", () => {
        const d = data({ skills: [{ name: "vaulted", states: { claude: "synced", codex: "linked" } }] });
        expect(skillRows(d, {})[0].cells[1]).toMatchObject({ label: "Link", tone: "warn" });
    });

    it("titles a vault skill's Link cell with its link's target, as no row of its own", () => {
        const d = data({
            skills: [{ name: "vaulted", states: { claude: "synced", codex: "linked" } }],
            linked: [link("codex", "vaulted", "\\??\\D:\\tools\\vaulted")],
        });
        const rows = skillRows(d, {});
        expect(rows).toHaveLength(1);
        expect(rows[0].cells[1]).toEqual({
            runtime: "codex",
            label: "Link",
            tone: "warn",
            title: "D:\\tools\\vaulted",
        });
        expect(groupsOf(d).map((g) => g.title)).not.toContain("Linked from another folder");
        expect(adoptCount(d, {})).toBe(0);
    });

    it("falls back to a fixed title when an older backend lists no link for a vault skill", () => {
        const d = data({ skills: [{ name: "vaulted", states: { claude: "synced", codex: "linked" } }] });
        expect(skillRows(d, {})[0].cells[1].title).toBe(
            "A link to another folder: Arc leaves it alone and does not write this skill here"
        );
    });

    it("says in the rail that Arc leaves links alone", () => {
        const d = data({ linked: [link("codex", "shared-tool", "D:\\tools\\shared-tool")] });
        const note = skillNote(skillRows(d, {})[0], COLUMNS);
        expect(note).toMatch(/leaves links alone/);
        expect(note).toMatch(/never moves one into the vault/);
    });
});

describe("stray copies of a vault skill", () => {
    function stray(): CommandAgentSyncSkillsRtnData {
        return data({
            skills: [{ name: "helper", states: { claude: "synced", codex: "unmanaged" } }],
            unmanaged: [move("codex", "helper", { vault: true, bodydiff: true })],
        });
    }

    it("leaves Managed by Arc for Own copy beside the vault", () => {
        expect(groupsOf(stray())).toEqual([{ title: "Own copy beside the vault", names: ["helper"] }]);
        const row = skillRows(stray(), {})[0];
        expect(row.kind).toBe("stray");
        expect(row.copies.map((c) => c.runtime)).toEqual(["codex"]);
        expect(copyDelta(row.copies[0])).toBe("Body text differs");
    });

    it("counts toward Manage only once Replace is chosen, then sends the vault keep", () => {
        expect(adoptCount(stray(), {})).toBe(0);
        expect(adoptKeep(stray(), {})).toEqual({});
        const keep = { helper: KEEP_VAULT };
        expect(adoptCount(stray(), keep)).toBe(1);
        expect(adoptKeep(stray(), keep)).toEqual({ helper: "vault" });
        expect(skillRows(stray(), keep)[0].cells[1]).toMatchObject({ label: "Replaced", tone: "warn" });
    });

    it("previews the vault copy", () => {
        const row = skillRows(stray(), {})[0];
        expect(skillFilePath(row, "C:\\vault\\skills", {})).toBe("C:\\vault\\skills\\helper\\SKILL.md");
    });
});

describe("leaving a skill alone", () => {
    it("skips a left-alone row: Left alone cells, out of the count, sent in skip and never in keep", () => {
        const keep = { commit: KEEP_LEAVE };
        expect(adoptSkip(sample(), keep)).toEqual(["commit"]);
        expect(adoptKeep(sample(), keep)).toEqual({});
        expect(adoptCount(sample(), keep)).toBe(4);
        const row = skillRows(sample(), keep).find((r) => r.name === "commit")!;
        expect(row.cells.map((c) => c.label)).toEqual(["Left alone", "Left alone", "—", "—"]);
    });

    it("lets an undecided skill be left alone instead of waiting for a decision", () => {
        const keep = { translate: KEEP_LEAVE };
        expect(adoptSkip(sample(), keep)).toEqual(["translate"]);
        expect(adoptKeep(sample(), keep)).toEqual({});
        expect(groupsOf(sample(), keep).find((g) => g.title === "Needs a decision")).toBeUndefined();
    });

    it("skips nothing for a vault skill or a name with no copy", () => {
        expect(adoptSkip(sample(), { vaulted: KEEP_LEAVE, ghost: KEEP_LEAVE })).toEqual([]);
    });
});

describe("harness names instead of every harness", () => {
    const TWO: AgentSyncSkillColumn[] = [
        { runtime: "claude", label: "Claude Code", present: true },
        { runtime: "codex", label: "Codex", present: true },
        { runtime: "pi", label: "Pi", present: false },
    ];

    it("names the other present harness for an only row", () => {
        const d = data({ columns: TWO, unmanaged: [move("claude", "solo", { seed: true })] });
        const note = skillNote(skillRows(d, {})[0], TWO);
        expect(note).toMatch(/Codex/);
        expect(note).not.toMatch(/Pi/);
    });

    it("never says every harness", () => {
        const d = { ...sample(), columns: TWO, linked: [{ runtime: "claude", name: "l", path: "p", target: "t" }] };
        for (const row of skillRows(d, { commit: KEEP_LEAVE, translate: "codex" })) {
            expect(skillNote(row, TWO)).not.toMatch(/every harness/i);
        }
        expect(keepHint(TWO)).toBe("Claude Code and Codex get it. The other copies are set aside.");
    });
});

describe("adoptResultText", () => {
    const moves = ["a", "b", "c"].map((n) => move("claude", n, { seed: true }));

    it("counts what the reply moved, what waits, and what was left alone", () => {
        const rtn: CommandAgentSyncAdoptRtnData = {
            moves: [
                ...moves,
                move("codex", "a"),
                move("claude", "d", { seed: true }),
                move("codex", "d", { bodydiff: true }),
            ],
            unresolved: ["d"],
        };
        expect(adoptResultText(rtn, { skip: ["x", "y"] })).toBe(
            "Moved 3 skills into the vault · 1 wait for a decision · 2 left alone"
        );
    });

    it("leaves out the zero parts and says one skill", () => {
        expect(adoptResultText({ moves: [moves[0]] }, { skip: [] })).toBe("Moved 1 skill into the vault");
    });

    it("counts a vault skill's copy only when the vault copy was kept", () => {
        const rtn = { moves: [move("codex", "helper", { vault: true })] };
        expect(adoptResultText(rtn, { skip: [] })).toBe("Moved 0 skills into the vault");
        expect(adoptResultText(rtn, { skip: [], keep: { helper: KEEP_VAULT } })).toBe("Moved 1 skill into the vault");
    });

    it("says a snapshot moved nothing", () => {
        expect(adoptResultText({ moves, dryrun: true }, { skip: [] })).toBe("Snapshot: nothing moved (would move 3)");
    });
});

describe("piSkillsLine", () => {
    const status = (pi: Partial<AgentSyncHarness>): CommandAgentSyncStatusRtnData => ({
        harnesses: [
            {
                runtime: "pi",
                label: "Pi",
                path: "",
                present: true,
                steering: "current",
                skillsmanaged: 0,
                skillsunmanaged: 0,
                ...pi,
            },
        ],
        steeringdoc: "",
        skillsroot: "",
    });

    it("says Pi's note in its tone when Pi is set up", () => {
        expect(piSkillsLine(status({ note: "via the vault directly", notetone: "ok" }))).toEqual({
            text: "Pi skills: via the vault directly",
            tone: "ok",
        });
        expect(
            piSkillsLine(status({ note: "pi settings do not point at the synced skills", notetone: "warn" }))?.tone
        ).toBe("warn");
    });

    it("draws nothing when Pi is not set up or has no note", () => {
        expect(piSkillsLine(status({ present: false, note: "x", notetone: "warn" }))).toBeNull();
        expect(piSkillsLine(status({}))).toBeNull();
        expect(piSkillsLine(null)).toBeNull();
    });
});
