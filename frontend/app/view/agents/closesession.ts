// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: the words of the dialog that closes a session.

export interface CloseSessionInput {
    isLead: boolean;
    runFinished: boolean;
    // the run's tabs in the roster, the lead's own included
    runTabCount: number;
    runTitle: string;
    name: string;
    isTerminal?: boolean;
}

export interface CloseSessionCopy {
    title: string;
    message: string;
    confirmLabel: string;
}

/** Pure: a lead whose run holds other tabs is offered the whole run; a finished run's last open lead says that
 *  closing it closes the run; anything else closes one agent or terminal. */
export function closeSessionCopy(input: CloseSessionInput): CloseSessionCopy {
    const { isLead, runFinished, runTabCount, runTitle, name } = input;
    if (isLead && runTabCount > 1) {
        const others = runTabCount - 1;
        const sessions = others === 1 ? "1 other open session" : `${others} other open sessions`;
        return {
            title: "Close lead",
            message: `"${name}" leads a run with ${sessions}. Close the whole run, or only the lead and leave its workers running? This can't be undone.`,
            confirmLabel: "Close run",
        };
    }
    if (isLead && runFinished && runTabCount === 1) {
        return {
            title: "Close run",
            message: `"${runTitle}" has finished and its lead is its last open session. Close it? This can't be undone.`,
            confirmLabel: "Close run",
        };
    }
    if (input.isTerminal) {
        return {
            title: "Close terminal",
            message: `Close the terminal "${name}"? This ends its shell and can't be undone.`,
            confirmLabel: "Close terminal",
        };
    }
    return {
        title: "Close agent",
        message: `End the session for "${name}"? This stops the agent and can't be undone.`,
        confirmLabel: "Close agent",
    };
}
