import type { ThingKindDef } from "./types";

export type ProjectThing = unknown; // a later task replaces this
export const PROJECT_KIND: ThingKindDef<ProjectThing> = {
    kind: "channel",
    noun: "Project",
    actions: [],
    entries: () => [],
};
