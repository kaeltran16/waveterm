import type { ThingKindDef } from "./types";

export type RunThing = unknown; // a later task replaces this
export const RUN_KIND: ThingKindDef<RunThing> = { kind: "run", noun: "Run", actions: [], entries: () => [] };
