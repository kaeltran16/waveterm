import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { projectListAtom, type ProjectRow } from "@/app/view/agents/projectsstore";
import { openBoardAsk } from "@/app/view/jarvis/openref";
import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { paletteEffortsAtom } from "../palette-entities";
import { INITIATIVE_KIND } from "./initiative";

// the current project comes from the registered projects, which read config atoms tests never initialize
vi.mock("@/app/view/agents/projectsstore", async (orig) => {
    const { atom } = await import("jotai");
    return { ...(await orig<object>()), projectListAtom: atom<ProjectRow[]>([]) };
});

// the action's target is what it hands the router
vi.mock("@/app/view/jarvis/openref", async (orig) => ({ ...(await orig<object>()), openBoardAsk: vi.fn() }));

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

// one registered project with its channel: the palette's current project
function withCurrentProject(fn: () => void) {
    const ch = { oid: "ch1", otype: "channel", version: 1, name: "waveterm", createdts: 0 } as Channel;
    globalStore.set(projectListAtom as any, [{ name: "waveterm", path: "C:/work/waveterm", channel: ch }]);
    try {
        fn();
    } finally {
        globalStore.set(projectListAtom as any, []);
    }
}

describe("initiative Ask a board about this…", () => {
    const ask = action("effort:ask-board");
    const target = (t: any) => {
        vi.mocked(openBoardAsk).mockClear();
        void ask.run(t, { model });
        const [, channelId, about] = vi.mocked(openBoardAsk).mock.calls[0] ?? [];
        return channelId == null ? null : { channelId, about };
    };
    it("asks about the initiative by its oid in the current project", () => {
        withCurrentProject(() => {
            expect(ask.label).toBe("Ask a board about this…");
            expect(ask.applies(eff())).toBe(true);
            expect(target(eff())).toEqual({
                channelId: "ch1",
                about: { kind: "effort", ref: "e1", title: "the big one" },
            });
        });
    });
    it("does not apply with no current project", () => {
        expect(ask.applies(eff())).toBe(false);
    });
});
