// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CANNOT_LOCATE_RECORD, CANNOT_OPEN, parseAddress, type AddressHint, type OpenTarget } from "./address";

describe("parseAddress", () => {
    it.each<[string, AddressHint | undefined, OpenTarget]>([
        ["run:r-1", undefined, { kind: "run", runId: "r-1" }],
        ["channel:c-1", undefined, { kind: "channel", channelId: "c-1" }],
        ["tab:t-1", undefined, { kind: "agent", tabId: "t-1" }],
        // effort WorkRefs persist the older agent: spelling
        ["agent:t-1", undefined, { kind: "agent", tabId: "t-1" }],
        ["task:d-1", undefined, { kind: "record", dossierId: "d-1" }],
        [
            "task:d-1",
            { sourceType: "decision", anchor: "dec-1" },
            { kind: "record", dossierId: "d-1", anchor: "dec-1" },
        ],
        // an empty anchor is no anchor, not a highlight of nothing
        ["task:d-1", { anchor: "" }, { kind: "record", dossierId: "d-1" }],
        ["memnote:m-1", undefined, { kind: "memory-note", noteId: "m-1" }],
        // recall's pre-canonical memory citations, still in persisted conversation turns
        ["memory:m-1", undefined, { kind: "memory-note", noteId: "m-1" }],
        ["effort:e-1", undefined, { kind: "effort", effortId: "e-1" }],
        ["radarreport:rr-1", undefined, { kind: "radar", reportId: "rr-1" }],
        [
            "radarreport:rr-1",
            { sourceType: "radar", anchor: "f-1" },
            { kind: "radar", reportId: "rr-1", findingId: "f-1" },
        ],
    ])("reads %s with hint %j", (address, hint, want) => {
        expect(parseAddress(address, hint)).toEqual(want);
    });

    // a pre-canonical vault: citation named a node without its collection; the card's source type recovers it
    describe("the legacy vault: dialect", () => {
        it("opens a dossier, or a card with no source type, as a record", () => {
            expect(parseAddress("vault:d-1", { sourceType: "dossier" })).toEqual({
                kind: "record",
                dossierId: "d-1",
            });
            expect(parseAddress("vault:d-1")).toEqual({ kind: "record", dossierId: "d-1" });
        });

        it("opens a memory node as its note", () => {
            expect(parseAddress("vault:m-1", { sourceType: "memory" })).toEqual({ kind: "memory-note", noteId: "m-1" });
        });

        // the card never recorded which record the decision sits in, so there is nowhere honest to land
        it("refuses a decision it has no record for", () => {
            expect(parseAddress("vault:dec-1", { sourceType: "decision" })).toEqual({
                kind: "unsupported",
                message: CANNOT_LOCATE_RECORD,
            });
        });

        it("does not guess at any other source type", () => {
            expect(parseAddress("vault:x", { sourceType: "status" })).toEqual({
                kind: "unsupported",
                message: CANNOT_OPEN,
            });
        });
    });

    // radar: is the attachment namespace (resolveAttached), not an address
    it.each(["commit:abc", "session:s-1", "radar:f-1", "decision:dec-1"])("leaves %s unsupported", (address) => {
        expect(parseAddress(address)).toEqual({ kind: "unsupported", message: CANNOT_OPEN });
    });

    it("is total on malformed input (never throws)", () => {
        const malformed = ["", "nope", "run:", ":x", "run:a:b", undefined, null] as unknown as string[];
        for (const address of malformed) {
            expect(parseAddress(address).kind).toBe("unsupported");
        }
    });
});
