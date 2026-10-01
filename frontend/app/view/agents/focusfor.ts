// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What focusing the cockpit on a run, an agent or a record sets. One builder per kind, shared by the palette's
// focus actions and the avatar popup's Focus this, so the two never disagree on a label or a project.

import { isFocusTarget } from "@/app/view/jarvis/tasksderive";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import type { ActiveFocus } from "./focusstore";
import type { FocusRowVM } from "./focusswitchermodel";

// a run is focusable only while the focus switcher lists it, which is what gives it a label and a project
export function focusForRun(row: FocusRowVM | undefined): ActiveFocus | null {
    if (row == null) {
        return null;
    }
    return { ref: { kind: "run", id: row.id }, label: row.label, project: row.project };
}

export function focusForAgent(agent: AgentVM): ActiveFocus {
    return { ref: { kind: "agent", id: agent.id }, label: agent.name, project: projectOf(agent) };
}

// a record summary carries no project, so the project filter is left alone
export function focusForRecord(r: { id: string; objective: string; status: string }): ActiveFocus | null {
    if (!isFocusTarget(r.status)) {
        return null;
    }
    return { ref: { kind: "task", id: r.id }, label: r.objective, project: "" };
}
