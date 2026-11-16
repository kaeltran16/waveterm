// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// lines shown, stdout first, before "Show all" opens the rest
export const SHELL_LINES_SHOWN = 8;

export type ShellRunLines = {
    stdout: string[];
    stderr: string[];
    total: number;
    // lines are held back, so "Show all" draws
    showAll: boolean;
    // the card is opened past the clamp, so the control folds it back
    showLess: boolean;
};

function lines(text: string | undefined): string[] {
    const t = (text ?? "").replace(/\n+$/, "");
    return t === "" ? [] : t.split("\n");
}

// a `!` card's output: the clamp to SHELL_LINES_SHOWN unless opened, and which control draws
export function shellRunLines(stdout: string | undefined, stderr: string | undefined, open: boolean): ShellRunLines {
    const out = lines(stdout);
    const err = lines(stderr);
    const total = out.length + err.length;
    const over = total > SHELL_LINES_SHOWN;
    if (open || !over) {
        return { stdout: out, stderr: err, total, showAll: false, showLess: open && over };
    }
    const outShown = out.slice(0, SHELL_LINES_SHOWN);
    const errShown = err.slice(0, SHELL_LINES_SHOWN - outShown.length);
    return { stdout: outShown, stderr: errShown, total, showAll: true, showLess: false };
}
