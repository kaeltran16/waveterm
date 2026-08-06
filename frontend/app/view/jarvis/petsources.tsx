// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Always-mounted (cockpit root) driver for the two registers that read the backend: Voice and the rank-1
// condition. Renders nothing. The adapters it feeds are pure and live in petjoin.ts; this file is only the
// plumbing — when to read, and what to subscribe to.
//
// Three sources, three different cadences, each for a stated reason:
//
//   Launch narrative  — read ONCE. It is written at a run's rest boundary and read from the DB, so it is
//                       durable; re-reading it on a timer would find the same row.
//   memory:activity   — subscribed, plus a history backlog at mount. Sweeps and distillation batches are
//                       pushed by the server, and the backlog is what makes "while you were out" work when
//                       they fired before this window opened. Note the broker's persist buffer is
//                       in-memory, so a wavesrv restart replays nothing — the durable half of Voice is the
//                       launch narrative above, which is why that one reads the DB.
//   index status      — read at launch and every 15 minutes. NOT on the 10s attention cadence: the backend
//                       read parses the whole vault to count drift, and the state it reports changes on the
//                       order of minutes to hours. The cost of the slow cadence is that toggling embeddings
//                       mid-session takes up to 15 minutes to show on the creature.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect } from "react";
import { readUntilLanded } from "./petboot";
import { eventFromActivity, eventFromResume, eventFromVolunteer, passFromActivity } from "./petjoin";
import { petIndexAtom, pushPetEvent, recordPass } from "./petstore";

const INDEX_POLL_MS = 15 * 60_000;
const ACTIVITY_BACKLOG = 20;

// Each loader returns whether the read landed, never whether it found anything: "the vault has no narrative"
// is a successful read, "the backend did not answer" is not, and only the second is worth retrying.
//
// A failed read leaves the previous value alone. Blanking the index status on one dropped request would read
// as "recall is fine", which is the one thing rank 1 must never say without knowing it.
//
// Exported for petactrun.ts: after a catch-up is dispatched, the 15-minute ambient cadence below is far too
// slow to show that the button did anything, so the runner re-reads on a tight bounded burst of its own.
export async function loadIndexStatus(): Promise<boolean> {
    try {
        const status = await RpcApi.GetEmbedIndexStatusCommand(TabRpcClient);
        globalStore.set(petIndexAtom, status);
        return true;
    } catch {
        return false; // keep the previous value
    }
}

async function loadLaunchNarrative(): Promise<boolean> {
    try {
        const event = eventFromResume(await RpcApi.GetLatestResumeCommand(TabRpcClient));
        if (event != null) {
            pushPetEvent(event);
        }
        return true; // no narrative is a normal state, not an error worth retrying
    } catch {
        return false;
    }
}

// scope "" because the event is published scope-less (see pkg/memdistill/activity.go), which the history
// read expresses as an empty scope rather than an omitted field.
async function loadActivityBacklog(): Promise<boolean> {
    try {
        const events = await RpcApi.EventReadHistoryCommand(TabRpcClient, {
            event: "memory:activity",
            scope: "",
            maxitems: ACTIVITY_BACKLOG,
        });
        for (const e of events ?? []) {
            const data = e?.data as MemoryActivityData | undefined;
            // recorded even when it yields no utterance: a pass that wrote nothing is the case the
            // last-pass row exists for, and dropping it here is what would make it invisible
            const pass = passFromActivity(data);
            if (pass != null) {
                recordPass(pass);
            }
            const mapped = eventFromActivity(data);
            if (mapped != null) {
                pushPetEvent(mapped);
            }
        }
        return true;
    } catch {
        return false; // the live subscription still covers anything from here on
    }
}

// scope "" for the same reason as the memory-activity read above: the event is published scope-less,
// because it is a fact about your work rather than about one object.
async function loadVolunteerBacklog(): Promise<boolean> {
    try {
        const events = await RpcApi.EventReadHistoryCommand(TabRpcClient, {
            event: "jarvis:volunteer",
            scope: "",
            maxitems: ACTIVITY_BACKLOG,
        });
        for (const e of events ?? []) {
            const mapped = eventFromVolunteer(e?.data as VolunteerData | undefined);
            if (mapped != null) {
                pushPetEvent(mapped);
            }
        }
        return true;
    } catch {
        return false; // the live subscription still covers anything from here on
    }
}

export function PetSources() {
    useEffect(() => {
        // Retried until each lands: all three are one-shot or near-enough (15 min), so a read lost to a
        // backend that was not ready at mount would otherwise stay lost for the session. See petboot.ts.
        let mounted = true;
        const live = () => mounted;
        void readUntilLanded({ read: loadLaunchNarrative, live });
        void readUntilLanded({ read: loadActivityBacklog, live });
        void readUntilLanded({ read: loadVolunteerBacklog, live });
        void readUntilLanded({ read: loadIndexStatus, live });
        const t = setInterval(() => void loadIndexStatus(), INDEX_POLL_MS);
        const unsub = waveEventSubscribeSingle({
            eventType: "memory:activity",
            handler: (event) => {
                const pass = passFromActivity(event?.data);
                if (pass != null) {
                    recordPass(pass);
                }
                const mapped = eventFromActivity(event?.data);
                if (mapped != null) {
                    pushPetEvent(mapped);
                }
            },
        });
        const unsubVolunteer = waveEventSubscribeSingle({
            eventType: "jarvis:volunteer",
            handler: (event) => {
                const mapped = eventFromVolunteer(event?.data);
                if (mapped != null) {
                    pushPetEvent(mapped);
                }
            },
        });
        return () => {
            mounted = false;
            clearInterval(t);
            unsub();
            unsubVolunteer();
        };
    }, []);
    return null;
}
