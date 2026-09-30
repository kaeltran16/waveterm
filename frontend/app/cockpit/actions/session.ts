import type { ThingKindDef } from "./types";

export type SessionThing = unknown; // a later task replaces this
export const SESSION_KIND: ThingKindDef<SessionThing> = {
    kind: "session",
    noun: "Session",
    actions: [],
    entries: () => [],
};
