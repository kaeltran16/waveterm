// Cockpit review scenarios: Backgrounded and Idle sections.
export const cockpitOffgrid = {
    name: "cockpit-offgrid",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert() {
        return [{ step: "cockpit-offgrid: steps not written yet", ok: false }];
    },
    async teardown() {},
};
