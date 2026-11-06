// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// How much room the lead card gives the lead's own transcript. Pure: no React.

export type LeadPaneShown = "full" | "collapsed" | "none";

/** Pure: the lead pane's room. A pane with no transcript lines is not rendered; while the card shows an ask (a child
 *  ask, a doc review or the lead's own question) the pane folds to its one-line header, so the ask keeps the room,
 *  unless you opened it during this ask. Height-independent: no px threshold. */
export function leadPaneShown(input: { hasAsk: boolean; hasLines: boolean; userOpened: boolean }): LeadPaneShown {
    if (!input.hasLines) {
        return "none";
    }
    if (input.hasAsk && !input.userOpened) {
        return "collapsed";
    }
    return "full";
}
