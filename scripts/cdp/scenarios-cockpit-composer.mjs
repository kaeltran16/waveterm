// Cockpit review scenarios: composer sends.
export const cockpitComposerSend = {
    name: "cockpit-composer-send",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert() {
        return [{ step: "cockpit-composer-send: steps not written yet", ok: false }];
    },
    async teardown() {},
};
