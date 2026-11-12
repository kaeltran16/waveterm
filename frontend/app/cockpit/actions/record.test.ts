import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { projectListAtom, type ProjectRow } from "@/app/view/agents/projectsstore";
import { openBoardAsk } from "@/app/view/jarvis/openref";
import { taskListAtom } from "@/app/view/jarvis/tasksstore";
import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { RECORD_KIND } from "./record";

// the current project comes from the registered projects, which read config atoms tests never initialize
vi.mock("@/app/view/agents/projectsstore", async (orig) => {
    const { atom } = await import("jotai");
    return { ...(await orig<object>()), projectListAtom: atom<ProjectRow[]>([]) };
});

// the action's target is what it hands the router
vi.mock("@/app/view/jarvis/openref", async (orig) => ({ ...(await orig<object>()), openBoardAsk: vi.fn() }));

const rec = (over: Partial<SpaceSummary> = {}): SpaceSummary => ({
    id: "d1",
    objective: "ship it",
    ticket: "",
    status: "active",
    updated: 0,
    ...over,
});
const action = (id: string) => RECORD_KIND.actions.find((a) => a.id === id)!;
const model = {} as AgentsViewModel;

describe("record actions", () => {
    it("change status offers the peek's legal transitions, never the current status", () => {
        const status = action("record:status");
        expect(status.applies(rec())).toBe(true);
        expect(status.input?.kind).toBe("pick");
        const options = status.input?.kind === "pick" ? status.input.options(rec({ status: "completed" })) : [];
        // allowedTransitions forbids paused-from-completed
        expect(options.map((o) => o.value)).toEqual(["active", "archived"]);
    });
    it("change status does not apply to a status with no legal transition", () => {
        expect(action("record:status").applies(rec({ status: "bogus" }))).toBe(false);
    });
    it("open always applies", () => {
        expect(action("record:open").applies(rec({ status: "archived" }))).toBe(true);
    });
});

describe("record entries", () => {
    it("keys every record, archived included, as the palette row", () => {
        const store = createStore();
        store.set(taskListAtom, [rec(), rec({ id: "d2", objective: "", status: "archived" })]);
        const entries = RECORD_KIND.entries(store.get, model);
        expect(entries.map((e) => e.key)).toEqual(["record:d1", "record:d2"]);
        expect(entries.map((e) => e.title)).toEqual(["ship it", "(untitled record)"]);
    });
    it("lists nothing before the list loads", () => {
        expect(RECORD_KIND.entries(createStore().get, model)).toEqual([]);
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

describe("record Ask a board about this…", () => {
    const ask = action("record:ask-board");
    const target = (t: any) => {
        vi.mocked(openBoardAsk).mockClear();
        void ask.run(t, { model });
        const [, channelId, about] = vi.mocked(openBoardAsk).mock.calls[0] ?? [];
        return channelId == null ? null : { channelId, about };
    };
    it("asks about the record by its dossier id in the current project", () => {
        withCurrentProject(() => {
            expect(ask.label).toBe("Ask a board about this…");
            expect(target(rec())).toEqual({
                channelId: "ch1",
                about: { kind: "record", ref: "d1", title: "ship it" },
            });
        });
    });
    it("does not apply with no current project", () => {
        expect(ask.applies(rec())).toBe(false);
    });
});
