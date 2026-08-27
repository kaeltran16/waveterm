// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { orchestratorPickerState, workerPickerFace } from "./orchestratorpicker";

describe("orchestratorPickerState — A1 tight row", () => {
    it("shows tight row with both pickers when orchestrator and not ask", () => {
        const s = orchestratorPickerState({ shape: "orchestrator", mode: "run", pending: false, hasWorkerCallback: true });
        expect(s.showTightRow).toBe(true);
        expect(s.showWorkerPicker).toBe(true);
    });

    it("hides tight row for pipeline", () => {
        const s = orchestratorPickerState({ shape: "pipeline", mode: "run", pending: false, hasWorkerCallback: true });
        expect(s.showTightRow).toBe(false);
    });

    it("hides tight row for ask mode", () => {
        const s = orchestratorPickerState({ shape: "orchestrator", mode: "ask", pending: false, hasWorkerCallback: true });
        expect(s.showTightRow).toBe(false);
    });

    it("hides tight row when pending", () => {
        const s = orchestratorPickerState({ shape: "orchestrator", mode: "run", pending: true, hasWorkerCallback: true });
        expect(s.showTightRow).toBe(false);
    });
});

describe("workerPickerFace — Same as lead", () => {
    it("shows Same as lead when workerRoute is null", () => {
        expect(workerPickerFace(null)).toBe("Same as lead");
    });

    it("shows model when workerRoute is set", () => {
        expect(workerPickerFace({ runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" })).toBe("opencode/deepseek-v4-pro");
    });

    it("shows tier when model missing", () => {
        expect(workerPickerFace({ runtime: "pi", tier: "capable" })).toBe("capable");
    });
});
