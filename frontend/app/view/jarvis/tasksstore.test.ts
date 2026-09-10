import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { ListTaskDossiersCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { loadTaskList, taskListAtom, tasksErrorAtom } from "./tasksstore";

const first = { id: "a", objective: "Alpha", ticket: "A-1", status: "active", updated: 1 };
const second = { id: "b", objective: "Beta", ticket: "B-2", status: "paused", updated: 2 };

describe("task list loading", () => {
    beforeEach(() => {
        (RpcApi.ListTaskDossiersCommand as ReturnType<typeof vi.fn>).mockReset();
        globalStore.set(taskListAtom, null);
        globalStore.set(tasksErrorAtom, null);
    });

    it("retains the last good list on failure and clears the error after recovery", async () => {
        (RpcApi.ListTaskDossiersCommand as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ dossiers: [first] })
            .mockRejectedValueOnce(new Error("disk full"))
            .mockResolvedValueOnce({ dossiers: [second] });

        loadTaskList();
        await vi.waitFor(() => expect(globalStore.get(taskListAtom)).toEqual([first]));

        loadTaskList();
        await vi.waitFor(() => expect(globalStore.get(tasksErrorAtom)).toContain("disk full"));
        expect(globalStore.get(taskListAtom)).toEqual([first]);

        loadTaskList();
        await vi.waitFor(() => expect(globalStore.get(taskListAtom)).toEqual([second]));
        expect(globalStore.get(tasksErrorAtom)).toBeNull();
    });
});
