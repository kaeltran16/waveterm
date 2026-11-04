// Ctrl+P's Sessions scope resuming a session, on in-page fixture sessions (nothing is written to disk).
// kit holds scenarios-shared.mjs's sessions helpers (SESSIONS_KIT); the fixtures are in sessions-page-fixtures.mjs.

const NAME = "sessions-palette-resume";

export default function (kit) {
    return [
        {
            name: NAME,
            surface: "sessions",
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
