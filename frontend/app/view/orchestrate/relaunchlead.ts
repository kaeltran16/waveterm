// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Whether a timeline row offers "Relaunch lead". Only a lead-wake-failed row does, and only until a lead
// has been started since: a lead-launched row at or after it means the lead is back, so the button would
// point at a lead that is not dead.

export type RelaunchLeadAction = { disabled: boolean };

export function relaunchLeadAction(event: RunEvent, events: RunEvent[], inFlight: boolean): RelaunchLeadAction | null {
    if (event.kind !== "lead-wake-failed") {
        return null;
    }
    if (events.some((e) => e.kind === "lead-launched" && e.ts >= event.ts)) {
        return null;
    }
    return { disabled: inFlight };
}
