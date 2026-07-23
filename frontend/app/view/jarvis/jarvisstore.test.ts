import { describe, expect, it } from "vitest";
import { summaryToRailConversation } from "./jarvisstore";

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
