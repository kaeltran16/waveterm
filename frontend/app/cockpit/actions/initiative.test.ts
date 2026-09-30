import type { AgentsViewModel } from "@/app/view/agents/agents";
import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import { paletteEffortsAtom } from "../palette-entities";
import { INITIATIVE_KIND } from "./initiative";

const eff = (over: Partial<EffortSummary> = {}): EffortSummary => ({
    oref: "effort:e1",
    title: "the big one",
    status: "active",
    done: 0,
    total: 0,
    updatedts: 0,
    ...over,
});
const action = (id: string) => INITIATIVE_KIND.actions.find((a) => a.id === id)!;
const model = {} as AgentsViewModel;

describe("initiative actions", () => {
    it("work on it applies unless the initiative is archived", () => {
        expect(action("effort:work").applies(eff())).toBe(true);
        expect(action("effort:work").applies(eff({ status: "paused" }))).toBe(true);
        expect(action("effort:work").applies(eff({ status: "archived" }))).toBe(false);
    });
    it("open applies to an archived initiative too", () => {
        expect(action("effort:open").applies(eff({ status: "archived" }))).toBe(true);
    });
});

describe("initiative entries", () => {
    it("keys each initiative by its oref, as the palette row", () => {
        const store = createStore();
        store.set(paletteEffortsAtom, [eff(), eff({ oref: "effort:e2", title: "" })]);
        const entries = INITIATIVE_KIND.entries(store.get, model);
        expect(entries.map((e) => e.key)).toEqual(["effort:effort:e1", "effort:effort:e2"]);
        expect(entries.map((e) => e.title)).toEqual(["the big one", "(untitled initiative)"]);
    });
    it("lists nothing before the list loads", () => {
        expect(INITIATIVE_KIND.entries(createStore().get, model)).toEqual([]);
    });
});
