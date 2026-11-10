import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentPermissionsAtom, mergeOpenPermissions, setupAgentPermissionSubscription } from "./permissionstore";

vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { AgentPermissionListCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

// the boot read of open requests, held until a test resolves it
let resolveOpenRead: (open: AgentPermissionData[]) => void;
vi.mocked(RpcApi.AgentPermissionListCommand).mockReturnValue(
    new Promise<AgentPermissionData[]>((resolve) => (resolveOpenRead = resolve))
);

function raise(oref: string, permid: string, ts = 1, toolinput = "{}"): AgentPermissionData {
    return { oref, permid, toolname: "Edit", toolinput, choices: ["Yes", "No"], ts };
}

function permids(oref: string): string[] {
    return globalStore.get(getAgentPermissionsAtom(oref)).map((p) => p.permid);
}

function send(data: Partial<AgentPermissionData>) {
    const sub = vi
        .mocked(waveEventSubscribeSingle)
        .mock.calls.map(([request]) => request)
        .find((request) => request.eventType === "agent:permission");
    expect(sub).toBeDefined();
    sub!.handler({ event: "agent:permission", data } as WaveEvent);
}

describe("agent permission events", () => {
    beforeAll(() => setupAgentPermissionSubscription());

    it("keeps raises in arrival order", () => {
        send(raise("block:order", "p1"));
        send(raise("block:order", "p2"));
        expect(globalStore.get(getAgentPermissionsAtom("block:order")).map((p) => p.permid)).toEqual(["p1", "p2"]);
    });

    it("a cleared event removes only the permid it names", () => {
        send(raise("block:clear", "p1"));
        send(raise("block:clear", "p2"));
        send({ oref: "block:clear", permid: "p2", cleared: true });
        expect(globalStore.get(getAgentPermissionsAtom("block:clear")).map((p) => p.permid)).toEqual(["p1"]);
    });

    it("a cleared event for an unknown permid changes nothing", () => {
        send(raise("block:unknown", "p1"));
        const before = globalStore.get(getAgentPermissionsAtom("block:unknown"));
        send({ oref: "block:unknown", permid: "nope", cleared: true });
        expect(globalStore.get(getAgentPermissionsAtom("block:unknown"))).toBe(before);
    });
});

describe("the boot read of open permission requests", () => {
    it("seeds each block's queue oldest first, keeps live copies and skips requests cleared mid-read", async () => {
        send(raise("block:seed", "live", 5, "live copy"));
        send(raise("block:seed", "gone", 2));
        send({ oref: "block:seed", permid: "gone", cleared: true });
        resolveOpenRead([
            raise("block:seed", "live", 5, "server copy"),
            raise("block:seed", "gone", 2),
            raise("block:seed", "older", 1),
            raise("block:other", "b1", 3),
        ]);
        await vi.waitFor(() => expect(permids("block:other")).toEqual(["b1"]));
        expect(permids("block:seed")).toEqual(["older", "live"]);
        expect(globalStore.get(getAgentPermissionsAtom("block:seed"))[1].toolinput).toBe("live copy");
    });
});

describe("mergeOpenPermissions", () => {
    it("returns the same list when nothing is missing", () => {
        const list = [raise("block:m", "p1")];
        expect(mergeOpenPermissions(list, [raise("block:m", "p1")])).toBe(list);
    });
});
