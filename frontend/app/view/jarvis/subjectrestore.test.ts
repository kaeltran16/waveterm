// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { restoreDecision } from "./subjectrestore";

const LOADED = { channels: ["c1"], dossiers: ["d1"] };
const UNLOADED = { channels: null, dossiers: null };

describe("restoreDecision", () => {
    it("does nothing when nothing was stored", () => {
        expect(restoreDecision(null, LOADED)).toEqual({ action: "clear" });
    });

    it("waits while the matching kind's list has not loaded", () => {
        expect(restoreDecision({ kind: "channel", id: "c1" }, UNLOADED)).toEqual({ action: "wait" });
        expect(restoreDecision({ kind: "dossier", id: "d1" }, { ...LOADED, dossiers: null })).toEqual({
            action: "wait",
        });
    });

    it("does not wait on a list it does not need", () => {
        // a stored channel must not be held up by a record list that has not landed
        expect(restoreDecision({ kind: "channel", id: "c1" }, { ...LOADED, dossiers: null })).toEqual({
            action: "select",
            subject: { kind: "channel", id: "c1" },
        });
    });

    it("selects the stored subject once its list holds the id", () => {
        expect(restoreDecision({ kind: "dossier", id: "d1" }, LOADED)).toEqual({
            action: "select",
            subject: { kind: "dossier", id: "d1" },
        });
    });

    it("clears a stored conversation left over from before Ask was retired", () => {
        const lists = { channels: ["c1"], dossiers: ["d1"] };
        expect(restoreDecision({ kind: "conversation", id: "x" } as any, lists)).toEqual({ action: "clear" });
    });

    it("clears a stored subject its loaded list no longer holds", () => {
        // a persisted id can name a channel, record or thread that has since been deleted
        expect(restoreDecision({ kind: "dossier", id: "gone" }, LOADED)).toEqual({ action: "clear" });
    });

    it("clears rather than waits when the list loaded empty", () => {
        expect(restoreDecision({ kind: "channel", id: "c1" }, { ...LOADED, channels: [] })).toEqual({
            action: "clear",
        });
    });
});
