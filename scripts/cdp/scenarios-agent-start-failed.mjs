// The Agent surface's start-failure state.
// the fixtures are in sessions-page-fixtures.mjs.

const NAME = "agent-start-failed";

export default function (kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange() {
                return {};
            },
            async assert() {
                return [{ step: `${NAME}: steps not written yet`, ok: false }];
            },
            async teardown() {},
        },
    ];
}
