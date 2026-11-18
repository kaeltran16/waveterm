// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The models behind the agent-to-agent cards and the agents list view (wshcards-agents.tsx): argv, the call's own
// --json output and the live roster in, plain values out.

import { parseAddress } from "../jarvis/address";
import type { AgentState, AgentVM } from "./agentsviewmodel";
import { wshJsonOutput, type WshCall } from "./wshcall";

// the id length `wsh agents list` prints
const SHORT_ID_LEN = 8;
const AGENT_ADDRESS_KINDS = ["agent", "tab"];
const SURFACE_PREFIX = "surface:";
const STATES: readonly string[] = ["asking", "working", "idle"];

// what a card knows of its call's result: the command and output the tool recorded
export interface CallResult {
    command?: string;
    output?: string;
    exit?: number;
}

export function shortId(id: string): string {
    return id.slice(0, SHORT_ID_LEN);
}

// the roster's name is the tab name, the project folder that every agent in one project shares, so a card names an
// agent as the cockpit's rows do (custom label, else session title, else project), else by its session title when
// the cockpit does not have it
export function withCockpitNames(
    roster: AgentInfo[] | undefined,
    cockpit: Pick<AgentVM, "id" | "name">[]
): AgentInfo[] | undefined {
    if (!roster) {
        return roster;
    }
    const names = new Map(cockpit.map((a) => [a.id, a.name]));
    return roster.map((a) => ({ ...a, name: names.get(a.tabid) || a.title?.trim() || a.name }));
}

// wsh takes a tab id or a unique prefix of one: an exact id first, else the one tab the prefix fits
export function resolveAgent(tab: string, roster: AgentInfo[] | undefined): AgentInfo | undefined {
    if (!tab || !roster) {
        return undefined;
    }
    const exact = roster.find((a) => a.tabid === tab);
    if (exact) {
        return exact;
    }
    const matches = roster.filter((a) => a.tabid.startsWith(tab));
    return matches.length === 1 ? matches[0] : undefined;
}

interface AgentLabel {
    name: string;
    // set only when the roster knows the agent: the full id a link opens
    tabid?: string;
}

function labelFor(tab: string, roster: AgentInfo[] | undefined): AgentLabel {
    const agent = resolveAgent(tab, roster);
    return agent ? { name: agent.name, tabid: agent.tabid } : { name: shortId(tab) };
}

export interface ListRow {
    key: string;
    name: string;
    state: AgentState;
    about: string;
    id: string;
}

function agentState(state: string): AgentState {
    return STATES.includes(state) ? (state as AgentState) : "idle";
}

export function listRows(agents: AgentInfo[]): ListRow[] {
    return agents.map((a) => ({
        key: a.tabid,
        name: a.name,
        state: agentState(a.state),
        about: a.runid ? `run ${shortId(a.runid)}` : a.project || a.state,
        id: shortId(a.tabid),
    }));
}

export interface SendModel {
    name: string;
    tabid?: string;
    text?: string;
    // the --file the text came from, when the argv holds no text
    file?: string;
    midTurn?: boolean;
}

// `agents send <tab> [text]`; the human line "it joined the turn" is never parsed, only --json output
export function sendModel(call: WshCall, roster: AgentInfo[] | undefined, result?: CallResult): SendModel {
    const sent = wshJsonOutput<CommandAgentsSendRtnData>(result?.command, result?.output, result?.exit);
    const file = call.flags.file;
    return {
        ...labelFor(call.args[0] ?? "", roster),
        text: call.args[1],
        file: call.args[1] == null && typeof file === "string" ? file : undefined,
        midTurn: sent?.midturn,
    };
}

export interface ReadModel {
    name: string;
    tabid?: string;
    answer: string;
}

// `agents read <tab>`: the answer is --json's `answer`, else the call's printed body
export function readModel(call: WshCall, roster: AgentInfo[] | undefined, result?: CallResult): ReadModel {
    const read = wshJsonOutput<CommandAgentsReadRtnData>(result?.command, result?.output, result?.exit);
    const label = labelFor(read?.tabid || call.args[0] || "", roster);
    return { ...label, answer: read ? read.answer : (result?.output ?? "").trim() };
}

export interface RevealModel {
    kind: "show" | "open";
    label: string;
    mono: boolean;
}

function isArcAddress(address: string): boolean {
    return address.startsWith(SURFACE_PREFIX) || parseAddress(address).kind !== "unsupported";
}

// an address of something in Arc is "shown"; anything else is a file path, "opened"
export function revealModel(address: string, roster: AgentInfo[] | undefined): RevealModel {
    const [kind, id] = address.split(":");
    if (AGENT_ADDRESS_KINDS.includes(kind) && id) {
        const agent = resolveAgent(id, roster);
        return agent
            ? { kind: "show", label: agent.name, mono: false }
            : { kind: "show", label: shortId(id), mono: true };
    }
    return { kind: isArcAddress(address) ? "show" : "open", label: address, mono: true };
}
