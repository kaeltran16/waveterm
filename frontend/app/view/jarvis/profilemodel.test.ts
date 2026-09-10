import { describe, expect, it } from "vitest";
import {
    DIAGNOSTIC_MISSING_DISABLED,
    DIAGNOSTIC_MISSING_REPLACEMENT,
    isDirty,
    principleRows,
    profileOverrideIsEmpty,
    reduceGlobalPrinciples,
    reducePrinciplePatch,
    resetActionState,
    sectionSource,
} from "./profilemodel";

const G: Principle[] = [
    { id: "a", text: "Alpha" },
    { id: "b", text: "Bravo" },
    { id: "c", text: "Charlie" },
];

describe("sectionSource", () => {
    it("is global for null/undefined and empty override", () => {
        expect(sectionSource(null)).toEqual({ playbook: "global", principles: "global", route: "global" });
        expect(sectionSource({})).toEqual({ playbook: "global", principles: "global", route: "global" });
    });
    it("is project for the section that is present", () => {
        expect(sectionSource({ principles: {} })).toEqual({ playbook: "global", principles: "project", route: "global" });
        expect(sectionSource({ playbook: [] })).toEqual({ playbook: "project", principles: "global", route: "global" });
    });
});

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
    it("preserves unrelated fields and order", () => {
        const start: PrinciplePatch = { additions: [{ id: "p1", text: "one" }], disabled: ["a"] };
        const after = reducePrinciplePatch(start, { type: "override", id: "b", text: "B2" });
        expect(after).toEqual({ additions: [{ id: "p1", text: "one" }], replacements: { b: "B2" }, disabled: ["a"] });
        expect(start.additions).toBe(start.additions); // sanity: start not mutated below
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
        expect(sectionSource({ route: { runtime: "pi", tier: "capable" } }).route).toBe("project");
        expect(isDirty({}, { route: { runtime: "pi", tier: "capable" } })).toBe(true);
        expect(isDirty({ route: undefined }, { route: undefined })).toBe(false);
    });
    it("is true when the patch differs meaningfully", () => {
        expect(isDirty({}, { principles: { disabled: ["a"] } })).toBe(true);
        expect(isDirty({ principles: { replacements: { a: "x" } } }, { principles: { replacements: { a: "y" } } })).toBe(
            true
        );
        expect(isDirty({ playbook: [] }, {})).toBe(true);
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
        ["machine", { machine: "engine" }, false],
        ["parallelism", { parallelism: 3 }, false],
        ["worker route", { workerroute: { runtime: "pi", tier: "capable" } }, false],
        ["default plan gate", { defaultplangate: false }, false],
        ["lead route", { route: { runtime: "pi", tier: "capable" } }, false],
        ["default mode", { defaultmode: "orchestrator" }, false],
        ["playbook", { playbook: [] }, false],
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
