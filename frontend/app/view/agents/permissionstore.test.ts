import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAgentPermissionsAtom, setupAgentPermissionSubscription } from "./permissionstore";

vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn() }));

function raise(oref: string, permid: string): AgentPermissionData {
    return { oref, permid, toolname: "Edit", toolinput: "{}", choices: ["Yes", "No"], ts: 1 };
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
