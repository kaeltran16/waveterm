import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentsViewModel, SurfaceKey } from "../agents/agents";
import { briefDraftAtom, briefScopeAtom, briefThreadAtom, clearBriefThread } from "./briefingstore";
import {
    attachedScope,
    openJarvisWithSource,
    sourceRefForGraphNode,
    sourceRefForMemory,
    sourceRefForRadar,
    sourceRefForRun,
} from "./contextualentry";
import { activeConversationIdAtom, conversationsByIdAtom } from "./jarvisstore";
import { jarvisDraftAtom, sourceConversationAtom } from "./jarvissubjectstore";

// starts off-jarvis so the assertion that the surface moved is about the call, not the initial state.
// "cockpit" rather than a made-up key: a real SurfaceKey is what the atom is typed for.
const model = { surfaceAtom: atom<SurfaceKey>("cockpit") } as unknown as AgentsViewModel;

describe("contextual-entry SourceRef builders", () => {
    beforeEach(() => {
        globalStore.set(model.surfaceAtom, "cockpit");
        globalStore.set(activeConversationIdAtom, null);
        globalStore.set(conversationsByIdAtom, {});
        globalStore.set(jarvisDraftAtom, {});
        globalStore.set(sourceConversationAtom, {});
        clearBriefThread();
    });

    it("builds a run SourceRef from id + goal", () => {
        const ref = sourceRefForRun({ id: "r1", goal: "ship the thing" } as any);
        expect(ref).toEqual({ oref: "run:r1", sourceType: "run", title: "ship the thing" });
    });
    it("builds a radar SourceRef as radar:<finding.id>", () => {
        const ref = sourceRefForRadar({ id: "f9", risk: "retry storm" } as any);
        expect(ref).toEqual({ oref: "radar:f9", sourceType: "radar", title: "retry storm" });
    });
    it("builds a memory SourceRef as memory:<note.id>", () => {
        const ref = sourceRefForMemory({ id: "m3", title: "worktree gotcha" } as any);
        expect(ref).toEqual({ oref: "memory:m3", sourceType: "memory", title: "worktree gotcha" });
    });
    // a graph node's id is a bare id for a vault node and a full oref for a run (ResolveDossierEdges emits
    // RunORef), so the conversion has to respect the kind rather than prefix blindly.
    it("builds a graph node SourceRef from its kind and label", () => {
        expect(sourceRefForGraphNode({ id: "task-a", kind: "task", label: "A" } as GraphNode)).toEqual({
            oref: "task:task-a",
            sourceType: "task",
            title: "A",
        });
        expect(sourceRefForGraphNode({ id: "run:r1", kind: "run", label: "R" } as GraphNode).oref).toBe("run:r1");
    });
    it("wraps a ref in an attached scope with an active chip", () => {
        const ref = sourceRefForRun({ id: "r1", goal: "g" } as any);
        const scope = attachedScope(ref);
        expect(scope.mode).toBe("attached");
        expect(scope.attached).toEqual([ref]);
        expect(scope.chips.some((c) => c.active)).toBe(true);
    });

    // the Brief is the only composition now, so this is the whole of openJarvisWithSource's behavior: one
    // attached stateless thread, primed with the source's suggested prompt.
    it("primes an attached stateless thread from the source", () => {
        const ref = sourceRefForRun({ id: "r1", goal: "ship it" } as any);
        openJarvisWithSource(model, ref);
        expect(globalStore.get(briefScopeAtom).attached[0].oref).toBe("run:r1");
        expect(globalStore.get(briefDraftAtom)).toBe("What changed in this Run and why?");
        expect(globalStore.get(briefThreadAtom)).toEqual([]);
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
    });
});
