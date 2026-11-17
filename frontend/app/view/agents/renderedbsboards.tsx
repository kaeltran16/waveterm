// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The boards a Rendered card draws: a question's boards, and the standalone Mockup card for a canvas with no
// brainstorm. A stub until its slice lands.

import type { JSX, ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormFile } from "./brainstormmodel";
import type { BrainstormState } from "./brainstormstore";

const NO_BOARDS: { block: ReactNode | null; chip: (i: number) => ReactNode | null } = { block: null, chip: () => null };

export function useQuestionBoards(
    _agent: AgentVM,
    _s: BrainstormState,
    _f: BrainstormFile,
    _judging: boolean,
    _compact: boolean
): { block: ReactNode | null; chip: (i: number) => ReactNode | null } {
    return NO_BOARDS;
}

export function MockupCard(_p: { model: AgentsViewModel; agent: AgentVM; compact: boolean }): JSX.Element | null {
    return null;
}
