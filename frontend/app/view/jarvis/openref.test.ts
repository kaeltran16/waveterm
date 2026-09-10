import { beforeEach, describe, expect, it, vi } from "vitest";

const getDossier = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { GetDossierCommand: (...a: unknown[]) => getDossier(...a) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import type { AgentsViewModel, SurfaceKey } from "../agents/agents";
import { vaultRecordIdAtom, vaultRecordPaneAtom, vaultTabAtom } from "../agents/vaultstore";
import { briefPeekRecordAtom } from "./jarvisstore";
import { recordDetailAtom } from "./jarvissubjectstore";
import { openRecordInVault, orefNavPlan } from "./openref";

describe("orefNavPlan", () => {
    it("routes channel/run/task/agent to their kinds", () => {
        expect(orefNavPlan("channel:abc")).toEqual({ kind: "channel", oid: "abc" });
        // a record became routable when it became a subject on the merged Stage
        expect(orefNavPlan("task:TASK-418")).toEqual({ kind: "task", oid: "TASK-418" });
        expect(orefNavPlan("run:11111111-1111-1111-1111-111111111111")).toEqual({
            kind: "run",
            oid: "11111111-1111-1111-1111-111111111111",
        });
        expect(orefNavPlan("agent:a1")).toEqual({ kind: "agent", oid: "a1" });
        // an effort address opens the briefing with that effort expanded
        expect(orefNavPlan("effort:eff-1")).toEqual({ kind: "effort", oid: "eff-1" });
    });
    it("marks types with no clean focus path as unsupported (no throw)", () => {
        for (const ot of ["memory", "radar", "decision", "commit", "session"]) {
            expect(orefNavPlan(`${ot}:x`)).toEqual({ kind: "unsupported", otype: ot });
        }
    });
    // a scan report became routable when radar triage entered the attention queue: the row names no
    // channel, so the oref is its only address. Note "radar" above stays unsupported -- that is a
    // different otype, and only "radarreport" is a real waveobj type.
    it("routes a scan report to the radar surface", () => {
        expect(orefNavPlan("radarreport:r-1")).toEqual({ kind: "radarreport", oid: "r-1" });
        expect(orefNavPlan("radarreport:").kind).toBe("unsupported");
    });

    it("is total on malformed input (never throws)", () => {
        expect(orefNavPlan("").kind).toBe("unsupported");
        expect(orefNavPlan("nope").kind).toBe("unsupported");
        expect(orefNavPlan("run:").kind).toBe("unsupported");
        expect(orefNavPlan(":x").kind).toBe("unsupported");
    });
});

describe("volunteered-knowledge routes", () => {
    it("classifies a memory note address", () => {
        expect(orefNavPlan("memnote:mem-abc123")).toEqual({ kind: "memnote", oid: "mem-abc123" });
    });

    it("still classifies the existing routes", () => {
        expect(orefNavPlan("task:task-a").kind).toBe("task");
        expect(orefNavPlan("run:run-9").kind).toBe("run");
        expect(orefNavPlan("channel:c1").kind).toBe("channel");
    });

    // a decision stays unroutable on purpose: it is rendered inside its parent record's thread, so the
    // backend addresses that record and passes the decision id as an anchor instead.
    it("leaves a bare decision address unsupported", () => {
        expect(orefNavPlan("decision:dec-abc123").kind).toBe("unsupported");
    });

    it("treats a malformed address as unsupported rather than throwing", () => {
        expect(orefNavPlan("memnote:").kind).toBe("unsupported");
        expect(orefNavPlan("").kind).toBe("unsupported");
        expect(orefNavPlan("decision").kind).toBe("unsupported");
    });
});

describe("openRecordInVault", () => {
    const model = { surfaceAtom: atom<SurfaceKey>("jarvis") } as unknown as AgentsViewModel;

    beforeEach(() => {
        getDossier.mockReset();
        getDossier.mockResolvedValue({ id: "task-a", status: "active", decisions: [] });
        globalStore.set(recordDetailAtom, {});
        globalStore.set(briefPeekRecordAtom, null);
        globalStore.set(vaultRecordIdAtom, null);
        globalStore.set(vaultRecordPaneAtom, "list");
        globalStore.set(vaultTabAtom, "memory");
        globalStore.set(model.surfaceAtom, "jarvis");
    });

    it("opens a record in Vault without leaving the Brief peek behind", () => {
        globalStore.set(briefPeekRecordAtom, "task-a");
        openRecordInVault(model, "task-a");
        expect(globalStore.get(vaultRecordIdAtom)).toBe("task-a");
        expect(globalStore.get(vaultTabAtom)).toBe("records");
        expect(globalStore.get(briefPeekRecordAtom)).toBeNull();
        expect(globalStore.get(model.surfaceAtom)).toBe("vault");
    });

    // a narrow window shows one pane, so the record the user asked for must be the pane that is showing
    it("lands on the detail pane of the narrow split ledger", () => {
        openRecordInVault(model, "task-a");
        expect(globalStore.get(vaultRecordPaneAtom)).toBe("detail");
    });

    it("warms the record it is about to show", async () => {
        openRecordInVault(model, "task-a");
        await vi.waitFor(() => expect(getDossier).toHaveBeenCalled());
        expect(globalStore.get(recordDetailAtom)["task-a"]).toBeDefined();
    });
});
