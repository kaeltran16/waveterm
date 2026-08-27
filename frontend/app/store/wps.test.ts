// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcApi } from "@/app/store/wshclientapi";
import { handleWaveEvent, setWpsRpcClient, waveEventSubscribeSingle, waveEventUnsubscribe } from "./wps";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { EventSubCommand: vi.fn(), EventUnsubCommand: vi.fn() },
}));

function deterministicCrypto() {
    let n = 0;
    return { randomUUID: () => "id-" + ++n };
}

describe("wps subscribe/unsubscribe", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setWpsRpcClient({} as any);
        vi.stubGlobal("crypto", deterministicCrypto() as any);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("still unsubscribes the other events when one batch id is unknown", () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        waveEventSubscribeSingle({ eventType: "e1" as any, handler: h1 }); // id-1
        waveEventSubscribeSingle({ eventType: "e2" as any, handler: h2 }); // id-2
        // unknown id first (would abort the loop under the old `return`); valid e2 sub second
        waveEventUnsubscribe({ id: "id-999", eventType: "e2" }, { id: "id-2", eventType: "e2" });
        // e2 emptied -> unsubscribed server-side even though an earlier batch entry was unknown
        expect((RpcApi.EventUnsubCommand as any)).toHaveBeenCalledWith(expect.anything(), "e2", expect.anything());
        // and the unsubscribed handler no longer receives events, while the untouched one still does
        handleWaveEvent({ event: "e2" } as any);
        expect(h2).not.toHaveBeenCalled();
        handleWaveEvent({ event: "e1" } as any);
        expect(h1).toHaveBeenCalledTimes(1);
    });
});
