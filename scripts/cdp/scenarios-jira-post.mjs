// jira-post: Post progress to Jira (Task 9 of docs/superpowers/plans/2026-11-03-jira-integration.md). A stub until that task builds it;
// the fake Jira and the seeding helpers it will use are in jira-fixtures.mjs.
import { skipStep } from "./scenarios-shared.mjs";

export const jiraPost = {
    name: "jira-post",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert() {
        return [skipStep("Post progress to Jira", "not built yet")];
    },
};
