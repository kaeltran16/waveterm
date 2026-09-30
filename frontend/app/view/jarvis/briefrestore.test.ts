// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { briefRestorePlan } from "./briefrestore";

const LOADED = { channels: ["c1"], dossiers: ["d1"] };

describe("briefRestorePlan", () => {
    it("does nothing when nothing was stored", () => {
        expect(briefRestorePlan(null, LOADED)).toEqual({ action: "clear" });
    });

    it("sends a stored dossier to the record peek", () => {
        expect(briefRestorePlan({ kind: "dossier", id: "d1" }, LOADED)).toEqual({ action: "record", id: "d1" });
    });

    it("clears a stored conversation left over from before Ask was retired", () => {
        expect(briefRestorePlan({ kind: "conversation", id: "t1" } as any, LOADED)).toEqual({ action: "clear" });
    });

    it("waits on the one list the stored kind needs", () => {
        expect(briefRestorePlan({ kind: "dossier", id: "d1" }, { ...LOADED, dossiers: null })).toEqual({
            action: "wait",
        });
    });

    it("clears a stored dossier the loaded list no longer holds", () => {
        expect(briefRestorePlan({ kind: "dossier", id: "gone" }, LOADED)).toEqual({ action: "clear" });
    });

    it("forgets a stored channel rather than reopening its sheet", () => {
        expect(briefRestorePlan({ kind: "channel", id: "c1" }, LOADED)).toEqual({ action: "clear" });
    });

    it("forgets a stored channel without waiting on the channel list", () => {
        expect(briefRestorePlan({ kind: "channel", id: "c1" }, { ...LOADED, channels: null })).toEqual({
            action: "clear",
        });
    });
});
