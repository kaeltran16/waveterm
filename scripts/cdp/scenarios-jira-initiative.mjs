// jira-initiative: the ticket on the initiative's Brief row and ticket bar (Task 8 of docs/superpowers/plans/2026-11-03-jira-integration.md). A stub until that task builds it;
// the fake Jira and the seeding helpers it will use are in jira-fixtures.mjs.
import { skipStep } from "./scenarios-shared.mjs";

export const jiraInitiative = {
    name: "jira-initiative",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert() {
        return [skipStep("the ticket on the initiative's Brief row and ticket bar", "not built yet")];
    },
};
