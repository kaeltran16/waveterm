import { describe, expect, it, vi } from "vitest";

const getTranscript = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { GetAgentTranscriptCommand: (...a: any[]) => getTranscript(...a) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { ensureSessionStart } from "./agentsessionstore";

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const headLine = (iso: string) => ({ lines: [JSON.stringify({ timestamp: iso })] });

describe("ensureSessionStart", () => {
    it("returns null without an RPC when no transcript path", async () => {
        expect(await ensureSessionStart(undefined)).toBeNull();
        expect(getTranscript).not.toHaveBeenCalled();
    });

    it("resolves the head timestamp as unix seconds and caches it (one RPC)", async () => {
        getTranscript.mockResolvedValue(headLine("2026-07-08T00:00:00.000Z"));
        expect(await ensureSessionStart("/cache.jsonl")).toBe(sec("2026-07-08T00:00:00.000Z"));
        expect(await ensureSessionStart("/cache.jsonl")).toBe(sec("2026-07-08T00:00:00.000Z"));
        expect(getTranscript).toHaveBeenCalledTimes(1);
    });

    it("does not cache a null result — a later read retries", async () => {
        getTranscript.mockReset();
        getTranscript.mockRejectedValueOnce(new Error("not yet"));
        expect(await ensureSessionStart("/retry.jsonl")).toBeNull();
        getTranscript.mockResolvedValueOnce(headLine("2026-07-08T00:00:05.000Z"));
        expect(await ensureSessionStart("/retry.jsonl")).toBe(sec("2026-07-08T00:00:05.000Z"));
        expect(getTranscript).toHaveBeenCalledTimes(2);
    });
});
