import { globalStore } from "@/app/store/jotaiStore";
import { channelsAtom } from "@/app/view/agents/channelsstore";
import { channelProjectLabel, dedupeByProject } from "@/app/view/agents/projectlabel";
import { confirmRemoveProject, projectsAtom } from "@/app/view/agents/projectsstore";
import { briefProfileAtom } from "@/app/view/jarvis/jarvisstore";
import { newRunPrefillAtom } from "@/app/view/jarvis/newruncontrol";
import { openTarget } from "@/app/view/jarvis/openref";
import { fireAndForget } from "@/util/util";
import type { ThingEntry, ThingKindDef } from "./types";

export interface ProjectThing {
    channel: Channel;
    name: string; // the name the project is shown and registered under
    registered: boolean; // in projects.json, so removable (the switcher's `registered`)
}

// one entry per project, as the palette's project rows
export function projectEntries(
    channels: Channel[],
    projects: Record<string, ProjectKeywords>
): ThingEntry<ProjectThing>[] {
    const registered = new Set(Object.keys(projects ?? {}));
    return dedupeByProject(channels).map((channel) => {
        const name = channelProjectLabel(channel, projects);
        return {
            key: `channel:${channel.oid}`,
            title: `#${name}`,
            thing: { channel, name, registered: registered.has(name) },
        };
    });
}

export const PROJECT_KIND: ThingKindDef<ProjectThing> = {
    kind: "channel",
    noun: "Project",
    actions: [
        {
            id: "channel:switch",
            label: "Switch to it",
            group: "open",
            applies: () => true,
            run: (p, { model }) =>
                fireAndForget(() => openTarget(model, { kind: "channel", channelId: p.channel.oid })),
        },
        {
            id: "channel:new-run",
            label: "New run in it",
            group: "steer",
            applies: () => true,
            run: (p, { model }) => {
                globalStore.set(newRunPrefillAtom, { projectName: p.name, goal: "", shape: "orchestrator" });
                globalStore.set(model.newRunOpenAtom, true);
            },
        },
        {
            id: "channel:defaults",
            label: "Run defaults",
            group: "steer",
            applies: () => true,
            // the Brief's Profile window, which the Brief mounts
            run: (p, { model }) => {
                globalStore.set(briefProfileAtom, p.channel.oid);
                globalStore.set(model.surfaceAtom, "jarvis");
            },
        },
        {
            id: "channel:remove",
            label: "Remove",
            group: "stop",
            destructive: true,
            applies: (p) => p.registered,
            run: (p, { model }) => confirmRemoveProject(model, p.name),
        },
    ],
    entries: (get) => projectEntries(get(channelsAtom) ?? [], get(projectsAtom)),
};
