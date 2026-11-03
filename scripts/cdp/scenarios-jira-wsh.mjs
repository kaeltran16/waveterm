// jira-wsh: wsh jira check and show, and wsh effort show and list with the ticket (Task 5 of docs/superpowers/plans/2026-11-03-jira-integration.md). A stub until that task builds it;
// the fake Jira and the seeding helpers it will use are in jira-fixtures.mjs.
import { skipStep } from "./scenarios-shared.mjs";

export const jiraWsh = {
    name: "jira-wsh",
    surface: "agent",
    async arrange() {
        return {};
    },
    async assert() {
        return [skipStep("wsh jira check and show, and wsh effort show and list with the ticket", "not built yet")];
    },
};
