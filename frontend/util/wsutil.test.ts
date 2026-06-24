import { describe, expect, it } from "vitest";
import { buildWsConnUrl } from "./wsutil";

describe("buildWsConnUrl", () => {
    it("includes stableid", () => {
        const url = buildWsConnUrl("ws://127.0.0.1:9001", "abc", null);
        expect(url).toBe("ws://127.0.0.1:9001/ws?stableid=abc");
    });
    it("appends authkey when provided", () => {
        const url = buildWsConnUrl("ws://127.0.0.1:9001", "abc", "key123");
        expect(url).toBe("ws://127.0.0.1:9001/ws?stableid=abc&authkey=key123");
    });
    it("omits authkey when null", () => {
        const url = buildWsConnUrl("ws://127.0.0.1:9001", "a b", null);
        expect(url).toContain("stableid=a%20b");
        expect(url).not.toContain("authkey");
    });
});
