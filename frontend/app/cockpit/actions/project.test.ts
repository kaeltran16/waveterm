import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/view/agents/workflowscanstart", () => ({ startWorkflowScan: vi.fn() }));

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { startWorkflowScan } from "@/app/view/agents/workflowscanstart";
import { PROJECT_KIND, projectEntries, type ProjectThing } from "./project";

const ch = (oid: string, projectpath: string): Channel =>
    ({ otype: "channel", oid, version: 1, meta: {}, name: "chan", projectpath, createdts: 0 }) as Channel;
const action = (id: string) => PROJECT_KIND.actions.find((a) => a.id === id)!;
const thing: ProjectThing = { channel: ch("c1", "C:/src/arc"), name: "arc" };

describe("project actions", () => {
    it("every action applies, remove included: every listed project is a registered one", () => {
        for (const id of ["channel:switch", "channel:new-run", "channel:scan", "channel:defaults", "channel:remove"]) {
            expect(action(id).applies(thing)).toBe(true);
        }
        expect(action("channel:remove").destructive).toBe(true);
    });

    it("lists Scan workflow right after New run in it", () => {
        const ids = PROJECT_KIND.actions.map((a) => a.id);
        expect(ids[ids.indexOf("channel:new-run") + 1]).toBe("channel:scan");
        expect(action("channel:scan")).toMatchObject({ label: "Scan workflow", group: "steer" });
    });

    it("starts a scan in the project's channel, and a failed start rejects so the palette shows it", async () => {
        const model = {} as AgentsViewModel;
        vi.mocked(startWorkflowScan).mockResolvedValueOnce({} as Run);
        await action("channel:scan").run(thing, { model });
        expect(startWorkflowScan).toHaveBeenCalledWith(model, "c1");
        vi.mocked(startWorkflowScan).mockRejectedValueOnce(new Error("busy"));
        await expect(action("channel:scan").run(thing, { model })).rejects.toThrow("busy");
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
