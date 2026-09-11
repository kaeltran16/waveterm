// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { paneOptions } from "./diffoptions";

describe("the diff pane's view switches", () => {
    it("asks for two editors only when split is on", () => {
        expect(paneOptions(true, false).renderSideBySide).toBe(true);
        expect(paneOptions(false, false).renderSideBySide).toBe(false);
    });

    // Monaco's own default is to ignore it, which renders a whitespace-only change as no change at
    // all while the counts in the same header read +2 -2. The pane has to say what git said.
    it("shows whitespace-only changes unless asked not to", () => {
        expect(paneOptions(false, false).ignoreTrimWhitespace).toBe(false);
        expect(paneOptions(false, true).ignoreTrimWhitespace).toBe(true);
    });

    it("never lets either side be typed into", () => {
        const o = paneOptions(true, true);
        expect(o.readOnly).toBe(true);
        expect(o.originalEditable).toBe(false);
    });
});
