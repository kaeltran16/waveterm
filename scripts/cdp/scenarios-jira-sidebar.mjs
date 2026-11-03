// jira-sidebar: the ticket in the chunk sidebar and the run sheet (Task 10 of docs/superpowers/plans/2026-11-03-jira-integration.md). A stub until that task builds it;
// the fake Jira and the seeding helpers it will use are in jira-fixtures.mjs.
import { skipStep } from "./scenarios-shared.mjs";

export const jiraSidebar = {
    name: "jira-sidebar",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert() {
        return [skipStep("the ticket in the chunk sidebar and the run sheet", "not built yet")];
    },
};
