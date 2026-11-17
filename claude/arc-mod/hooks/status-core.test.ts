import { describe, expect, it } from "vitest";
import { idleArgs } from "./status-core";

const IDLE = ["agentstatus", "--state", "idle", "--agent", "claude"];

describe("idleArgs", () => {
    it("leaves an answered turn to the Stop settings hook", () => {
        expect(idleArgs({ reason: "answer" })).toBeNull();
    });

    it("reports idle for an answered turn that put a question in claude's dialog: a dismissal runs no Stop", () => {
        expect(idleArgs({ reason: "answer" }, true)).toEqual(IDLE);
        expect(idleArgs({ reason: "answer", agentId: "a1" }, true)).toBeNull();
    });

    it("reports idle for an interrupted turn", () => {
        expect(idleArgs({ reason: "aborted" })).toEqual(IDLE);
    });

    it("reports idle for a turn an API error or a refusal ended", () => {
        for (const reason of ["error", "refusal"]) {
            expect(idleArgs({ reason })).toEqual(IDLE);
        }
    });

    it("ignores a subagent's turn: the session is still working", () => {
        expect(idleArgs({ reason: "aborted", agentId: "a1" })).toBeNull();
    });
});
