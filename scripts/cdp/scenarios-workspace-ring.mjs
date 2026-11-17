// Scenario `workspace-ring`: written by Task 4 of docs/superpowers/plans/2026-11-17-workspace-pane.md. Until then it
// records one failing step, so an unwritten scenario cannot pass.

export const workspaceRing = {
    name: "workspace-ring",
    surface: "agent",
    async arrange() {
        return {};
    },
    async assert() {
        return [
            { step: "not written yet", ok: false, detail: "Task 4 of the workspace pane plan writes this scenario" },
        ];
    },
};
