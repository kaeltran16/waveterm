// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { edgeControls } from "./edgecontrols";

describe("edgeControls", () => {
    it("offers both actions on an inferred edge, with no dialog", () => {
        expect(edgeControls("informing")).toEqual({ confirm: true, detach: true, restore: false, confirmFirst: false });
    });

    it("hides Confirm on an already-confirmed edge and asks before detaching it", () => {
        expect(edgeControls("confirmed")).toEqual({ confirm: false, detach: true, restore: false, confirmFirst: true });
    });

    it("offers only Restore on a detached edge", () => {
        expect(edgeControls("detached")).toEqual({ confirm: false, detach: false, restore: true, confirmFirst: false });
    });

    it("treats an unrecognised state as the most cautious case", () => {
        expect(edgeControls("something-new")).toEqual({
            confirm: false,
            detach: true,
            restore: false,
            confirmFirst: true,
        });
    });
});
