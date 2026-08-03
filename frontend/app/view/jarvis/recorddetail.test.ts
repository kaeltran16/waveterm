// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const getDossier = vi.fn();
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { GetDossierCommand: (...a: unknown[]) => getDossier(...a) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { recordDetailAtom, reloadRecordDetail } from "./jarvissubjectstore";

const detail = (id: string, status: string): DossierDetail =>
    ({ id, status, objective: "o", decisions: [] }) as unknown as DossierDetail;

describe("record detail cache", () => {
    beforeEach(() => {
        globalStore.set(recordDetailAtom, {});
        getDossier.mockReset();
    });

    it("keys the loaded detail by dossier id", async () => {
        getDossier.mockResolvedValue(detail("task-a", "active"));
        await reloadRecordDetail("task-a");
        expect(globalStore.get(recordDetailAtom)["task-a"].status).toBe("active");
    });

    it("replaces a cached detail rather than keeping the stale copy", async () => {
        getDossier.mockResolvedValue(detail("task-a", "active"));
        await reloadRecordDetail("task-a");
        getDossier.mockResolvedValue(detail("task-a", "completed"));
        await reloadRecordDetail("task-a");
        expect(globalStore.get(recordDetailAtom)["task-a"].status).toBe("completed");
    });

    it("leaves other records untouched", async () => {
        getDossier.mockResolvedValue(detail("task-a", "active"));
        await reloadRecordDetail("task-a");
        getDossier.mockResolvedValue(detail("task-b", "paused"));
        await reloadRecordDetail("task-b");
        expect(Object.keys(globalStore.get(recordDetailAtom)).sort()).toEqual(["task-a", "task-b"]);
    });
});
