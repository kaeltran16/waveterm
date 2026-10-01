import { describe, expect, it } from "vitest";
import { PROJECT_KIND, projectEntries, type ProjectThing } from "./project";

const ch = (oid: string, projectpath: string): Channel =>
    ({ otype: "channel", oid, version: 1, meta: {}, name: "chan", projectpath, createdts: 0 }) as Channel;
const action = (id: string) => PROJECT_KIND.actions.find((a) => a.id === id)!;
const thing: ProjectThing = { channel: ch("c1", "C:/src/arc"), name: "arc" };

describe("project actions", () => {
    it("every action applies, remove included: every listed project is a registered one", () => {
        for (const id of ["channel:switch", "channel:new-run", "channel:defaults", "channel:remove"]) {
            expect(action(id).applies(thing)).toBe(true);
        }
        expect(action("channel:remove").destructive).toBe(true);
    });
});

describe("project entries", () => {
    it("keys one entry per project row by its channel, skipping a row whose channel has not loaded", () => {
        const entries = projectEntries([
            { name: "arc", path: "C:/src/arc", channel: ch("c1", "C:/src/arc") },
            { name: "fresh", path: "C:/src/fresh" },
        ]);
        expect(entries.map((e) => e.key)).toEqual(["channel:c1"]);
        expect(entries.map((e) => e.title)).toEqual(["#arc"]);
    });
});
