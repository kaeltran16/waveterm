import { isArchivedStatus } from "@/app/view/jarvis/briefpalette";
import { workOnInitiative } from "@/app/view/jarvis/initiativeworkaction";
import { openAddress } from "@/app/view/jarvis/openref";
import { fireAndForget } from "@/util/util";
import { paletteEffortsAtom } from "../palette-entities";
import { boardChannelFor, drawOnBoardAction } from "./boarddraw";
import type { ThingKindDef } from "./types";

export type InitiativeThing = EffortSummary;

export const INITIATIVE_KIND: ThingKindDef<InitiativeThing> = {
    kind: "effort",
    noun: "Initiative",
    actions: [
        {
            id: "effort:open",
            label: "Open",
            group: "open",
            applies: () => true,
            // an effort's oref is already an address
            run: (e, { model }) => fireAndForget(() => openAddress(model, e.oref)),
        },
        {
            id: "effort:work",
            label: "Work on it / go to its agent",
            group: "steer",
            // an archived initiative is finished
            applies: (e) => !isArchivedStatus(e.status),
            run: (e, { model }) => workOnInitiative(model, e),
        },
        // drawn in the current project, read whole
        drawOnBoardAction<InitiativeThing>("effort", (e) => {
            const channelId = boardChannelFor();
            if (channelId == null) {
                return null;
            }
            const source = {
                kind: "effort",
                ref: e.oref.replace(/^effort:/, ""),
                title: e.title || "(untitled initiative)",
            };
            return { channelId, source, followable: false };
        }),
    ],
    entries: (get) =>
        (get(paletteEffortsAtom) ?? []).map((e) => ({
            key: `effort:${e.oref}`,
            title: e.title || "(untitled initiative)",
            thing: e,
        })),
};
