import { describe, expect, it } from "vitest";
import { isDirty, sectionSource } from "./profilemodel";

describe("sectionSource", () => {
    it("is global for null/undefined and empty override", () => {
        expect(sectionSource(null)).toEqual({ playbook: "global", principles: "global" });
        expect(sectionSource({})).toEqual({ playbook: "global", principles: "global" });
    });
    it("is project for the section that is present", () => {
        expect(sectionSource({ principles: "x" })).toEqual({ playbook: "global", principles: "project" });
        expect(sectionSource({ playbook: [] })).toEqual({ playbook: "project", principles: "global" });
    });
    it("treats an empty-string principles override as present (project)", () => {
        expect(sectionSource({ principles: "" }).principles).toBe("project");
    });
});

describe("isDirty", () => {
    it("is false for equal overrides", () => {
        expect(isDirty({}, {})).toBe(false);
        expect(isDirty({ principles: "a" }, { principles: "a" })).toBe(false);
    });
    it("is true when any section differs", () => {
        expect(isDirty({}, { principles: "a" })).toBe(true);
        expect(isDirty({ principles: "a" }, { principles: "b" })).toBe(true);
        expect(isDirty({ playbook: [] }, {})).toBe(true);
    });
});
