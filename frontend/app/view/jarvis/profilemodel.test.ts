import { describe, expect, it } from "vitest";
import {
    applyApprovals,
    approvalsRow,
    blankMessage,
    blankPrinciples,
    defaultReach,
    DIAGNOSTIC_MISSING_DISABLED,
    DIAGNOSTIC_MISSING_REPLACEMENT,
    discardPrompt,
    isDirty,
    lightReviewerRow,
    normalizePrinciplePatch,
    overrideSummary,
    principleNote,
    principleRows,
    principleSummary,
    profileOverrideIsEmpty,
    type ProjectOverride,
    reduceGlobalPrinciples,
    reducePrinciplePatch,
    removedPrincipleNotes,
    resetActionState,
    resetRow,
    saveScopes,
    staleRowText,
    unsavedLabel,
    unsavedScopes,
} from "./profilemodel";

const G: Principle[] = [
    { id: "a", text: "Alpha" },
    { id: "b", text: "Bravo" },
    { id: "c", text: "Charlie" },
];

describe("reducePrinciplePatch", () => {
    it("override adds a replacement immutably", () => {
        const before = undefined;
        const after = reducePrinciplePatch(before, { type: "override", id: "b", text: "B2" });
        expect(after).toEqual({ replacements: { b: "B2" } });
    });
    it("reset removes the replacement and empties back to undefined", () => {
        const start: PrinciplePatch = { replacements: { b: "B2" } };
        const after = reducePrinciplePatch(start, { type: "reset", id: "b" });
        expect(after).toBeUndefined();
        // original is untouched
        expect(start).toEqual({ replacements: { b: "B2" } });
    });
    it("disable then reenable is a no-op that collapses to undefined", () => {
        const disabled = reducePrinciplePatch(undefined, { type: "disable", id: "a" });
        expect(disabled).toEqual({ disabled: ["a"] });
        const reenabled = reducePrinciplePatch(disabled, { type: "reenable", id: "a" });
        expect(reenabled).toBeUndefined();
    });
    it("disable does not duplicate an already-disabled id", () => {
        const once = reducePrinciplePatch({ disabled: ["a"] }, { type: "disable", id: "a" });
        expect(once).toEqual({ disabled: ["a"] });
    });
    it("add / update-addition / delete-addition operate on additions only", () => {
        const added = reducePrinciplePatch(undefined, { type: "add", principle: { id: "p1", text: "" } });
        expect(added).toEqual({ additions: [{ id: "p1", text: "" }] });
        const edited = reducePrinciplePatch(added, { type: "update-addition", id: "p1", text: "hi" });
        expect(edited).toEqual({ additions: [{ id: "p1", text: "hi" }] });
        const deleted = reducePrinciplePatch(edited, { type: "delete-addition", id: "p1" });
        expect(deleted).toBeUndefined();
    });
    it("override keeps the replacements already in the patch", () => {
        const start: PrinciplePatch = { replacements: { a: "A2" } };
        const after = reducePrinciplePatch(start, { type: "override", id: "b", text: "B2" });
        expect(after).toEqual({ replacements: { a: "A2", b: "B2" } });
    });
    it("reenable of an id that is not disabled changes nothing", () => {
        const after = reducePrinciplePatch({ disabled: ["a", "b"] }, { type: "reenable", id: "zzz" });
        expect(after).toEqual({ disabled: ["a", "b"] });
    });
    it("update-addition edits only the addition it names", () => {
        const start: PrinciplePatch = {
            additions: [
                { id: "p1", text: "one" },
                { id: "p2", text: "two" },
            ],
        };
        const after = reducePrinciplePatch(start, { type: "update-addition", id: "p2", text: "TWO" });
        expect(after).toEqual({
            additions: [
                { id: "p1", text: "one" },
                { id: "p2", text: "TWO" },
            ],
        });
    });
    it("delete-addition removes the addition it names, not the first or last", () => {
        const start: PrinciplePatch = {
            additions: [
                { id: "p1", text: "one" },
                { id: "p2", text: "two" },
                { id: "p3", text: "three" },
            ],
        };
        const after = reducePrinciplePatch(start, { type: "delete-addition", id: "p2" });
        expect(after).toEqual({
            additions: [
                { id: "p1", text: "one" },
                { id: "p3", text: "three" },
            ],
        });
    });
    it("delete-addition of an unknown id changes nothing", () => {
        const start: PrinciplePatch = {
            additions: [
                { id: "p1", text: "one" },
                { id: "p2", text: "two" },
            ],
        };
        expect(reducePrinciplePatch(start, { type: "delete-addition", id: "zzz" })).toEqual(start);
    });
    it("preserves unrelated fields and order", () => {
        const start: PrinciplePatch = { additions: [{ id: "p1", text: "one" }], disabled: ["a"] };
        const after = reducePrinciplePatch(start, { type: "override", id: "b", text: "B2" });
        expect(after).toEqual({ additions: [{ id: "p1", text: "one" }], replacements: { b: "B2" }, disabled: ["a"] });
        expect(start).toEqual({ additions: [{ id: "p1", text: "one" }], disabled: ["a"] });
    });
});

describe("principleRows", () => {
    it("maps inherited/modified/disabled/project rows in order", () => {
        const patch: PrinciplePatch = {
            replacements: { b: "Bravo!" },
            disabled: ["c"],
            additions: [{ id: "p1", text: "Project one" }],
        };
        const rows = principleRows(G, patch, []);
        expect(rows).toEqual([
            { id: "a", text: "Alpha", kind: "inherited" },
            { id: "b", text: "Bravo!", kind: "modified", originalText: "Bravo" },
            { id: "c", text: "Charlie", kind: "disabled" },
            { id: "p1", text: "Project one", kind: "project" },
        ]);
    });
    it("emits stale rows for diagnostics referencing missing globals", () => {
        const patch: PrinciplePatch = { replacements: { gone: "x" }, disabled: ["also-gone"] };
        const diags: PrincipleDiagnostic[] = [
            { code: DIAGNOSTIC_MISSING_REPLACEMENT, principleid: "gone" },
            { code: DIAGNOSTIC_MISSING_DISABLED, principleid: "also-gone" },
        ];
        const rows = principleRows(G, patch, diags);
        const stale = rows.filter((r) => r.kind === "stale");
        expect(stale).toEqual([
            { id: "gone", text: "x", kind: "stale", diagnostic: DIAGNOSTIC_MISSING_REPLACEMENT },
            { id: "also-gone", text: "", kind: "stale", diagnostic: DIAGNOSTIC_MISSING_DISABLED },
        ]);
    });
    it("handles an undefined patch as all-inherited", () => {
        const rows = principleRows(G, undefined, []);
        expect(rows.every((r) => r.kind === "inherited")).toBe(true);
        expect(rows).toHaveLength(3);
    });
});

describe("isDirty", () => {
    it("treats a structurally empty patch as equal to undefined", () => {
        expect(isDirty({}, { principles: {} })).toBe(false);
        expect(isDirty({ principles: { additions: [], disabled: [] } }, {})).toBe(false);
    });
    it("treats a route-only override as project-scoped and dirty", () => {
        expect(isDirty({}, { route: { runtime: "pi" } })).toBe(true);
        expect(isDirty({ route: undefined }, { route: undefined })).toBe(false);
    });
    it("compares a patch by what it holds, not by the empty lists it carries", () => {
        expect(isDirty({ principles: { additions: [], disabled: ["a"] } }, { principles: { disabled: ["a"] } })).toBe(
            false
        );
    });
    it("ignores a route that names no runtime", () => {
        expect(isDirty({ route: { runtime: "" } }, {})).toBe(false);
        expect(isDirty({ route: { model: "m" } as RoutePin }, {})).toBe(false);
    });
    it("ignores an empty route model", () => {
        expect(isDirty({ route: { runtime: "pi", model: "" } }, { route: { runtime: "pi" } })).toBe(false);
    });
    it("is dirty when the route's runtime or model changes", () => {
        expect(isDirty({ route: { runtime: "pi" } }, { route: { runtime: "claude" } })).toBe(true);
        expect(isDirty({ route: { runtime: "pi", model: "a" } }, { route: { runtime: "pi", model: "b" } })).toBe(true);
    });
    it("is true when the patch differs meaningfully", () => {
        expect(isDirty({}, { principles: { disabled: ["a"] } })).toBe(true);
        expect(
            isDirty({ principles: { replacements: { a: "x" } } }, { principles: { replacements: { a: "y" } } })
        ).toBe(true);
        expect(isDirty({ defaultmode: "quick" }, {})).toBe(true);
    });
});

describe("reduceGlobalPrinciples", () => {
    const base: Principle[] = [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
    ];
    it("add appends a caller-built principle", () => {
        expect(reduceGlobalPrinciples(base, { type: "add", principle: { id: "c", text: "" } })).toEqual([
            { id: "a", text: "A" },
            { id: "b", text: "B" },
            { id: "c", text: "" },
        ]);
    });
    it("update changes text by id only", () => {
        const out = reduceGlobalPrinciples(base, { type: "update", id: "a", text: "A2" });
        expect(out[0].text).toBe("A2");
        expect(out[1].text).toBe("B");
    });
    it("delete removes by id", () => {
        expect(reduceGlobalPrinciples(base, { type: "delete", id: "a" })).toEqual([{ id: "b", text: "B" }]);
    });
    it("move swaps neighbors", () => {
        expect(reduceGlobalPrinciples(base, { type: "move", id: "b", dir: -1 }).map((p) => p.id)).toEqual(["b", "a"]);
    });
    it("move out of bounds is a no-op", () => {
        expect(reduceGlobalPrinciples(base, { type: "move", id: "a", dir: -1 })).toEqual(base);
    });
});

// The frontend mirror of jarvis.ProfileOverrideIsEmpty: reaching it must mean every section is absent, so
// an override that carries only engine defaults is never mistaken for a cleared one.
describe("profileOverrideIsEmpty", () => {
    const cases: Array<[string, ProfileOverride | null | undefined, boolean]> = [
        ["nil", null, true],
        ["bare", {}, true],
        ["empty patch", { principles: {} }, true],
        ["parallelism", { parallelism: 3 }, false],
        ["worker route", { workerroute: { runtime: "pi" } }, false],
        ["lead route", { route: { runtime: "pi" } }, false],
        ["default mode", { defaultmode: "orchestrator" }, false],
        ["landing", { landing: "branch" }, false],
        ["approvals", { autonomous: false }, false],
        ["patch with a disable", { principles: { disabled: ["a"] } }, false],
    ];
    for (const [name, override, want] of cases) {
        it(`${name} -> ${want}`, () => {
            expect(profileOverrideIsEmpty(override)).toBe(want);
        });
    }
});

// Every row of the future-run defaults: reset drops the section's override from the draft. Dropping a key
// while the draft is being written would mutate what is in flight, so the save's duration disables it.
describe("resetActionState", () => {
    it("offers a reset only where the project overrides the global", () => {
        expect(resetActionState(false, false)).toEqual({ show: true, disabled: false });
        expect(resetActionState(true, false).show).toBe(false);
    });

    it("disables every row's reset for the whole save", () => {
        expect(resetActionState(false, true)).toEqual({ show: true, disabled: true });
    });
});

describe("overrideSummary", () => {
    it("counts the rows a project sets, including the lead route", () => {
        expect(overrideSummary({})).toBe("All from global");
        expect(overrideSummary({ parallelism: 3, route: { runtime: "claude" } })).toBe("2 set for this project");
    });
    it("counts where runs land", () => {
        expect(overrideSummary({ landing: "checkout" })).toBe("1 set for this project");
    });
    it("does not count principles, which have their own section", () => {
        expect(overrideSummary({ principles: { disabled: ["a"] } })).toBe("All from global");
    });
});

describe("principleSummary", () => {
    it("says so when the project changes nothing", () => {
        expect(principleSummary(principleRows(G, undefined, []))).toBe("3 from global, no changes here");
    });
    it("counts customized, added and disabled, keeping disabled globals in the global count", () => {
        const patch: PrinciplePatch = {
            replacements: { a: "A2" },
            disabled: ["b"],
            additions: [{ id: "p1", text: "Mine" }],
        };
        expect(principleSummary(principleRows(G, patch, []))).toBe(
            "3 from global · 1 customized · 1 added · 1 disabled"
        );
    });
});

// The Approvals row: a project's own value, Ask me included, holds over the global; Reset drops it back.
describe("approvals row", () => {
    const global = (autonomous?: boolean): JarvisProfile => ({ autonomous }) as JarvisProfile;

    it("an override with only autonomous is not empty and reads as Project", () => {
        const o: ProfileOverride = { autonomous: true };
        expect(profileOverrideIsEmpty(o)).toBe(false);
        expect(approvalsRow(o, global(), true)).toEqual({ autonomous: true, inherited: false });
        expect(overrideSummary(o)).toBe("1 set for this project");
    });
    it("Reset removes it and the row reads Global", () => {
        const after = resetRow({ autonomous: true, landing: "checkout" }, "autonomous");
        expect(after).toEqual({ landing: "checkout" });
        expect(approvalsRow(after, global(true), true)).toEqual({ autonomous: true, inherited: true });
        expect(profileOverrideIsEmpty(resetRow({ autonomous: false }, "autonomous"))).toBe(true);
    });
    it("a project false over a global true is a stated value, not inheritance", () => {
        const o = applyApprovals<ProfileOverride>({}, false, true);
        expect(o).toEqual({ autonomous: false });
        expect(approvalsRow(o, global(true), true)).toEqual({ autonomous: false, inherited: false });
    });
    it("global scope unsets Ask me rather than storing false", () => {
        const g = global(true);
        expect("autonomous" in applyApprovals(g, false, false)).toBe(false);
        expect(applyApprovals({} as JarvisProfile, true, false).autonomous).toBe(true);
        expect(approvalsRow(g, g, false)).toEqual({ autonomous: true, inherited: false });
    });
    it("counts a project's own approvals against the global one", () => {
        expect(defaultReach([P("opal"), P("wave", { autonomous: false })], "autonomous")).toEqual({
            main: "1 of 2 projects",
            sub: "wave sets its own",
        });
    });
});

// a row's Reset drops just that row; the workers row drops both halves of its pair
describe("resetRow", () => {
    it("drops only the named key", () => {
        expect(resetRow({ landing: "checkout", parallelism: 3 }, "landing")).toEqual({ parallelism: 3 });
    });
    it("drops worker route and reviewer picks together", () => {
        expect(resetRow({ reviewerpicks: false, landing: "branch" }, "workerroute")).toEqual({ landing: "branch" });
    });
});

const P = (name: string, override: ProfileOverride = {}): ProjectOverride => ({ name, override });

describe("defaultReach", () => {
    it("is null with no projects to reach", () => {
        expect(defaultReach([], "parallelism")).toBeNull();
    });
    it("reaches every project that sets nothing", () => {
        expect(defaultReach([P("opal"), P("wave")], "parallelism")).toEqual({ main: "All 2 projects" });
        expect(defaultReach([P("opal")], "parallelism")).toEqual({ main: "1 project" });
    });
    it("names the one project that sets its own", () => {
        expect(defaultReach([P("opal"), P("wave", { defaultmode: "orchestrator" })], "defaultmode")).toEqual({
            main: "1 of 2 projects",
            sub: "wave sets its own",
        });
    });
    it("counts several projects that set their own, and none reached", () => {
        const all = [P("a", { workerroute: { runtime: "pi" } }), P("b", { workerroute: { runtime: "claude" } })];
        expect(defaultReach(all, "workerroute")).toEqual({ main: "No projects", sub: "2 set their own" });
    });
    it("counts a project's own landing against the global one", () => {
        expect(defaultReach([P("opal"), P("wave", { landing: "checkout" })], "landing")).toEqual({
            main: "1 of 2 projects",
            sub: "wave sets its own",
        });
    });
});

describe("principleNote", () => {
    it("is null when no project touches the principle", () => {
        expect(principleNote([P("opal")], "a", "Alpha", false)).toBeNull();
    });
    it("names rewording and disabling projects", () => {
        const projects = [
            P("opal", { principles: { replacements: { a: "A2" } } }),
            P("wave", { principles: { disabled: ["a"] } }),
        ];
        expect(principleNote(projects, "a", "Alpha", false)).toEqual({
            text: "opal uses its own wording · Disabled in wave",
            warn: false,
        });
    });
    it("lets a disable win over a replacement in the same project", () => {
        const projects = [P("opal", { principles: { replacements: { a: "A2" }, disabled: ["a"] } })];
        expect(principleNote(projects, "a", "Alpha", false)?.text).toBe("Disabled in opal");
    });
    it("warns while the principle is edited", () => {
        const projects = [
            P("opal", { principles: { replacements: { a: "A2" } } }),
            P("wave", { principles: { replacements: { a: "A3" } } }),
            P("zinc", { principles: { disabled: ["a"] } }),
        ];
        expect(principleNote(projects, "a", "Alpha", true)).toEqual({
            text: "This edit won't reach 3 projects",
            warn: true,
        });
    });
    it("ignores a stored replacement equal to the global text", () => {
        const projects = [P("opal", { principles: { replacements: { a: "Alpha" } } })];
        expect(principleNote(projects, "a", "Alpha", false)).toBeNull();
        expect(principleNote(projects, "a", "Alpha", true)).toBeNull();
    });
});

describe("normalizePrinciplePatch", () => {
    it("drops a replacement equal to the global text and keeps a real one", () => {
        expect(normalizePrinciplePatch({ replacements: { a: "Alpha", b: "B2" } }, G)).toEqual({
            replacements: { b: "B2" },
        });
    });
    it("cleans a patch left with nothing to undefined", () => {
        expect(normalizePrinciplePatch({ replacements: { a: "Alpha" } }, G)).toBeUndefined();
        expect(normalizePrinciplePatch(undefined, G)).toBeUndefined();
    });
    it("keeps a stale replacement whose principle is gone", () => {
        expect(normalizePrinciplePatch({ replacements: { gone: "Old" } }, G)).toEqual({
            replacements: { gone: "Old" },
        });
    });
    it("makes Customize with unchanged text neither dirty nor customized", () => {
        const customized = reducePrinciplePatch(undefined, { type: "override", id: "a", text: "Alpha" });
        const draft: ProfileOverride = { principles: normalizePrinciplePatch(customized, G) };
        expect(isDirty(draft, {})).toBe(false);
        expect(principleSummary(principleRows(G, draft.principles, []))).toBe("3 from global, no changes here");
    });
});

describe("blankPrinciples", () => {
    it("finds a blank project addition and a whitespace-only replacement with their row numbers", () => {
        const patch: PrinciplePatch = {
            replacements: { b: "   " },
            disabled: ["a"],
            additions: [
                { id: "p1", text: "Fine" },
                { id: "p2", text: "" },
            ],
        };
        // active rows: b (1), c (2), p1 (3), p2 (4); the disabled a is not numbered
        expect(blankPrinciples(principleRows(G, patch, []), null)).toEqual([
            { scope: "project", index: 1, id: "b" },
            { scope: "project", index: 4, id: "p2" },
        ]);
    });
    it("finds blank global principles by list position", () => {
        const global: Principle[] = [
            { id: "a", text: "Alpha" },
            { id: "n", text: " \n" },
        ];
        expect(blankPrinciples(principleRows(G, undefined, []), global)).toEqual([
            { scope: "global", index: 2, id: "n" },
        ]);
    });
    it("names the first blank in the shown scope, or the other scope's with its name", () => {
        const blanks = [
            { scope: "project" as const, index: 3, id: "p" },
            { scope: "global" as const, index: 2, id: "g" },
        ];
        expect(blankMessage(blanks, "project")).toBe("Principle 3 is empty");
        expect(blankMessage(blanks, "global")).toBe("Principle 2 is empty");
        expect(blankMessage([blanks[1]], "project")).toBe("Global principle 2 is empty");
        expect(blankMessage([], "project")).toBeNull();
    });
});

describe("unsavedScopes", () => {
    it("names each dirty scope in the footer and the discard confirm", () => {
        expect(unsavedScopes(true, true)).toEqual(["Project", "Global"]);
        expect(unsavedLabel(unsavedScopes(true, true))).toBe("Unsaved changes · Project and Global");
        expect(discardPrompt(unsavedScopes(true, true))).toBe("Discard unsaved changes to Project and Global?");
        expect(unsavedLabel(unsavedScopes(false, true))).toBe("Unsaved changes · Global");
        expect(unsavedScopes(false, false)).toEqual([]);
    });
});

describe("removedPrincipleNotes", () => {
    it("notes a deleted global principle one project disables", () => {
        const projects = [P("opal", { principles: { disabled: ["b"] } }), P("wave")];
        expect(removedPrincipleNotes(G, [G[0], G[2]], projects)).toEqual([
            { id: "b", text: 'Removed "Bravo" · disabled in opal' },
        ]);
    });
    it("notes a rewording, cuts the text to one line, and skips a replacement equal to the global text", () => {
        const loaded: Principle[] = [{ id: "m", text: "First line\nsecond line" }, ...G];
        const projects = [
            P("opal", { principles: { replacements: { m: "Mine" } } }),
            P("wave", { principles: { replacements: { a: "Alpha" } } }),
        ];
        expect(removedPrincipleNotes(loaded, [G[1], G[2]], projects)).toEqual([
            { id: "m", text: 'Removed "First line…" · opal uses its own wording' },
        ]);
    });
    it("says nothing for a deleted principle no project touches", () => {
        expect(removedPrincipleNotes(G, [], [P("opal")])).toEqual([]);
    });
});

describe("staleRowText", () => {
    it("words a missing-disabled row without its id", () => {
        const [row] = principleRows(G, { disabled: ["gone-123"] }, [
            { principleid: "gone-123", code: DIAGNOSTIC_MISSING_DISABLED } as PrincipleDiagnostic,
        ]).filter((r) => r.kind === "stale");
        const text = staleRowText(row);
        expect(text).toBe("This project disabled a principle that was removed from the global set.");
        expect(text).not.toContain("gone-123");
    });
    it("quotes a missing replacement's own text", () => {
        const [row] = principleRows(G, { replacements: { "gone-9": "My wording" } }, [
            { principleid: "gone-9", code: DIAGNOSTIC_MISSING_REPLACEMENT } as PrincipleDiagnostic,
        ]).filter((r) => r.kind === "stale");
        expect(staleRowText(row)).toBe('This project reworded a principle that was removed: "My wording"');
    });
});

describe("saveScopes", () => {
    it("runs global then project", async () => {
        const order: string[] = [];
        const result = await saveScopes({
            global: async () => void order.push("global"),
            project: async () => void order.push("project"),
        });
        expect(order).toEqual(["global", "project"]);
        expect(result).toEqual({ saved: ["global", "project"] });
    });
    it("reports the landed global and the project's error without the Error prefix", async () => {
        const result = await saveScopes({
            global: async () => {},
            project: async () => {
                throw new Error("validating principle patch: addition has blank text");
            },
        });
        expect(result).toEqual({
            saved: ["global"],
            error: { scope: "project", message: "validating principle patch: addition has blank text" },
        });
    });
    it("never calls project after a global failure", async () => {
        let projectCalled = false;
        const result = await saveScopes({
            global: async () => {
                throw "Error: refused";
            },
            project: async () => {
                projectCalled = true;
            },
        });
        expect(projectCalled).toBe(false);
        expect(result).toEqual({ saved: [], error: { scope: "global", message: "refused" } });
    });
    it("writes only the scopes it is given", async () => {
        expect(await saveScopes({ project: async () => {} })).toEqual({ saved: ["project"] });
    });
});

describe("lightReviewerRow", () => {
    const ROUTE: RoutePin = { runtime: "claude", model: "haiku" };
    const OTHER: RoutePin = { runtime: "pi", model: "gpt" };

    it("names the Sonnet default when nothing is set, globally or with no global route", () => {
        expect(lightReviewerRow({}, {} as JarvisProfile, false)).toEqual({
            value: null,
            inheritedLabel: "Sonnet (default)",
        });
        expect(lightReviewerRow({}, {} as JarvisProfile, true)).toEqual({
            value: null,
            inheritedLabel: "Sonnet (default)",
        });
    });

    it("names the global route a project inherits, and shows a project's own", () => {
        const base = { lightreviewerroute: ROUTE } as JarvisProfile;
        expect(lightReviewerRow({}, base, true)).toEqual({ value: null, inheritedLabel: "Same as global" });
        expect(lightReviewerRow({ lightreviewerroute: OTHER }, base, true).value).toEqual(OTHER);
        expect(lightReviewerRow({ lightreviewerroute: ROUTE }, {} as JarvisProfile, false).value).toEqual(ROUTE);
    });

    it("counts as a project's own row", () => {
        expect(profileOverrideIsEmpty({ lightreviewerroute: ROUTE })).toBe(false);
        expect(overrideSummary({ lightreviewerroute: ROUTE })).toBe("1 set for this project");
        expect(resetRow({ lightreviewerroute: ROUTE }, "lightreviewerroute")).toEqual({});
    });
});
