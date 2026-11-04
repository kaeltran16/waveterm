// Cockpit review scenarios: a launch stays on the Cockpit.
export const cockpitLaunchStays = {
    name: "cockpit-launch-stays",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert() {
        return [{ step: "cockpit-launch-stays: steps not written yet", ok: false }];
    },
    async teardown() {},
};
