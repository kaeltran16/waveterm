// jira-check: Check Jira and Make initiative from the Brief (Task 7 of docs/superpowers/plans/2026-11-03-jira-integration.md). A stub until that task builds it;
// the fake Jira and the seeding helpers it will use are in jira-fixtures.mjs.
import { skipStep } from "./scenarios-shared.mjs";

export const jiraCheck = {
    name: "jira-check",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert() {
        return [skipStep("Check Jira and Make initiative from the Brief", "not built yet")];
    },
};
