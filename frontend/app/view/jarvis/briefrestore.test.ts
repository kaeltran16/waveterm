// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { briefRestorePlan } from "./briefrestore";

const LOADED = { channels: ["c1"], dossiers: ["d1"], conversations: ["t1"] };

describe("briefRestorePlan", () => {
    it("does nothing when nothing was stored", () => {
        expect(briefRestorePlan(null, LOADED)).toEqual({ action: "clear" });
    });

    it("sends a stored dossier to the record peek", () => {
        expect(briefRestorePlan({ kind: "dossier", id: "d1" }, LOADED)).toEqual({ action: "record", id: "d1" });
    });

    it("sends a stored conversation to a hydrated thread", () => {
        expect(briefRestorePlan({ kind: "conversation", id: "t1" }, LOADED)).toEqual({
            action: "conversation",
            id: "t1",
        });
    });

    it("waits on the one list the stored kind needs", () => {
        expect(briefRestorePlan({ kind: "conversation", id: "t1" }, { ...LOADED, conversations: null })).toEqual({
            action: "wait",
        });
    });

    it("clears a stored dossier the loaded list no longer holds", () => {
        expect(briefRestorePlan({ kind: "dossier", id: "gone" }, LOADED)).toEqual({ action: "clear" });
    });

    // B5 owns the channel destination, so the Brief defers rather than clearing: clearing would discard a
    // restore target the user never asked to forget, and there is nothing here that can act on the answer.
    it("defers a stored channel without consulting a list it cannot use", () => {
        expect(briefRestorePlan({ kind: "channel", id: "ch1" }, LOADED)).toEqual({ action: "defer-channel" });
        expect(briefRestorePlan({ kind: "channel", id: "c1" }, { ...LOADED, channels: null })).toEqual({
            action: "defer-channel",
        });
    });
});
