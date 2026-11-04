// Cockpit review scenarios: ask keyboard answers.
export const cockpitAskKeys = {
    name: "cockpit-ask-keys",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert() {
        return [{ step: "cockpit-ask-keys: steps not written yet", ok: false }];
    },
    async teardown() {},
};
