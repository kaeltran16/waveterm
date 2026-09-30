import type { ThingKindDef } from "./types";

export type InitiativeThing = unknown; // a later task replaces this
export const INITIATIVE_KIND: ThingKindDef<InitiativeThing> = {
    kind: "effort",
    noun: "Initiative",
    actions: [],
    entries: () => [],
};
