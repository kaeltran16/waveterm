// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered transcript's own rows for brainstorm entries: folded answers, "You ..." rows, the mark bubble. A stub
// until its slice lands.

import type { ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentEntry, AgentVM } from "./agentsviewmodel";

const NO_ROW = (_entry: AgentEntry, _index: number): ReactNode | null => null;

export function useRenderedEntryRow(
    _model: AgentsViewModel,
    _agent: AgentVM
): (entry: AgentEntry, index: number) => ReactNode | null {
    return NO_ROW;
}
