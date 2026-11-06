// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { leadPaneShown } from "./leadpane";

describe("leadPaneShown", () => {
    it("renders no pane for a lead with no transcript lines, ask or not", () => {
        expect(leadPaneShown({ hasAsk: false, hasLines: false, userOpened: false })).toBe("none");
        expect(leadPaneShown({ hasAsk: true, hasLines: false, userOpened: true })).toBe("none");
    });

    it("collapses the pane while the card shows an ask, unless you opened it during this ask", () => {
        expect(leadPaneShown({ hasAsk: true, hasLines: true, userOpened: false })).toBe("collapsed");
        expect(leadPaneShown({ hasAsk: true, hasLines: true, userOpened: true })).toBe("full");
    });

    it("shows the pane in full with no ask", () => {
        expect(leadPaneShown({ hasAsk: false, hasLines: true, userOpened: false })).toBe("full");
    });
});
