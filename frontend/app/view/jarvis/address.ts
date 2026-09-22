// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Cockpit addresses: the strings a card, citation, palette row, graph node or pet act points at, and the one
// place a string becomes a destination. Go emits the canonical dialect. The legacy strings are read here only
// because persisted conversation turns and effort WorkRefs still carry them. Pure and total: malformed input
// is unsupported, never a throw.

export type OpenTarget =
    | { kind: "channel"; channelId: string; runId?: string }
    | { kind: "run"; runId: string }
    | { kind: "agent"; tabId: string }
    | { kind: "record"; dossierId: string; anchor?: string }
    | { kind: "effort"; effortId: string }
    | { kind: "radar"; reportId: string; findingId?: string };

export type Unsupported = { kind: "unsupported"; message: string };

// what a citation knows beyond its address: the source type, and the sub-object to land on within it
export type AddressHint = { sourceType?: string; anchor?: string };

export const CANNOT_OPEN = "This item can't be opened";
export const CANNOT_LOCATE_RECORD = "This citation can't locate its record";
// memnote:/memory:/vault:+memory addresses still arrive from persisted turns and effort WorkRefs. They
// name something real in the vault, but the surface that read notes is gone, so they parse to a reason
// rather than to the generic "can't be opened".
export const NO_MEMORY_SURFACE = "Memory notes no longer have a surface to open on";

export function parseAddress(address: string, hint?: AddressHint): OpenTarget | Unsupported {
    const parts = (address ?? "").split(":");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        return { kind: "unsupported", message: CANNOT_OPEN };
    }
    const [kind, id] = parts;
    const anchor = hint?.anchor || undefined;
    switch (kind) {
        case "run":
            return { kind: "run", runId: id };
        case "channel":
            return { kind: "channel", channelId: id };
        case "tab":
        case "agent":
            return { kind: "agent", tabId: id };
        case "task":
            return { kind: "record", dossierId: id, anchor };
        case "memnote":
        case "memory":
            return { kind: "unsupported", message: NO_MEMORY_SURFACE };
        case "effort":
            return { kind: "effort", effortId: id };
        case "radarreport":
            return { kind: "radar", reportId: id, findingId: anchor };
        case "vault":
            return parseVaultNode(id, hint?.sourceType);
        default:
            return { kind: "unsupported", message: CANNOT_OPEN };
    }
}

// vault:<id> named a node without its collection. The card's source type recovers the collection — except for
// a decision, whose record the card never recorded.
function parseVaultNode(id: string, sourceType: string | undefined): OpenTarget | Unsupported {
    if (sourceType == null || sourceType === "" || sourceType === "dossier") {
        return { kind: "record", dossierId: id };
    }
    if (sourceType === "memory") {
        return { kind: "unsupported", message: NO_MEMORY_SURFACE };
    }
    if (sourceType === "decision") {
        return { kind: "unsupported", message: CANNOT_LOCATE_RECORD };
    }
    return { kind: "unsupported", message: CANNOT_OPEN };
}
