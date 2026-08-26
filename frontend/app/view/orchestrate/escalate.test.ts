import { describe, expect, it } from "vitest";
import { canEscalate, escalatePayload } from "./escalate";

describe("escalate", () => {
    it("is available on failed/stalled tasks under the cap", () => {
        expect(canEscalate({ state: "failed", escalations: 0 })).toBe(true);
        expect(canEscalate({ state: "stalled" })).toBe(true);
    });

    it("refuses when the task is not failed/stalled", () => {
        expect(canEscalate({ state: "running", escalations: 0 })).toBe(false);
        expect(canEscalate({ state: "done", escalations: 0 })).toBe(false);
    });

    it("refuses at the one-hop cap", () => {
        expect(canEscalate({ state: "failed", escalations: 1 })).toBe(false);
    });

    it("builds the dag action payload with runtime and model", () => {
        const payload = escalatePayload("ch-1", "run-1", "t-3", { runtime: "claude", tier: "", model: "opus" });
        expect(payload).toMatchObject({ channelid: "ch-1", runid: "run-1", taskid: "t-3", action: "escalate", runtime: "claude", model: "opus" });
    });
});
