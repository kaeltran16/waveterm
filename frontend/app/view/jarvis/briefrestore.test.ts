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

    // B5 gave the channel somewhere to land, so a stored channel is now decided like every other kind:
    // it waits on the channel list the way a dossier waits on the dossier list.
    it("sends a stored channel to its own sheet", () => {
        expect(briefRestorePlan({ kind: "channel", id: "c1" }, LOADED)).toEqual({ action: "channel", id: "c1" });
    });

    it("waits on the channel list before deciding a stored channel", () => {
        expect(briefRestorePlan({ kind: "channel", id: "c1" }, { ...LOADED, channels: null })).toEqual({
            action: "wait",
        });
    });

    it("clears a stored channel the loaded list no longer holds", () => {
        expect(briefRestorePlan({ kind: "channel", id: "gone" }, LOADED)).toEqual({ action: "clear" });
    });
});
