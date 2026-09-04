// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { orchestratorBehaviorFace, orchestratorPickerState, workerPickerFace } from "./orchestratorpicker";

const base = { shape: "orchestrator", mode: "run", pending: false, hasWorkerCallback: true } as const;

describe("orchestratorPickerState", () => {
    test("engine shows the lead to workers row", () => {
        expect(orchestratorPickerState({ ...base, orchestration: "engine" })).toEqual({
            showTightRow: true,
            showWorkerPicker: true,
        });
    });

    test("adaptive hides the worker picker: WorkerRoute only feeds engine-spawned children", () => {
        expect(orchestratorPickerState({ ...base, orchestration: "adaptive" })).toEqual({
            showTightRow: false,
            showWorkerPicker: false,
        });
    });

    test("non-orchestrator shapes are unaffected", () => {
        expect(orchestratorPickerState({ ...base, shape: "pipeline", orchestration: "engine" })).toEqual({
            showTightRow: false,
            showWorkerPicker: false,
        });
    });

    test("ask mode and pending drafts suppress it", () => {
        expect(orchestratorPickerState({ ...base, mode: "ask", orchestration: "engine" }).showTightRow).toBe(false);
        expect(orchestratorPickerState({ ...base, pending: true, orchestration: "engine" }).showTightRow).toBe(false);
        expect(
            orchestratorPickerState({ ...base, hasWorkerCallback: false, orchestration: "engine" }).showTightRow
        ).toBe(false);
    });
});

describe("orchestratorBehaviorFace", () => {
    test("engine names the machine and the workers", () => {
        expect(orchestratorBehaviorFace({ orchestration: "engine", leadFace: "opus", workerFace: "sonnet" })).toBe(
            "→ engine DAG · lead opus · workers sonnet"
        );
    });

    test("engine with inherited workers says so", () => {
        expect(orchestratorBehaviorFace({ orchestration: "engine", leadFace: "opus", workerFace: null })).toBe(
            "→ engine DAG · lead opus · workers same as lead"
        );
    });

    test("adaptive omits workers entirely", () => {
        expect(orchestratorBehaviorFace({ orchestration: "adaptive", leadFace: "opus", workerFace: "sonnet" })).toBe(
            "→ adaptive subagents · lead opus"
        );
    });
});

describe("workerPickerFace", () => {
    test("null inherits the lead", () => {
        expect(workerPickerFace(null)).toBe("Same as lead");
    });

    test("shows model when workerRoute is set", () => {
        expect(workerPickerFace({ runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" })).toBe(
            "opencode/deepseek-v4-pro"
        );
    });

    test("shows tier when model missing", () => {
        expect(workerPickerFace({ runtime: "pi", tier: "capable" })).toBe("capable");
    });
});
