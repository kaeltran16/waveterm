import { describe, expect, it } from "vitest";
import { closeSessionCopy } from "./closesession";

const base = { isLead: false, runFinished: false, runTabCount: 0, runTitle: "Resource linking", name: "lead one" };

describe("closeSessionCopy", () => {
    it("says a finished run's last open lead closes the run", () => {
        expect(closeSessionCopy({ ...base, isLead: true, runFinished: true, runTabCount: 1 })).toEqual({
            title: "Close run",
            message: `"Resource linking" has finished and its lead is its last open session. Close it? This can't be undone.`,
            confirmLabel: "Close run",
        });
    });

    it("offers the whole run for a lead whose run holds other tabs, finished or not", () => {
        for (const runFinished of [false, true]) {
            expect(closeSessionCopy({ ...base, isLead: true, runFinished, runTabCount: 3 })).toEqual({
                title: "Close lead",
                message: `"lead one" leads a run with 2 other open sessions. Close the whole run, or only the lead and leave its workers running? This can't be undone.`,
                confirmLabel: "Close run",
            });
        }
        expect(closeSessionCopy({ ...base, isLead: true, runTabCount: 2 }).message).toContain("1 other open session.");
    });

    it("keeps an agent's wording for a lead of a run still going, and for any other agent", () => {
        const agent = {
            title: "Close agent",
            message: `End the session for "lead one"? This stops the agent and can't be undone.`,
            confirmLabel: "Close agent",
        };
        expect(closeSessionCopy({ ...base, isLead: true, runTabCount: 1 })).toEqual(agent);
        expect(closeSessionCopy({ ...base, runFinished: true, runTabCount: 1 })).toEqual(agent);
    });

    it("keeps a terminal's wording", () => {
        expect(closeSessionCopy({ ...base, isTerminal: true })).toEqual({
            title: "Close terminal",
            message: `Close the terminal "lead one"? This ends its shell and can't be undone.`,
            confirmLabel: "Close terminal",
        });
    });
});
