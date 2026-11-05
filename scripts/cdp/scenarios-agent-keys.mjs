// Agent review scenario `agent-keys`: steps are written by the task that fixes what it checks.

const NAME = "agent-keys";

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
