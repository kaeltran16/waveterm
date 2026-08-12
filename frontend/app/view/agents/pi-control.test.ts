import { describe, expect, it } from "vitest";
import { steerData } from "./pi-control";

describe("pi-control", () => {
    it("builds a steer command for a pi session", () => {
        expect(steerData("sess-1", "look at this")).toEqual({
            sessionid: "sess-1",
            command: "steer",
            content: "look at this",
            name: "",
            path: "",
        });
    });

    it("trims empty content to an empty string", () => {
        expect(steerData("sess-1", "   ").content).toBe("");
    });
});
