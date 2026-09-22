// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { ResolveFocusScopeCommand: vi.fn(async () => ({ runorefs: [], channeloids: [], tabids: ["t1"] })) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/cockpit/notificationstore", () => ({ pushToast: vi.fn() }));

import { pushToast } from "@/app/cockpit/notificationstore";
import { RpcApi } from "@/app/store/wshclientapi";
import { atom } from "jotai";
import {
    activeFocusAtom,
    degradeFocus,
    enterFocus,
    enterFocusFor,
    exitFocus,
    focusScopeAtom,
    reresolveFocus,
} from "./focusstore";

beforeEach(() => {
    globalStore.set(activeFocusAtom, null);
    globalStore.set(focusScopeAtom, null);
    vi.clearAllMocks();
});

test("enterFocus sets the active focus immediately, before the resolve lands", () => {
    enterFocus({ ref: { kind: "agent", id: "t1" }, label: "jarvis-recall", project: "waveterm" });
    expect(globalStore.get(activeFocusAtom)?.label).toBe("jarvis-recall");
    expect(globalStore.get(focusScopeAtom)).toBeNull();
});

test("enterFocus resolves with the ref's own kind", async () => {
    enterFocus({ ref: { kind: "run", id: "r9" }, label: "fix vault restore", project: "waveterm" });
    await vi.waitFor(() => expect(globalStore.get(focusScopeAtom)).not.toBeNull());
    expect(RpcApi.ResolveFocusScopeCommand).toHaveBeenCalledWith(expect.anything(), { kind: "run", id: "r9" });
});

test("a resolve that lands after the user switched focus is discarded", async () => {
    (RpcApi.ResolveFocusScopeCommand as any).mockImplementationOnce(
        () => new Promise((r) => setTimeout(() => r({ runorefs: [], channeloids: [], tabids: ["stale"] }), 20))
    );
    enterFocus({ ref: { kind: "agent", id: "t1" }, label: "a", project: "p" });
    enterFocus({ ref: { kind: "agent", id: "t2" }, label: "b", project: "p" });
    await new Promise((r) => setTimeout(r, 40));
    expect(globalStore.get(focusScopeAtom)?.tabids).not.toContain("stale");
});

test("exitFocus clears focus", () => {
    enterFocus({ ref: { kind: "agent", id: "t1" }, label: "a", project: "p" });
    exitFocus();
    expect(globalStore.get(activeFocusAtom)).toBeNull();
    expect(globalStore.get(focusScopeAtom)).toBeNull();
});

test("entering a focus adopts its project; exiting leaves the project alone", () => {
    const m = { projectFilterAtom: atom("all") } as any;
    enterFocusFor(m, { ref: { kind: "agent", id: "t1" }, label: "a", project: "waveterm" });
    expect(globalStore.get(m.projectFilterAtom)).toBe("waveterm");
    exitFocus();
    expect(globalStore.get(m.projectFilterAtom)).toBe("waveterm");
});

test("a focus with no resolvable project leaves the filter untouched", () => {
    const m = { projectFilterAtom: atom("waveterm") } as any;
    enterFocusFor(m, { ref: { kind: "agent", id: "t1" }, label: "a", project: "" });
    expect(globalStore.get(m.projectFilterAtom)).toBe("waveterm");
});

test("a vanished focus target degrades to project-only and toasts once", () => {
    enterFocus({ ref: { kind: "agent", id: "gone" }, label: "gone", project: "waveterm" });
    degradeFocus("That agent session has ended");
    expect(globalStore.get(activeFocusAtom)).toBeNull();
    expect(pushToast).toHaveBeenCalledTimes(1);
});

test("degrading when there is no focus is a no-op and does not toast", () => {
    exitFocus();
    degradeFocus("whatever");
    expect(pushToast).not.toHaveBeenCalled();
});

test("switching to a focus-honoring surface re-resolves the bundle", async () => {
    enterFocus({ ref: { kind: "agent", id: "t1" }, label: "a", project: "p" });
    await vi.waitFor(() => expect(globalStore.get(focusScopeAtom)).not.toBeNull());
    vi.clearAllMocks();
    reresolveFocus("cockpit");
    expect(RpcApi.ResolveFocusScopeCommand).toHaveBeenCalledTimes(1);
});

test("switching to a surface that ignores focus resolves nothing", () => {
    enterFocus({ ref: { kind: "agent", id: "t1" }, label: "a", project: "p" });
    vi.clearAllMocks();
    reresolveFocus("usage");
    expect(RpcApi.ResolveFocusScopeCommand).not.toHaveBeenCalled();
});

test("re-resolving with no active focus does nothing", () => {
    exitFocus();
    reresolveFocus("cockpit");
    expect(RpcApi.ResolveFocusScopeCommand).not.toHaveBeenCalled();
});

test("a re-resolve that rejects degrades to project-only and toasts", async () => {
    enterFocus({ ref: { kind: "run", id: "gone" }, label: "gone", project: "waveterm" });
    await vi.waitFor(() => expect(globalStore.get(focusScopeAtom)).not.toBeNull());
    vi.clearAllMocks();
    (RpcApi.ResolveFocusScopeCommand as any).mockRejectedValueOnce(new Error("no such run"));
    reresolveFocus("cockpit");
    await vi.waitFor(() => expect(globalStore.get(activeFocusAtom)).toBeNull());
    expect(pushToast).toHaveBeenCalledTimes(1);
});

test("a rejected re-resolve for a focus the user already left is ignored", async () => {
    enterFocus({ ref: { kind: "run", id: "r1" }, label: "a", project: "p" });
    (RpcApi.ResolveFocusScopeCommand as any).mockRejectedValueOnce(new Error("boom"));
    reresolveFocus("cockpit");
    enterFocus({ ref: { kind: "run", id: "r2" }, label: "b", project: "p" });
    await new Promise((r) => setTimeout(r, 20));
    expect(globalStore.get(activeFocusAtom)?.ref.id).toBe("r2");
});
