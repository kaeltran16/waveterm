// Scenario `transcript-census-layout`: the census's layout fixes (transcriptlayout.ts), each at both census hosts.
// A6: a closing wsh call left pending at the end of an ended session draws as its landed card, never "stopped".
// E6: a Monitor event notice right after its Monitor step draws once. E5: two interruptions back to back draw one.

import { bash, clearTranscript, HOSTS, openFolds, prose, ROOT, showAt, tool, user, waitSeam } from "./transcript-fixture.mjs";

const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const S = 1000;
const R = `document.querySelector(${JSON.stringify(ROOT)})`;

// census specimens 7/27: a reviewer's verdict closes its tab before Claude Code writes the call's result
const closingEntries = [
    user("wake: plan review failed in round 2, the last: 5) Parallelism: NOT FIXED", T0),
    tool("read", "docs/superpowers/plans/2026-11-17-arc-resource-management.md", { ts: T0 + S }),
    bash({
        description: "Submit plan review verdict",
        command: 'wsh jarvis dag planreview pass "Runnable as written. Every spec decision and builder item has a task."',
        ts: T0 + 2 * S,
        pending: true,
    }),
];

// census specimen 79: the Monitor's first event arrives a few seconds after it was armed
const MONITOR_DESC = "plant bench cycle on .236 (step starts/ends, stop)";
const monitorEntries = [
    user("start the bench cycle and watch it", T0),
    tool("monitor", MONITOR_DESC, { ts: T0 + S, durationMs: 76 }),
    tool("schedulewakeup", "", { ts: T0 + 5 * S, durationMs: 42 }),
    { kind: "notification", summary: `Monitor event: "${MONITOR_DESC}"`, source: "monitor", notice: true },
    prose("The bench cycle is running on .236; I'll report when it finishes.", T0 + 9 * S),
];

// census specimen 39
const interruptEntries = [
    user("i have been a while", T0),
    { kind: "interrupted" },
    { kind: "interrupted" },
    user("it has been a while", T0 + 6 * S),
];

const CLOSING_STATE = `(() => {
    const root = ${R};
    if (!root) return null;
    return {
        card: root.querySelectorAll('[data-wsh-card="dag-planreview"]').length,
        stopped: root.querySelectorAll('[data-step-status="stopped"]').length,
        statuses: [...root.querySelectorAll('[data-step-status]')].map((s) => s.getAttribute('data-step-status')),
    };
})()`;

const MONITOR_STATE = `(() => {
    const root = ${R};
    if (!root) return null;
    const desc = ${JSON.stringify(MONITOR_DESC)};
    return {
        steps: [...root.querySelectorAll('[data-step]')].filter((s) => s.innerText.includes(desc)).length,
        notices: root.querySelectorAll('[data-notification-source="monitor"]').length,
    };
})()`;

export const transcriptCensusLayout = {
    name: "transcript-census-layout",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const seam = await waitSeam(h);
        const steps = [{ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` }];
        if (!seam) return steps;

        for (const [name, host] of Object.entries(HOSTS)) {
            await showAt(h, host, closingEntries);
            await openFolds(h);
            const closing = await h.ev(CLOSING_STATE);
            await h.shot(`cdp-shots/transcript-census-layout-closing-${name}.png`);
            steps.push({
                step: `A6 ${name}: a planreview verdict pending at the end of an ended session draws as its card, no row reads stopped`,
                ok: closing != null && closing.card === 1 && closing.stopped === 0,
                detail: JSON.stringify(closing),
            });

            await showAt(h, host, monitorEntries);
            await openFolds(h);
            const monitor = await h.ev(MONITOR_STATE);
            await h.shot(`cdp-shots/transcript-census-layout-monitor-${name}.png`);
            steps.push({
                step: `E6 ${name}: a Monitor event notice right after its Monitor step draws once, as the step`,
                ok: monitor != null && monitor.steps === 1 && monitor.notices === 0,
                detail: JSON.stringify(monitor),
            });

            await showAt(h, host, interruptEntries);
            const interrupts = await h.ev(`${R}?.querySelectorAll('[data-interrupted]').length ?? null`);
            await h.shot(`cdp-shots/transcript-census-layout-interrupted-${name}.png`);
            steps.push({
                step: `E5 ${name}: two interruptions back to back draw one "You interrupted"`,
                ok: interrupts === 1,
                detail: `interrupted=${interrupts}`,
            });
        }
        return steps;
    },
    teardown(h) {
        return clearTranscript(h);
    },
};
