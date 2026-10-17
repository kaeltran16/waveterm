// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Every brainstorm action reaches the agent as one line typed into its terminal; Arc never writes brainstorm.json.

import { globalStore } from "@/app/store/jotaiStore";
import { newRunPrefillAtom } from "@/app/view/jarvis/newruncontrol";
import type { AgentsViewModel } from "./agents";
import { projectOf, type AgentVM } from "./agentsviewmodel";
import { brainstormLine, runPrefill, type BrainstormAction } from "./brainstormmodel";
import type { BrainstormState } from "./brainstormstore";
import { tauriSendIO, type SendIO } from "./canvassend";

type TypeIO = Pick<SendIO, "type">;

export async function sendBrainstorm(
    agent: AgentVM,
    action: BrainstormAction,
    io: TypeIO = tauriSendIO
): Promise<void> {
    const line = brainstormLine(action);
    if (line == null) {
        throw new Error("Nothing to send");
    }
    if (!agent.blockId) {
        throw new Error("This agent has no terminal to type into");
    }
    try {
        await io.type(agent.blockId, line + "\r");
    } catch (e) {
        throw new Error(`Couldn't type into ${agent.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

// Change on the approve bar: the launcher prefilled, with nothing typed into the agent
export function openRunLauncher(model: AgentsViewModel, agent: AgentVM, s: BrainstormState): void {
    if (s.file == null) {
        return;
    }
    globalStore.set(newRunPrefillAtom, runPrefill(s.file, { projectName: projectOf(agent), cwd: s.cwd }));
    globalStore.set(model.newRunOpenAtom, true);
}

// the agent hears it is approved first, so a line that cannot be typed leaves the launcher closed
export async function approveAndOpenRun(
    model: AgentsViewModel,
    agent: AgentVM,
    s: BrainstormState,
    io: TypeIO = tauriSendIO
): Promise<void> {
    await sendBrainstorm(agent, { kind: "approved" }, io);
    openRunLauncher(model, agent, s);
}
