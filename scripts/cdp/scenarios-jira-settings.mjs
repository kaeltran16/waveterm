// jira-settings: Settings > Jira (Task 6 of docs/superpowers/plans/2026-11-03-jira-integration.md). A stub until that task builds it;
// the fake Jira and the seeding helpers it will use are in jira-fixtures.mjs.
import { skipStep } from "./scenarios-shared.mjs";

export const jiraSettings = {
    name: "jira-settings",
    surface: "settings",
    async arrange() {
        return {};
    },
    async assert() {
        return [skipStep("Settings > Jira", "not built yet")];
    },
};
