// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveComposerLabels } from "./briefcompose";

describe("resolveComposerLabels", () => {
    it("offers a standing rule when the session has a project", () => {
        expect(resolveComposerLabels("waveterm")).toEqual({
            scope: "scoped to this session",
            hint: "Message the lead of this session",
            action: "Send ⏎",
            alt: "⇧⏎ standing rule for waveterm",
        });
    });

    it("offers no standing rule without a project", () => {
        expect(resolveComposerLabels("  ").alt).toBeUndefined();
        expect(resolveComposerLabels().alt).toBeUndefined();
    });
});
