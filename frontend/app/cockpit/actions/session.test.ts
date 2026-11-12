import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { channelsAtom } from "@/app/view/agents/channelsstore";
import { sessionsArchiveAtom, type LiveSession } from "@/app/view/agents/sessionsarchivestore";
import { atom, createStore } from "jotai";
import { describe, expect, it } from "vitest";
import { SESSION_KIND, type SessionThing } from "./session";

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

describe("session Draw on a board…", () => {
    const draw = action("session:draw-board");
    const target = (t: SessionThing) => (draw.input?.kind === "board" ? draw.input.target(t) : null);
    it("draws the session's transcript in the project at its path, never followed", () => {
        globalStore.set(channelsAtom, [
            { oid: "ch-p", otype: "channel", version: 1, name: "proj", projectpath: "/p", createdts: 0 },
        ] as Channel[]);
        try {
            expect(target(thing(mk()))).toEqual({
                channelId: "ch-p",
                source: { kind: "session", ref: "claude:s1", path: "/t/s1.jsonl", runtime: "claude", title: "fix it" },
                followable: false,
            });
            // no transcript: nothing for the scribe to read
            expect(draw.applies(thing(mk({ transcriptpath: "" })))).toBe(false);
        } finally {
            globalStore.set(channelsAtom, null);
        }
    });
});
