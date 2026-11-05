// Agent review scenario `agent-subagents`: steps are written by the task that fixes what it checks.

const NAME = "agent-subagents";

export default function (_kit) {
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
