import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { channelsAtom } from "@/app/view/agents/channelsstore";
import { sessionsArchiveAtom, type LiveSession } from "@/app/view/agents/sessionsarchivestore";
import { openBoardAsk } from "@/app/view/jarvis/openref";
import { atom, createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { SESSION_KIND, type SessionThing } from "./session";

// the action's target is what it hands the router
vi.mock("@/app/view/jarvis/openref", async (orig) => ({ ...(await orig<object>()), openBoardAsk: vi.fn() }));

const mk = (over: Partial<LiveSession> = {}): LiveSession => ({
    id: "s1",
    runtime: "claude",
    projectpath: "/p",
    projectname: "proj",
    branch: "main",
    task: "fix it",
    model: "claude",
    tokenstotal: 0,
    lastactivets: 0,
    resumecommand: "claude --resume s1",
    transcriptpath: "/t/s1.jsonl",
    status: "done",
    startedts: 0,
    durationms: 0,
    events: [],
    live: false,
    needsAttention: false,
    ...over,
});
const agent = { id: "tab-1", name: "fixer", state: "working", transcriptPath: "/t/s1.jsonl" } as AgentVM;
const action = (id: string) => SESSION_KIND.actions.find((a) => a.id === id)!;
const thing = (session: LiveSession, a?: AgentVM): SessionThing => ({ session, agent: a });

describe("session actions", () => {
    it("resume applies only to an ended session that can be resumed", () => {
        expect(action("session:resume").applies(thing(mk()))).toBe(true);
        expect(action("session:resume").applies(thing(mk({ live: true, liveId: "tab-1" }), agent))).toBe(false);
        expect(action("session:resume").applies(thing(mk({ resumecommand: "" })))).toBe(false);
    });
    it("stop applies only to a live session with a roster agent", () => {
        expect(action("session:stop").applies(thing(mk({ live: true, liveId: "tab-1" }), agent))).toBe(true);
        expect(action("session:stop").applies(thing(mk()))).toBe(false);
        expect(action("session:stop").applies(thing(mk({ live: true, liveId: "tab-gone" })))).toBe(false);
        expect(action("session:stop").destructive).toBe(true);
    });
    it("open in Sessions always applies", () => {
        expect(action("session:open").applies(thing(mk({ resumecommand: "" })))).toBe(true);
    });
});

describe("session entries", () => {
    it("lists resumable sessions keyed as the palette row, a live one resolved to its roster agent", () => {
        const store = createStore();
        store.set(sessionsArchiveAtom, [
            mk(),
            mk({ id: "s2", runtime: "pi", task: "", transcriptpath: "/t/s2.jsonl" }),
            mk({ id: "s3", resumecommand: "" }),
        ]);
        const model = { agentsAtom: atom([agent]) } as unknown as AgentsViewModel;
        const entries = SESSION_KIND.entries(store.get, model);
        expect(entries.map((e) => e.key)).toEqual(["session:claude:s1", "session:pi:s2"]);
        expect(entries.map((e) => e.title)).toEqual(["fix it", "(untitled session)"]);
        expect(entries[0].thing.session.live).toBe(true);
        expect(entries[0].thing.agent).toBe(agent);
        expect(entries[1].thing.agent).toBeUndefined();
    });
    it("leaves out a session whose resume is blocked", () => {
        const store = createStore();
        store.set(sessionsArchiveAtom, [mk({ id: "s4", transcriptpath: "/t/s4.jsonl", resumeblocker: "gone" })]);
        const model = { agentsAtom: atom([]) } as unknown as AgentsViewModel;
        expect(SESSION_KIND.entries(store.get, model)).toEqual([]);
    });
    it("lists nothing before the archive loads", () => {
        const model = { agentsAtom: atom([]) } as unknown as AgentsViewModel;
        expect(SESSION_KIND.entries(createStore().get, model)).toEqual([]);
    });
});

describe("session Ask a board about this…", () => {
    const ask = action("session:ask-board");
    const target = (t: SessionThing) => {
        vi.mocked(openBoardAsk).mockClear();
        void ask.run(t, { model: {} as AgentsViewModel });
        const [, channelId, about] = vi.mocked(openBoardAsk).mock.calls[0] ?? [];
        return channelId == null ? null : { channelId, about };
    };
    it("asks about the session's transcript in the project at its path", () => {
        globalStore.set(channelsAtom, [
            { oid: "ch-p", otype: "channel", version: 1, name: "proj", projectpath: "/p", createdts: 0 },
        ] as Channel[]);
        try {
            expect(ask.label).toBe("Ask a board about this…");
            expect(target(thing(mk()))).toEqual({
                channelId: "ch-p",
                about: { kind: "session", ref: "claude:s1", path: "/t/s1.jsonl", runtime: "claude", title: "fix it" },
            });
            // no transcript: nothing for the drawer to read
            expect(ask.applies(thing(mk({ transcriptpath: "" })))).toBe(false);
        } finally {
            globalStore.set(channelsAtom, null);
        }
    });
});
