import type { ThingKindDef } from "./types";

export type RecordThing = unknown; // a later task replaces this
export const RECORD_KIND: ThingKindDef<RecordThing> = {
    kind: "record",
    noun: "Record",
    actions: [],
    entries: () => [],
};
