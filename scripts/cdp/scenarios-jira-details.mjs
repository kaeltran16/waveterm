// jira-details: the Ticket field looked up in initiative details (Task 11 of docs/superpowers/plans/2026-11-03-jira-integration.md). A stub until that task builds it;
// the fake Jira and the seeding helpers it will use are in jira-fixtures.mjs.
import { skipStep } from "./scenarios-shared.mjs";

export const jiraDetails = {
    name: "jira-details",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert() {
        return [skipStep("the Ticket field looked up in initiative details", "not built yet")];
    },
};
