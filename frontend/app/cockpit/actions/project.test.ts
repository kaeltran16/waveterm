import { describe, expect, it } from "vitest";
import { PROJECT_KIND, projectEntries, type ProjectThing } from "./project";

const ch = (oid: string, projectpath: string, name = "chan"): Channel =>
    ({ otype: "channel", oid, version: 1, meta: {}, name, projectpath, createdts: 0 }) as Channel;
const registry: Record<string, ProjectKeywords> = { arc: { path: "C:/src/arc" } as ProjectKeywords };
const action = (id: string) => PROJECT_KIND.actions.find((a) => a.id === id)!;
const thing = (registered: boolean): ProjectThing => ({
    channel: ch("c1", "C:/src/arc"),
    name: "arc",
    registered,
});

describe("project actions", () => {
    it("remove applies only to a project registered in projects.json, as the switcher's control", () => {
        expect(action("channel:remove").applies(thing(true))).toBe(true);
        expect(action("channel:remove").applies(thing(false))).toBe(false);
        expect(action("channel:remove").destructive).toBe(true);
    });
    it("switch, new run and run defaults always apply", () => {
        for (const id of ["channel:switch", "channel:new-run", "channel:defaults"]) {
            expect(action(id).applies(thing(false))).toBe(true);
        }
    });
});

describe("project entries", () => {
    it("keys one entry per project by channel oid, deduped as the palette row, named by the registry", () => {
        const entries = projectEntries(
            [ch("c1", "C:/src/arc"), ch("c2", "C:\\src\\arc\\"), ch("c3", "C:/src/other", "legacy")],
            registry
        );
        expect(entries.map((e) => e.key)).toEqual(["channel:c1", "channel:c3"]);
        expect(entries.map((e) => e.title)).toEqual(["#arc", "#legacy"]);
        expect(entries.map((e) => e.thing.registered)).toEqual([true, false]);
    });
});
