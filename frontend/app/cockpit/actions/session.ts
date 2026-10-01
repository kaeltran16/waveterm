import { globalStore } from "@/app/store/jotaiStore";
import { confirmCloseSession } from "@/app/view/agents/agentactions";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { overlayLive, sessionsArchiveAtom, type LiveSession } from "@/app/view/agents/sessionsarchivestore";
import { runSessionPrimary } from "@/app/view/agents/sessionsdetail";
import { sessionPrimary, sessionSelection } from "@/app/view/agents/sessionsruns";
import type { ThingKindDef } from "./types";

// the session as the Sessions surface builds it, with the roster agent a live one is running in
export interface SessionThing {
    session: LiveSession;
    agent?: AgentVM;
}

export const SESSION_KIND: ThingKindDef<SessionThing> = {
    kind: "session",
    noun: "Session",
    actions: [
        {
            id: "session:resume",
            label: "Resume",
            group: "open",
            applies: (t) => sessionPrimary(t.session) === "resume",
            run: (t, { model }) => runSessionPrimary(model, t.session),
        },
        {
            id: "session:open",
            label: "Open in Sessions",
            group: "open",
            applies: () => true,
            // the Sessions surface has no router target, so this writes its own selection as its list does
            run: (t, { model }) => {
                const to = sessionSelection(t.session);
                globalStore.set(model.sessionsSelAtom, to.sel);
                if (to.member != null) {
                    globalStore.set(model.sessionsMemberAtom, to.member);
                }
                globalStore.set(model.surfaceAtom, "sessions");
            },
        },
        {
            id: "session:stop",
            label: "Stop",
            group: "stop",
            destructive: true,
            applies: (t) => t.agent != null,
            run: (t, { model }) => confirmCloseSession(t.agent, model),
        },
    ],
    // resumable ones only, as the palette's session rows
    entries: (get, model) => {
        const base = get(sessionsArchiveAtom);
        if (base == null) {
            return [];
        }
        const roster = get(model.agentsAtom);
        return overlayLive(base, roster, Date.now())
            .filter((s) => s.resumecommand)
            .map((s) => ({
                key: `session:${s.runtime}:${s.id}`,
                title: s.task || "(untitled session)",
                thing: { session: s, agent: s.liveId != null ? roster.find((a) => a.id === s.liveId) : undefined },
            }));
    },
};
