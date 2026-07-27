import { describe, expect, it } from "vitest";
import { composeStage } from "./stagecompose";
import type { SubjectKind } from "./subjects";

describe("composeStage", () => {
    it("gives a channel the run controls: autonomy, profile, pipeline, worker composer", () => {
        const s = composeStage("channel");
        expect(s).toMatchObject({
            mark: "#",
            showAutonomy: true,
            showProfile: true,
            showPipeline: true,
            recordBand: "attributed",
            thread: "run",
            composerTarget: "worker-or-jarvis",
            showFleet: true,
        });
        expect(s.reachText).toBeNull();
        expect(s.absenceChip).toBeNull();
    });

    it("strips every channel-only control from a conversation and drops the fleet section", () => {
        const s = composeStage("conversation");
        expect(s).toMatchObject({
            mark: "~",
            showAutonomy: false,
            showProfile: false,
            showPipeline: false,
            recordBand: "mentions",
            thread: "turns",
            composerTarget: "jarvis-thread",
            showFleet: false,
        });
        expect(s.fleetTitle).toBeNull();
        expect(s.absenceChip).toBe("No channel · no fleet · no profile");
        expect(s.reachText).toBe("all projects");
    });

    it("makes a dossier its own record band and keeps a record-scoped fleet", () => {
        const s = composeStage("dossier");
        expect(s).toMatchObject({
            mark: "▤",
            showAutonomy: false,
            showProfile: false,
            showPipeline: false,
            recordBand: "subject",
            thread: "record",
            composerTarget: "jarvis-record",
            showFleet: true,
            fleetTitle: "Fleet · on this record",
        });
        expect(s.absenceChip).toBe("Record · not a run");
        expect(s.reachText).toBe("this record + its runs");
    });

    it("never shows autonomy or the profile drawer outside a channel", () => {
        for (const kind of ["dossier", "conversation"] as SubjectKind[]) {
            const s = composeStage(kind);
            expect(s.showAutonomy).toBe(false);
            expect(s.showProfile).toBe(false);
        }
    });

    it("names the fleet section exactly when it is shown", () => {
        for (const kind of ["channel", "dossier", "conversation"] as SubjectKind[]) {
            const s = composeStage(kind);
            expect(s.showFleet).toBe(s.fleetTitle != null);
        }
    });
});
