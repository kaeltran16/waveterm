// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileJoin = vi.fn();
const fetchFn = vi.fn();

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { FileJoinCommand: (...a: any[]) => fileJoin(...a) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://127.0.0.1:9000" }));
vi.mock("@/util/fetchutil", () => ({ fetch: (...a: any[]) => fetchFn(...a) }));

import { releaseResolved, resolveRemoteFile, resolveSrcSet } from "./markdown-util";

const OPTS = { connName: "local", baseDir: "C:\\repo\\docs\\agents\\" };

let made: number;
let revoked: string[];

beforeEach(() => {
    made = 0;
    revoked = [];
    fileJoin
        .mockReset()
        .mockImplementation(async (_client: unknown, [, rel]: string[]) => ({ path: `C:/repo/docs/${rel}` }));
    fetchFn.mockReset().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(["png"]) });
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:img-${++made}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("resolveRemoteFile", () => {
    it("fetches the joined file through wavesrv and hands back a blob url", async () => {
        expect(await resolveRemoteFile("../images/a.png", OPTS)).toBe("blob:img-1");
        expect(fileJoin).toHaveBeenCalledWith({}, ["wsh://local/C:\\repo\\docs\\agents\\", "../images/a.png"]);
        const url = new URL(fetchFn.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe("http://127.0.0.1:9000/wave/stream-local-file");
        expect(url.searchParams.get("path")).toBe("C:/repo/docs/../images/a.png");
    });

    it("streams a file on a remote connection through that connection", async () => {
        await resolveRemoteFile("a.png", { connName: "ssh-box", baseDir: "/home/me" });
        const url = new URL(fetchFn.mock.calls[0][0]);
        expect(url.pathname).toBe("/wave/stream-file");
        expect(url.searchParams.get("path")).toBe("wsh://ssh-box/C:/repo/docs/a.png");
    });

    it("gives null for a file wavesrv cannot serve", async () => {
        fetchFn.mockResolvedValue({ ok: false, status: 404 });
        expect(await resolveRemoteFile("missing.png", OPTS)).toBeNull();
        expect(made).toBe(0);
    });

    it("leaves a web url alone", async () => {
        expect(await resolveRemoteFile("https://x.dev/a.png", OPTS)).toBe("https://x.dev/a.png");
        expect(fetchFn).not.toHaveBeenCalled();
    });
});

describe("releaseResolved", () => {
    it("revokes every blob url in the src and the srcset, and nothing else", async () => {
        const srcSet = await resolveSrcSet("a.png 1x, https://x.dev/b.png 2x", OPTS);
        releaseResolved("blob:img-9", srcSet);
        expect(revoked).toEqual(["blob:img-9", "blob:img-1"]);
    });

    it("does nothing for an image that never resolved", () => {
        releaseResolved(null, null);
        expect(revoked).toEqual([]);
    });
});
