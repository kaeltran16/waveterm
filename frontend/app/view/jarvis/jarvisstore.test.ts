import { beforeEach, describe, expect, it } from "vitest";
import type { JarvisConversation, JarvisUserTurn } from "./jarviscontract";
import { conversationsByIdAtom, pruneEmptyConversation, setConversation, summaryToRailConversation } from "./jarvisstore";
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
