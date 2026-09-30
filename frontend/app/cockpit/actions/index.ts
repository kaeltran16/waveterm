import { AGENT_KIND } from "./agent";
import { INITIATIVE_KIND } from "./initiative";
import { PROJECT_KIND } from "./project";
import { RECORD_KIND } from "./record";
import { RUN_KIND } from "./run";
import { SESSION_KIND } from "./session";
import type { ThingKindDef } from "./types";

export const THING_KINDS: ThingKindDef<any>[] = [
    RUN_KIND,
    AGENT_KIND,
    SESSION_KIND,
    RECORD_KIND,
    INITIATIVE_KIND,
    PROJECT_KIND,
];

export function kindOfKey(key: string): ThingKindDef<any> | undefined {
    const prefix = key.split(":", 1)[0];
    return THING_KINDS.find((def) => def.kind === prefix);
}
