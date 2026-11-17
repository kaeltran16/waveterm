// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The run card and the gone card, in the Rendered transcript. A stub until its slice lands.

import type { JSX } from "react";
import type { AgentVM } from "./agentsviewmodel";
import type { BrainstormState } from "./brainstormstore";
import type { CardProps } from "./renderedbrainstormmodel";

export function RunCard(_p: CardProps): JSX.Element | null {
    return null;
}

export function GoneCard(_p: {
    agent: AgentVM;
    s: BrainstormState;
    why: "unreadable" | "removed";
    compact: boolean;
}): JSX.Element | null {
    return null;
}
