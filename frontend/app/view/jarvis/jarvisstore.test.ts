import { beforeEach, describe, expect, it } from "vitest";
import type { JarvisConversation, JarvisUserTurn } from "./jarviscontract";
import {
    conversationsByIdAtom,
    pruneEmptyConversation,
    rehydrateSourceMap,
    setConversation,
    summaryToRailConversation,
} from "./jarvisstore";
import { globalStore } from "@/app/store/global";

const convo = (id: string, turns: JarvisConversation["turns"]): JarvisConversation => ({
    id,
    title: turns.length === 0 ? "New conversation" : "asked something",
    turns,
    scope: { mode: "all", chips: [], attached: [] },
});

const userTurn: JarvisUserTurn = { role: "user", text: "why worktrees?", attachments: [] };

describe("summaryToRailConversation", () => {
    it("maps a summary to a minimal history-rail conversation", () => {
        const conversation = summaryToRailConversation({
            id: "abc",
            title: "why worktrees",
            scopemode: "all",
            updatedts: 5,
        } as JarvisConversationSummary);
        expect(conversation.id).toBe("abc");
        expect(conversation.title).toBe("why worktrees");
        expect(conversation.turns).toEqual([]);
        expect(conversation.scope.mode).toBe("all");
    });
});

// Every "+ Thread" and every contextual entry creates its conversation up front, before a question exists.
// One that is never asked in is a false start carrying nothing but the title "New conversation", and it
// used to sit in the Threads group for the rest of the session.
describe("pruneEmptyConversation", () => {
    beforeEach(() => {
        globalStore.set(conversationsByIdAtom, {});
    });

    it("drops a thread that was never asked in", () => {
        setConversation(convo("v1", []));
        expect(pruneEmptyConversation("v1")).toBe(true);
        expect(globalStore.get(conversationsByIdAtom)["v1"]).toBeUndefined();
    });

    it("keeps a thread that has turns", () => {
        setConversation(convo("v1", [userTurn]));
        expect(pruneEmptyConversation("v1")).toBe(false);
        expect(globalStore.get(conversationsByIdAtom)["v1"]).toBeDefined();
    });

    // a dev fixture id, or a persisted thread the user clicked before its WOS load landed. Neither is in
    // the live map, and a persisted conversation always has turns (the backend record is created by the
    // first one), so "not loaded" must never be read as "empty".
    it("leaves an id it does not hold alone", () => {
        setConversation(convo("v1", [userTurn]));
        expect(pruneEmptyConversation("not-loaded-yet")).toBe(false);
        expect(Object.keys(globalStore.get(conversationsByIdAtom))).toEqual(["v1"]);
    });
});

describe("rehydrateSourceMap", () => {
    it("maps each attached oref to its persisted thread", () => {
        const map = rehydrateSourceMap(
            [
                { id: "t1", title: "a", scopemode: "attached", updatedts: 2, attachedorefs: ["run:r1"] },
                { id: "t2", title: "b", scopemode: "attached", updatedts: 1, attachedorefs: ["task:d1"] },
            ] as any,
            {}
        );
        expect(map).toEqual({ "run:r1": "t1", "task:d1": "t2" });
    });

    it("keeps a live in-session mapping over a persisted one", () => {
        // the session's own thread is the one holding unsent state; a restart-time rebuild must not steal
        // the oref out from under it.
        const map = rehydrateSourceMap(
            [{ id: "old", title: "a", scopemode: "attached", updatedts: 1, attachedorefs: ["run:r1"] }] as any,
            { "run:r1": "live" }
        );
        expect(map["run:r1"]).toBe("live");
    });

    it("ignores summaries with no attachments", () => {
        const map = rehydrateSourceMap([{ id: "t1", title: "a", scopemode: "all", updatedts: 1 }] as any, {});
        expect(map).toEqual({});
    });

    it("lets the newest thread win when two claim the same oref", () => {
        // GetJarvisConversations returns newest-first, so the first summary to claim an oref is the newest
        const map = rehydrateSourceMap(
            [
                { id: "new", title: "a", scopemode: "attached", updatedts: 2, attachedorefs: ["run:r1"] },
                { id: "old", title: "b", scopemode: "attached", updatedts: 1, attachedorefs: ["run:r1"] },
            ] as any,
            {}
        );
        expect(map["run:r1"]).toBe("new");
    });
});
