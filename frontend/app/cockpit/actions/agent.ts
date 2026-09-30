import type { ThingKindDef } from "./types";

export type AgentThing = unknown; // a later task replaces this
export const AGENT_KIND: ThingKindDef<AgentThing> = { kind: "agent", noun: "Agent", actions: [], entries: () => [] };
