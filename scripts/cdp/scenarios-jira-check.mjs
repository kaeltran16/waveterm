// jira-check: Check Jira and Make initiative from the Brief (Task 7 of docs/superpowers/plans/2026-11-03-jira-integration.md;
// boards Main, CheckJiraStates and Elsewhere's palette half). The dev app's real Go client talks to the fake Jira in
// jira-fixtures.mjs. PAY-290 is added to the fake's issues and seeded on an initiative, so the check covers one ticket
// and lists the board's four. Make initiative's launch is stood in for by a stub that, like launchAgent, switches to the
// Agent surface; the scenario comes back to the Brief, where the dialog must still be open on the same rows.
import {
    connectFakeJira,
    disconnectJira,
    motionSamples,
    seedTicketedInitiative,
    startFakeJira,
    withReducedMotion,
} from "./jira-fixtures.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    git,
    lookEval,
    openPalette,
    PALETTE_INPUT,
    paletteKey,
    paletteStateWhen,
    PEEKS_ESC,
    polishNap,
    polishWaitFor,
    setInputExpr,
    waitForProjectInConfig,
} from "./scenarios-shared.mjs";

const DIALOG = `document.querySelector('[data-jira-check]')`;
const PANEL = `[role="dialog"]:has([data-jira-check])`;
const BODY = "[data-jira-check-body]";
const STATE = `${DIALOG}?.querySelector('[data-jira-check-state]')?.getAttribute('data-jira-check-state')`;
const ROW = (key) => `[data-jira-row="${key}"]`;
const flat = (expr) => `((${expr})?.textContent ?? '').replace(/\\s+/g, ' ').trim()`;
const FAKE_TAB = "verify-jira-fake-tab";
// how long the stub launch takes before it switches surfaces, like launchAgent's rpc round trips
const STUB_LAUNCH_MS = 600;
const SAMPLE_MS = 1500;
const ROW_LEAVE_SAMPLE_MS = 5000;
// the dev store's vault is shared by every dev app on the machine, so another Jira scenario running beside this one
// can hold a board key on an initiative; the arrange waits that out rather than assert a different list
const FOREIGN_WAIT_MS = 90000;
// setconfig writes the settings file and wavesrv's watcher reloads it a moment later
const CONNECT_WAIT_MS = 10000;
const VIEWPORT_1000 = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };

const BOARD_ROWS = {
    "PAY-318": "Retry webhook delivery when the partner returns 429",
    "PAY-311": "Settlement report drops refunds issued after cutoff",
    "OPS-77": "Rotate the staging database credentials into the secret store",
    "GROW-12": "Export the onboarding funnel as a weekly CSV",
};
const COVERED = {
    key: "PAY-290",
    title: "Webhook signing key rotation",
    project: "payments-api",
};

// the cockpit's model, found the way the other scenarios find it: on the nav rail's props
const MODEL = `(() => {
    const nav = document.querySelector('nav');
    const key = nav && Object.keys(nav).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? nav[key] : null; f != null; f = f.return) {
        if (f.memoizedProps?.model?.surfaceAtom != null) return f.memoizedProps.model;
    }
    return null;
})()`;
const surfaceNow = (h) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const model = ${MODEL};
        return model ? globalStore.get(model.surfaceAtom) : null;
    `);

// JiraCheckCommand held until release, then answered by the real command: holdRpc never answers the held call, so a
// release could not show the bars giving way to the rows
const holdCheck = (h) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const real = (window.__jiraCheckReal ??= RpcApi.JiraCheckCommand);
        RpcApi.JiraCheckCommand = (...args) =>
            new Promise((resolve, reject) => {
                window.__jiraCheckRelease = () => {
                    RpcApi.JiraCheckCommand = real;
                    real.apply(RpcApi, args).then(resolve, reject);
                };
            });
    `);
const restoreCheck = (h) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        if (window.__jiraCheckReal) RpcApi.JiraCheckCommand = window.__jiraCheckReal;
        delete window.__jiraCheckReal;
        delete window.__jiraCheckRelease;
    `);

const stubLaunch = (h) =>
    lookEval(h, `
        const jm = await mod("app/view/jarvis/jiramake.ts");
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        window.__jiraLaunchReal ??= jm.jiraMakeDeps.launch;
        window.__jiraLaunches = [];
        jm.jiraMakeDeps.launch = async (model, opts) => {
            window.__jiraLaunches.push(opts);
            await nap(${STUB_LAUNCH_MS});
            globalStore.set(model.surfaceAtom, "agent");
            return ${JSON.stringify(FAKE_TAB)};
        };
    `);
const restoreLaunch = (h) =>
    lookEval(h, `
        const jm = await mod("app/view/jarvis/jiramake.ts");
        if (window.__jiraLaunchReal) jm.jiraMakeDeps.launch = window.__jiraLaunchReal;
        delete window.__jiraLaunchReal;
        delete window.__jiraLaunches;
    `);

const closeDialog = (h) =>
    lookEval(h, `
        const { closeCheckJira } = await mod("app/view/jarvis/jiracheckdialog.tsx");
        closeCheckJira();
    `);

const pressCheckJira = (h) => h.ev(`(() => { const b = document.querySelector('[data-jarvis-check-jira]'); b?.click(); return !!b; })()`);
const pressCheckAgain = (h) => h.ev(`${DIALOG}?.querySelector('[data-jira-check-again]')?.click()`);
const waitState = (h, kind, ms = 15000) => polishWaitFor(h, `${STATE} === ${JSON.stringify(kind)}`, ms);
const rowKeys = (h) => h.ev(`[...(${DIALOG}?.querySelectorAll('[data-jira-row]') ?? [])].map((r) => r.getAttribute('data-jira-row'))`);
const searches = (fake) => fake.state.calls.filter((c) => c === "POST /rest/api/3/search/jql").length;
const fadesThrough = (frames, prop = "opacity") =>
    frames.some((f) => f.present && Number(f[prop]) > 0.02 && Number(f[prop]) < 0.98);
const moved = (t) => t != null && t !== "none" && t !== "matrix(1, 0, 0, 1, 0, 0)";
// the translateY of a matrix(...) transform, 0 for none
const shiftY = (t) => (moved(t) ? Number(/matrix\(([^)]+)\)/.exec(t)?.[1].split(",")[5] ?? 0) : 0);
// the distinct offsets a row passed through on its way to rest: one is a jump, several are an animation
const offsets = (frames) => [...new Set(frames.filter((f) => f.present).map((f) => Math.round(shiftY(f.transform))).filter((y) => y !== 0))];

// the agent's `wsh effort create`, run while its Agent surface is showing; then the nav back to the Brief, sampling
// the transform of the row below the one that leaves
async function createWhileAway(h, ctx, key, below) {
    await h.goto("agent");
    await createInitiative(h, ctx, key, BOARD_ROWS[key]);
    const nav = `[...document.querySelectorAll('nav button')].find((b) => b.getAttribute('aria-label') === 'Hub' || (b.textContent || '').trim() === 'Hub')?.click()`;
    return motionSamples(h, { selector: ROW(below), props: ["transform"], ms: ROW_LEAVE_SAMPLE_MS, trigger: nav });
}

async function foreignTickets(h) {
    const keys = new Set([...Object.keys(BOARD_ROWS), COVERED.key]);
    const efforts = (await h.rpc("effortlist", { includearchived: true }))?.efforts ?? [];
    return efforts.filter((e) => keys.has((e.ticket ?? "").trim().toUpperCase())).map((e) => `${e.ticket} (${e.title})`);
}

async function waitNoForeignTickets(h) {
    let held = [];
    for (let waited = 0; waited < FOREIGN_WAIT_MS; waited += 1000) {
        held = await foreignTickets(h);
        if (held.length === 0) return;
        await polishNap(1000);
    }
    throw new Error(`initiatives this scenario did not make already hold its tickets: ${held.join(", ")}`);
}

async function waitConnected(h) {
    let last = null;
    for (let waited = 0; waited < CONNECT_WAIT_MS; waited += 250) {
        last = await h.rpc("jiraconnection", { test: true }).catch((e) => ({ error: String(e?.message ?? e) }));
        if (last?.ok) return;
        await polishNap(250);
    }
    throw new Error(`the fake Jira never connected: ${JSON.stringify(last)}`);
}

async function createInitiative(h, ctx, key, title) {
    const { effortoid } = await h.rpc("effortcreate", { title, project: COVERED.project, ticket: key });
    ctx.oids.push(effortoid);
    return effortoid;
}

export const jiraCheck = {
    name: "jira-check",
    surface: "jarvis",
    async arrange(h) {
        const ctx = { oids: [], restores: [] };
        ctx.fake = await startFakeJira();
        ctx.fake.state.issues[COVERED.key] = {
            ...ctx.fake.state.issues["PAY-318"],
            key: COVERED.key,
            summary: COVERED.title,
            type: "Story",
            status: "In Progress",
            description: null,
            criteria: null,
        };
        ctx.restores.push(await connectFakeJira(h, ctx.fake));
        try {
            // the Brief draws a registered project's initiatives, and inference ranks registered projects
            const projects = (await h.rpc("getfullconfig", null))?.projects ?? {};
            if (projects[COVERED.project] == null) {
                ctx.dir = mkdtempSync(join(tmpdir(), "verify-jira-check-"));
                git(ctx.dir, "init", "-q", "--initial-branch=main");
                git(ctx.dir, "commit", "-q", "--allow-empty", "-m", "seed the jira-check fixture");
                await h.rpc("createproject", { name: COVERED.project, path: ctx.dir });
                ctx.madeProject = true;
                await waitForProjectInConfig(h, COVERED.project);
            }
            await waitConnected(h);
            await waitNoForeignTickets(h);
            ctx.oids.push(await seedTicketedInitiative(h, { title: COVERED.title, project: COVERED.project, key: COVERED.key }));
        } catch (e) {
            ctx.seedError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        rec("0. the fake Jira is connected and PAY-290 is on an initiative", ctx.seedError == null, ctx.seedError ?? "seeded");

        // 1. loading: the dialog over the Brief, three bars, Check again reading Checking…
        await holdCheck(h);
        const pressed = await pressCheckJira(h);
        await polishWaitFor(h, `!!${DIALOG}?.querySelector('[data-jira-check-bars]')`, 4000);
        await polishNap(450);
        const loading = await h.ev(`(() => {
            const d = ${DIALOG};
            return d ? {
                bars: d.querySelectorAll('[data-jira-check-bar]').length,
                again: ${flat(`${DIALOG}?.querySelector('[data-jira-check-again] span:last-child')`)},
                disabled: d.querySelector('[data-jira-check-again]')?.disabled ?? null,
                subtitle: ${flat(`${DIALOG}?.querySelector('[data-jira-check-subtitle]')`)},
                title: d.textContent.includes('Your Jira tickets'),
            } : null;
        })()`);
        await h.shot("cdp-shots/jira-check-1-loading.png");
        rec(
            "1. Check Jira opens Your Jira tickets on three bars, with Checking… and Check again disabled",
            pressed && loading?.title && loading.bars === 3 && loading.again === "Checking…" && loading.disabled === true &&
                loading.subtitle === "Checking your open tickets",
            loading
        );

        // 2. release: the bars crossfade to the board's four rows on a body that keeps its height
        const searchesBefore = searches(ctx.fake);
        const [fade, height] = await Promise.all([
            motionSamples(h, { selector: '[data-jira-check-state="list"]', props: ["opacity"], ms: SAMPLE_MS, trigger: "window.__jiraCheckRelease?.()" }),
            motionSamples(h, { selector: BODY, props: ["height"], ms: SAMPLE_MS, trigger: "" }),
        ]);
        await waitState(h, "list");
        await polishNap(400);
        const list = await h.ev(`(() => {
            const d = ${DIALOG};
            const rows = [...(d?.querySelectorAll('[data-jira-row]') ?? [])].map((r) => ({
                key: r.getAttribute('data-jira-row'),
                text: r.textContent.replace(/\\s+/g, ' ').trim(),
                asks: !!r.querySelector('[data-jira-agent-asks]'),
            }));
            return {
                rows,
                subtitle: ${flat(`${DIALOG}?.querySelector('[data-jira-check-subtitle]')`)},
                footer: ${flat(`${DIALOG}?.querySelector('[data-jira-check-footer]')`)},
                again: ${flat(`${DIALOG}?.querySelector('[data-jira-check-again] span:last-child')`)},
            };
        })()`);
        await h.shot("cdp-shots/jira-check-2-rows.png");
        const heights = new Set(height.filter((f) => f.present).map((f) => f.height));
        const keysOk =
            list.rows.length === 4 &&
            Object.entries(BOARD_ROWS).every(([k, s]) => list.rows.some((r) => r.key === k && r.text.includes(s)));
        rec(
            "2. the bars crossfade to the board's four rows, GROW-12 reads Agent will ask, and the footer counts PAY-290",
            keysOk &&
                list.rows.find((r) => r.key === "GROW-12")?.asks === true &&
                list.subtitle === "4 assigned to you without an initiative" &&
                list.footer === "1 more assigned ticket already has an initiative." &&
                list.again === "Check again" &&
                searches(ctx.fake) === searchesBefore + 1 &&
                fadesThrough(fade) &&
                heights.size === 1,
            { list, heights: [...heights], fadeFrames: fade.filter((f) => f.present).map((f) => f.opacity).slice(0, 30) }
        );

        // 3. Make initiative crossfades in place to Building in Agent; the stub, like launchAgent, goes to the Agent
        // surface, and coming back to the Brief finds the dialog on the same rows without another check
        await stubLaunch(h);
        const makeBox = await h.ev(`(() => {
            const b = document.querySelector('${ROW("PAY-311")} [data-jira-make]')?.getBoundingClientRect();
            return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null;
        })()`);
        const building = await motionSamples(h, {
            selector: `${ROW("PAY-311")} [data-jira-building]`,
            props: ["opacity"],
            ms: STUB_LAUNCH_MS - 100,
            trigger: `document.querySelector('${ROW("PAY-311")} [data-jira-make]')?.click()`,
        });
        const wentToAgent = await polishWaitFor(
            h,
            `(() => { const m = ${MODEL}; return !!m && !document.querySelector('[data-jira-check]'); })()`,
            4000
        );
        const surfaceAway = await surfaceNow(h);
        const searchesAway = searches(ctx.fake);
        await h.goto("jarvis");
        await polishWaitFor(h, `!!document.querySelector('${ROW("PAY-311")} [data-jira-building]')`, 6000);
        await polishNap(400);
        const back = await h.ev(`(() => {
            const btn = document.querySelector('${ROW("PAY-311")} [data-jira-building]');
            const b = btn?.getBoundingClientRect();
            return {
                box: b ? { w: Math.round(b.width), h: Math.round(b.height) } : null,
                text: ${flat(`document.querySelector('${ROW("PAY-311")} [data-jira-building]')`)},
                disabled: btn?.disabled ?? null,
                rows: [...document.querySelectorAll('[data-jira-row]')].map((r) => r.getAttribute('data-jira-row')),
                launches: window.__jiraLaunches ?? [],
            };
        })()`);
        await h.shot("cdp-shots/jira-check-3-building.png");
        const launch = back.launches[0];
        rec(
            "3. Make initiative crossfades to Building in Agent at the same size, and the Brief redraws it after the Agent surface",
            makeBox != null &&
                back.box != null &&
                makeBox.w === back.box.w &&
                makeBox.h === back.box.h &&
                back.text === "Building in Agent" &&
                back.disabled === false &&
                fadesThrough(building) &&
                wentToAgent &&
                surfaceAway === "agent" &&
                back.rows.length === 4 &&
                searches(ctx.fake) === searchesAway &&
                back.launches.length === 1 &&
                launch?.label === `PAY-311 ${BOARD_ROWS["PAY-311"]}` &&
                launch?.task?.includes("wsh jira show PAY-311"),
            { makeBox, back: { ...back, launches: back.launches.map((l) => ({ label: l.label, projectName: l.projectName })) }, surfaceAway, fade: building.filter((f) => f.present).map((f) => f.opacity).slice(0, 12) }
        );

        // 4. the agent creates the initiative while you are on its Agent surface; coming back, the Brief re-reads,
        // PAY-311 leaves, the rows below close the gap, and the Brief gains it fresh
        const keysBefore = await rowKeys(h);
        const below = keysBefore[keysBefore.indexOf("PAY-311") + 1];
        const leave = await createWhileAway(h, ctx, "PAY-311", below);
        const gone = await polishWaitFor(h, `!document.querySelector('${ROW("PAY-311")}')`, 4000);
        const fresh = await polishWaitFor(
            h,
            `[...document.querySelectorAll('[data-jarvis-brief-row="initiative"]')].some((r) => r.textContent.includes(${JSON.stringify(BOARD_ROWS["PAY-311"])}) && r.classList.contains('fresh-mark'))`,
            4000
        );
        const after4 = { rows: await rowKeys(h), subtitle: await h.ev(flat(`${DIALOG}?.querySelector('[data-jira-check-subtitle]')`)), footer: await h.ev(flat(`${DIALOG}?.querySelector('[data-jira-check-footer]')`)) };
        rec(
            "4. once the initiative exists, PAY-311's row leaves, the rows below move up, and the Brief shows it with the fresh mark",
            gone && fresh && below != null && offsets(leave).length > 1 &&
                after4.rows.length === 3 &&
                after4.subtitle === "3 assigned to you without an initiative" &&
                after4.footer === "2 more assigned tickets already have an initiative.",
            { below, after4, fresh, offsets: offsets(leave) }
        );

        // 5. the same removal under reduced motion: the rows below jump, with no frame in between
        const reduced = await withReducedMotion(h, async () => {
            const keys = await rowKeys(h);
            const leaving = keys[0];
            const next = keys[1];
            const frames = await createWhileAway(h, ctx, leaving, next);
            const left = await polishWaitFor(h, `!document.querySelector('${ROW(leaving)}')`, 4000);
            return { leaving, next, left, offsets: offsets(frames) };
        });
        rec("5. under reduced motion the row leaves with no in-between transform frame", reduced.left && reduced.offsets.length <= 1, reduced);

        // 6. Close: the dialog leaves through ModalShell's exit
        const exit = await motionSamples(h, {
            selector: PANEL,
            props: ["opacity"],
            ms: SAMPLE_MS,
            trigger: `${DIALOG}?.closest('[role="dialog"]')?.querySelector('button[aria-label="Close"]')?.click()`,
        });
        const closed = await polishWaitFor(h, `!${DIALOG}`, 2000);
        rec("6. Close fades the dialog out", closed && fadesThrough(exit) && !exit.at(-1).present, {
            frames: exit.filter((f) => f.present).map((f) => f.opacity).slice(0, 20),
        });

        // 7. nothing new: Check again after every ticket is gone
        await pressCheckJira(h);
        await waitState(h, "list");
        // step 11 brings back the ones on initiatives
        const allIssues = { ...ctx.fake.state.issues };
        ctx.fake.state.issues = {};
        const before7 = searches(ctx.fake);
        await pressCheckAgain(h);
        const empty = await waitState(h, "empty");
        await polishNap(400);
        const emptyText = await h.ev(flat(DIALOG));
        await h.shot("cdp-shots/jira-check-7-nothing-new.png");
        rec(
            "7. Check again with nothing assigned shows Nothing new",
            empty && searches(ctx.fake) === before7 + 1 &&
                emptyText.includes("0 assigned to you without an initiative") &&
                emptyText.includes("Every ticket assigned to you has an initiative.") &&
                emptyText.includes("0 open tickets checked."),
            emptyText
        );

        // 8. not connected: Connect Jira lands on Settings > Jira
        const reconnect = await disconnectJira(h);
        await pressCheckAgain(h);
        const off = await waitState(h, "off");
        await polishNap(400);
        const offText = await h.ev(flat(DIALOG));
        await h.shot("cdp-shots/jira-check-8-not-connected.png");
        await h.ev(`${DIALOG}?.querySelector('[data-jira-connect]')?.click()`);
        await polishNap(800);
        const landed = { surface: await surfaceNow(h), section: await h.ev(`!!document.querySelector('[data-settings-section="jira"]')`), dialog: await h.ev(`!!${DIALOG}`) };
        rec(
            "8. not connected says so, and Connect Jira lands on Settings > Jira",
            off && offText.includes("Jira isn't set up") && offText.includes("Arc isn't connected to Jira yet.") &&
                landed.surface === "settings" && landed.section && !landed.dialog,
            { offText, landed }
        );
        await reconnect().catch(() => {});
        await connectFakeJira(h, ctx.fake);
        await waitConnected(h);

        // 9. Jira refused: its status and message, and Replace token
        ctx.fake.state.refuse = { status: 401, message: "Client must be authenticated to access this resource." };
        await h.goto("jarvis");
        await pressCheckJira(h);
        const refused = await waitState(h, "refused");
        await polishNap(400);
        const refusedText = await h.ev(flat(DIALOG));
        await h.shot("cdp-shots/jira-check-9-refused.png");
        rec(
            "9. a 401 shows Jira's status and message, the last good check, and Replace token",
            refused &&
                refusedText.includes("Jira rejected your API token.") &&
                refusedText.includes("401 · Client must be authenticated to access this resource.") &&
                refusedText.includes("Last checked") &&
                refusedText.includes("Replace token"),
            refusedText
        );
        ctx.fake.state.refuse = null;
        await closeDialog(h);
        await polishWaitFor(h, `!${DIALOG}`, 2000);

        // 10. the palette: Check Jira is one of the Jarvis surface's actions, Enter on it opens the dialog, and a key
        // finds its initiative
        const binding = await lookEval(h, `
            const { buildJarvisBindings } = await mod("app/store/keybindings/bindings.ts");
            const b = buildJarvisBindings().find((x) => x.id === "jarvis:check-jira");
            return b ? { group: b.group, label: b.label, keys: b.keys } : null;
        `);
        await openPalette(h);
        await h.ev(setInputExpr(PALETTE_INPUT, "Check Jira"));
        const action = await paletteStateWhen(h, (s) => s.selected?.includes("Check Jira for my tickets"), 3000);
        await h.shot("cdp-shots/jira-check-10-palette-action.png");
        await h.ev(paletteKey("Enter"));
        const opened = await polishWaitFor(h, `!!${DIALOG}`, 3000);
        await polishNap(400);
        await h.shot("cdp-shots/jira-check-10-palette-opened.png");
        await closeDialog(h);
        await polishWaitFor(h, `!${DIALOG}`, 2000);
        await openPalette(h);
        await h.ev(setInputExpr(PALETTE_INPUT, "PAY-29"));
        const byKey = await paletteStateWhen(h, (s) => s.groups.some((g) => g.rows.some((r) => r.includes(COVERED.key))), 3000);
        await h.shot("cdp-shots/jira-check-10-palette-key.png");
        await h.ev(PEEKS_ESC);
        rec(
            "10. Check Jira for my tickets is a Hub action the palette finds, Enter opens the dialog, and PAY-29 finds the ticketed initiative",
            binding?.group === "Hub" && binding.label === "Check Jira for my tickets" && action != null && opened &&
                byKey?.groups.some((g) => /Initiatives/.test(g.label) && g.rows.some((r) => r.includes(COVERED.key) && r.includes(COVERED.title))),
            { binding, selected: action?.selected, opened, byKey: byKey?.groups }
        );

        // 11. F12 at 1000x700 (shot 42): every assigned ticket is on an initiative, so nothing is listed and the
        // footer counts them without "more"
        const onInitiative = [COVERED.key, "PAY-311", reduced.leaving];
        ctx.fake.state.issues = Object.fromEntries(onInitiative.filter((k) => allIssues[k]).map((k) => [k, allIssues[k]]));
        await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT_1000);
        try {
            // opening keeps the last check's state, so this one is asked for
            await pressCheckJira(h);
            await polishWaitFor(h, `!!${DIALOG}`, 3000);
            await pressCheckAgain(h);
            const allCovered = await waitState(h, "empty");
            await polishNap(400);
            const covered11 = await h.ev(`(() => {
                const f = ${DIALOG}?.querySelector('[data-jira-check-footer]');
                const r = f?.getBoundingClientRect();
                return {
                    footer: ${flat(`${DIALOG}?.querySelector('[data-jira-check-footer]')`)},
                    rows: ${DIALOG}?.querySelectorAll('[data-jira-row]').length ?? null,
                    inView: r != null && r.height > 0 && r.bottom <= window.innerHeight,
                    width: window.innerWidth,
                };
            })()`);
            await h.shot("cdp-shots/jira-check-11-all-covered.png");
            const expected = `${onInitiative.length} assigned tickets already have an initiative.`;
            rec(
                "11. F12: with every assigned ticket on an initiative, the footer reads N assigned tickets already have an initiative, with no more",
                allCovered && covered11.width === VIEWPORT_1000.width && covered11.rows === 0 && covered11.inView &&
                    covered11.footer === expected && !/\bmore\b/.test(covered11.footer),
                { ...covered11, expected }
            );
        } finally {
            await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        }
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        await h.ev(PEEKS_ESC).catch(() => {});
        await closeDialog(h).catch(() => {});
        await restoreLaunch(h).catch(() => {});
        await restoreCheck(h).catch(() => {});
        for (const effortoid of ctx.oids) {
            await h.rpc("effortdelete", { effortoid }).catch(() => {});
        }
        for (const restore of ctx.restores.reverse()) {
            await restore();
        }
        await ctx.fake?.close();
        if (ctx.madeProject) await h.rpc("deleteproject", { name: COVERED.project });
        if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
    },
};
