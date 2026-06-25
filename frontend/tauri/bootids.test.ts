import { afterEach, describe, expect, it, vi } from "vitest";

const callBackendServiceMock = vi.fn();
vi.mock("@/app/store/wos", () => ({
    callBackendService: (...a: any[]) => callBackendServiceMock(...a),
}));

import { resolveBootIds } from "./bootids";

afterEach(() => {
    callBackendServiceMock.mockReset();
});

describe("resolveBootIds", () => {
    it("uses the existing window when the client already has one", async () => {
        callBackendServiceMock.mockImplementation((service: string, method: string) => {
            if (service === "client" && method === "GetClientData")
                return Promise.resolve({ oid: "c-1", windowids: ["w-1"] });
            if (service === "window" && method === "GetWindow")
                return Promise.resolve({ oid: "w-1", workspaceid: "ws-1" });
            if (service === "workspace" && method === "GetWorkspace")
                return Promise.resolve({ oid: "ws-1", tabids: ["t-1"], activetabid: "t-1" });
            throw new Error(`unexpected ${service}.${method}`);
        });
        const ids = await resolveBootIds();
        expect(ids).toEqual({ clientId: "c-1", windowId: "w-1", workspaceId: "ws-1", tabId: "t-1" });
        // every backend call passes noUIContext=true (4th arg) — uiContext isn't populated this early
        expect(callBackendServiceMock).toHaveBeenCalledWith("client", "GetClientData", [], true);
        expect(callBackendServiceMock).toHaveBeenCalledWith("window", "GetWindow", ["w-1"], true);
        expect(callBackendServiceMock).not.toHaveBeenCalledWith("window", "CreateWindow", expect.anything(), true);
    });

    it("creates a window when the client has none", async () => {
        callBackendServiceMock.mockImplementation((service: string, method: string) => {
            if (service === "client" && method === "GetClientData")
                return Promise.resolve({ oid: "c-1", windowids: [] });
            if (service === "window" && method === "CreateWindow")
                return Promise.resolve({ oid: "w-new", workspaceid: "ws-new" });
            if (service === "workspace" && method === "GetWorkspace")
                return Promise.resolve({ oid: "ws-new", tabids: ["t-new"], activetabid: "t-new" });
            throw new Error(`unexpected ${service}.${method}`);
        });
        const ids = await resolveBootIds();
        expect(ids).toEqual({ clientId: "c-1", windowId: "w-new", workspaceId: "ws-new", tabId: "t-new" });
        expect(callBackendServiceMock).toHaveBeenCalledWith("window", "CreateWindow", [null, ""], true);
    });

    it("falls back to the first tab when no active tab is set", async () => {
        callBackendServiceMock.mockImplementation((service: string, method: string) => {
            if (service === "client" && method === "GetClientData")
                return Promise.resolve({ oid: "c-1", windowids: ["w-1"] });
            if (service === "window" && method === "GetWindow")
                return Promise.resolve({ oid: "w-1", workspaceid: "ws-1" });
            if (service === "workspace" && method === "GetWorkspace")
                return Promise.resolve({ oid: "ws-1", tabids: ["t-a"], activetabid: "" });
            throw new Error(`unexpected ${service}.${method}`);
        });
        const ids = await resolveBootIds();
        expect(ids.tabId).toBe("t-a");
    });
});
