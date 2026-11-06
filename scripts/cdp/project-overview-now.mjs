// The project Overview's Now region (frontend/app/view/agents/projectnow.tsx), checked inside the scenario
// scenarios-project-overview.mjs. It starts and ends with the modal open on ctx.project, restores in a finally
// whatever it installed, and names its steps "project-overview: <Board> board, now: <state>".
//
// The roster is the dev mock (devMockAgentsAtom), the runs are held in the WOS cache (installRuns), the project's
// terminal is the model's terminalsAtom swapped for a fixture one, and its RT info and the runs' events are stubbed
// RpcApi commands. cleanup puts every one back.
import { closeOverview, openOverview, pageEval, shot } from "./project-overview-kit.mjs";
import { fixtureRun, installRuns } from "./sessions-page-fixtures.mjs";

const TERM_BLOCK = "blk-fx-now-term";
const SETTLE_MS = 600;

const agent = (ctx, id, over = {}) => ({
    id,
    name: id,
    project: ctx.project,
    task: "Fixture task",
    state: "working",
    agent: "claude",
    model: "opus",
    activeMs: 12 * 60_000,
    blockId: `blk-${id}`,
    ...over,
});

// the page's handles on what this module swaps, and the fixture roster set through the app's atom
const NOW_LIB = `
    const D = await mod("app/view/agents/devmock.ts");
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    // a read-only atom: the store needs only read, so no jotai import (its vite dep url is not always listed)
    const fixedAtom = (value) => ({ read: () => value, toString: () => "overview-now-fixture" });
    const fx = (window.__overviewNowFx ??= {});
    const setRoster = async (roster) => {
        S.globalStore.set(D.devMockAgentsAtom, roster);
        await nap(${SETTLE_MS});
    };
    const region = () => overview()?.querySelector('[data-overview-region="now"]');
    const rows = (kind) =>
        [...(region()?.querySelectorAll("[data-overview-now-row]") ?? [])]
            .filter((b) => b.closest("section")?.getAttribute("aria-label") === kind)
            .map((b) => ({
                kind: b.getAttribute("data-overview-now-row"),
                name: flat(b.children[1]),
                line: flat(b.children[2]),
                age: flat(b.children[3]),
            }));
    const rowButton = (section, name) =>
        [...(region()?.querySelectorAll("[data-overview-now-row]") ?? [])].find(
            (b) => b.closest("section")?.getAttribute("aria-label") === section && flat(b.children[1]) === name
        );
`;
const nowEval = (h, body) => pageEval(h, `${NOW_LIB} ${body}`);

// stubs the terminal's RT info and the runs' events, swaps in the fixture terminal, and saves what it replaces
function install(h, ctx, { leadRun, landedRun }) {
    const landed = { id: "fx-now-landed", runid: landedRun.run.oid, channelid: landedRun.run.channeloid, ts: Date.now(), kind: "task-merged", detail: JSON.stringify({ taskid: "t-1" }) };
    const terminal = { id: "fx-now-term", name: "dev server", task: "", state: "idle", kind: "terminal", agent: "terminal", project: ctx.project, blockId: TERM_BLOCK };
    return nowEval(h, `
        if (!("mock" in fx)) fx.mock = S.globalStore.get(D.devMockAgentsAtom);
        for (const k of ["GetRTInfoCommand", "JarvisRunEventsCommand"]) {
            if (!(k in (fx.rpc ??= {}))) fx.rpc[k] = Object.getOwnPropertyDescriptor(RpcApi, k) ?? null;
        }
        const realRt = RpcApi.GetRTInfoCommand.bind(RpcApi);
        RpcApi.GetRTInfoCommand = async (client, data, opts) =>
            data?.oref === "block:${TERM_BLOCK}" ? { "shell:integration": true, "shell:state": "running-command", "shell:lastcmd": "task dev" } : realRt(client, data, opts);
        const realEvents = RpcApi.JarvisRunEventsCommand.bind(RpcApi);
        const landed = ${JSON.stringify(landed)};
        const runIds = ${JSON.stringify([leadRun.run.oid, landedRun.run.oid])};
        RpcApi.JarvisRunEventsCommand = async (client, data, opts) =>
            data?.runid === landed.runid ? { events: [landed] } : runIds.includes(data?.runid) ? { events: [] } : realEvents(client, data, opts);
        fx.orefs = runIds.map((id) => "run:" + id).concat(${JSON.stringify([leadRun.dag.oid, landedRun.dag.oid])}.map((id) => "dag:" + id));
        if (!("terminals" in fx)) fx.terminals = model.terminalsAtom;
        fx.termAtom = fixedAtom([${JSON.stringify(terminal)}]);
        model.terminalsAtom = fx.termAtom;
        return true;
    `);
}

export async function steps(h, ctx) {
    const out = [];
    const leadRun = fixtureRun({ tasks: [{ id: "t-1", state: "done" }, { id: "t-2", state: "running" }] });
    const landedRun = fixtureRun({ tasks: [{ id: "t-1", state: "done" }] });
    leadRun.dag.title = "Fixture now run";
    landedRun.dag.title = "Fixture landed run";
    const plain = agent(ctx, "fx-now-agent", { activity: "Editing pkg/orchestrate/spawn.go" });
    const lead = agent(ctx, "fx-now-lead", { runId: leadRun.run.oid });
    const finisher = agent(ctx, "fx-now-finisher", { activity: "Put Behind you in a second column" });
    const landedLead = agent(ctx, "fx-now-landed-lead", { state: "idle", idleSince: Date.now() - 60_000, runId: landedRun.run.oid });
    try {
        await install(h, ctx, { leadRun, landedRun });
        await installRuns(h, [leadRun, landedRun]);
        await closeOverview(h);

        // Main board, Running: an agent, a run and a terminal, each with its line
        await nowEval(h, `await setRoster(${JSON.stringify([plain, lead])}); return true;`);
        const opened = await openOverview(h, ctx.project);
        const running = await nowEval(h, `
            await until(() => rows("Running").length === 3, 8000);
            await nap(300);
            return { rows: rows("Running"), finished: rows("Finished, not read yet") };
        `);
        await shot(h, "now-running");
        const byKind = Object.fromEntries((running?.rows ?? []).map((r) => [r.kind, r]));
        out.push({
            step: "project-overview: Main board, now: Running lists an agent, a run and a terminal with their lines",
            ok:
                opened?.shown === true &&
                running?.rows?.map((r) => r.kind).join(",") === "agent,run,terminal" &&
                byKind.agent?.name === plain.name &&
                byKind.agent.line === plain.activity &&
                byKind.agent.age === "12m" &&
                byKind.run?.name === "Fixture now run" &&
                byKind.run.line === "1 at work · 1/2 tasks" &&
                byKind.terminal?.name === "dev server" &&
                byKind.terminal.line === "task dev",
            detail: JSON.stringify(running),
        });

        // Main board, Running: the run row lands on its card on the Cockpit and closes the modal
        // from Usage, not Agent: the Agent surface would mount the fixture agent's missing block, whose start error
        // reads as idle and records a finish the Finished step does not expect
        const ranRun = await nowEval(h, `
            S.globalStore.set(model.surfaceAtom, "usage");
            await nap(300);
            rowButton("Running", "Fixture now run")?.click();
            const gone = await until(() => overview() == null, 4000);
            return { gone, surface: S.globalStore.get(model.surfaceAtom), cursor: S.globalStore.get(model.cursorIdAtom) };
        `);
        await shot(h, "now-run-opened");
        const reopenedRun = await openOverview(h, ctx.project);
        out.push({
            step: "project-overview: Main board, now: a Running run row opens its card on the Cockpit and closes the modal",
            ok: ranRun?.gone === true && ranRun.surface === "cockpit" && ranRun.cursor === lead.id && reopenedRun?.shown === true,
            detail: JSON.stringify({ ranRun, reopenedRun }),
        });

        // Main board, Finished: an agent that goes working -> idle, with no reload, shows unread
        const finished = await nowEval(h, `
            await setRoster(${JSON.stringify([plain, lead, finisher])});
            await nap(400);
            await setRoster(${JSON.stringify([plain, lead, { ...finisher, state: "idle", idleSince: Date.now() }])});
            const shown = await until(() => rowButton("Finished, not read yet", ${JSON.stringify(finisher.name)}) != null, 6000);
            await nap(300);
            return { shown, rows: rows("Finished, not read yet") };
        `);
        await shot(h, "now-finished");
        const clicked = await nowEval(h, `
            rowButton("Finished, not read yet", ${JSON.stringify(finisher.name)})?.click();
            const gone = await until(() => overview() == null, 4000);
            const landed = await until(() => S.globalStore.get(model.surfaceAtom) === "agent", 4000);
            return { gone, landed, focus: S.globalStore.get(model.focusIdAtom) };
        `);
        const reopenedAgent = await openOverview(h, ctx.project);
        const fin = (finished?.rows ?? []).find((r) => r.name === finisher.name);
        out.push({
            step: "project-overview: Main board, now: an agent's finish shows under Finished, not read, and opens it on the Agent surface",
            ok:
                finished?.shown === true &&
                fin?.kind === "agent" &&
                finished.rows.length === 1 &&
                fin.line === finisher.activity &&
                clicked?.gone === true &&
                clicked.landed === true &&
                clicked.focus === finisher.id &&
                reopenedAgent?.shown === true,
            detail: JSON.stringify({ finished, clicked, reopenedAgent }),
        });

        // Main board, Finished: a run's landed task loads through the region itself, with the Cockpit unmounted
        const landedRow = await nowEval(h, `
            S.globalStore.set(model.surfaceAtom, "usage");
            const unmounted = await until(() => document.querySelector("[data-cockpit-surface]") == null, 4000);
            await setRoster(${JSON.stringify([plain, lead, landedLead])});
            const shown = await until(() => rowButton("Finished, not read yet", "Fixture landed run") != null, 8000);
            await nap(300);
            return { unmounted, shown, rows: rows("Finished, not read yet") };
        `);
        await shot(h, "now-landed");
        const land = (landedRow?.rows ?? []).find((r) => r.name === "Fixture landed run");
        out.push({
            step: "project-overview: Main board, now: a run's landed task shows under Finished, not read, with the Cockpit unmounted",
            ok: landedRow?.unmounted === true && landedRow.shown === true && land?.kind === "run",
            detail: JSON.stringify(landedRow),
        });

        // Quiet board: nothing runs and nothing finished unread collapses into one Now
        const quiet = await nowEval(h, `
            model.terminalsAtom = fixedAtom([]);
            await setRoster([]);
            const said = () => region()?.querySelector('section[aria-label="Now"]');
            const shown = await until(() => said() != null, 6000);
            await nap(300);
            return { shown, head: flat(said()?.firstElementChild), text: flat(said()?.querySelector("p")), rows: region()?.querySelectorAll("[data-overview-now-row]").length };
        `);
        await shot(h, "now-quiet");
        out.push({
            step: "project-overview: Quiet board, now: an empty project reads 'Nothing runs in <project>.'",
            ok: quiet?.shown === true && quiet.head === "Now" && quiet.text === `Nothing runs in ${ctx.project}.` && quiet.rows === 0,
            detail: JSON.stringify(quiet),
        });
    } finally {
        await cleanup(h, ctx).catch(() => {});
        await nowEval(h, `S.globalStore.set(model.surfaceAtom, "cockpit"); return true;`).catch(() => {});
        if ((await pageEval(h, `return overview() != null;`).catch(() => false)) !== true) {
            await openOverview(h, ctx.project).catch(() => {});
        }
    }
    return out;
}

// idempotent: the steps' finally and the scenario's teardown both call it
export async function cleanup(h, _ctx) {
    await nowEval(h, `
        if (window.__overviewNowFx == null) return true;
        const WOS = await mod("app/store/wos.ts");
        const rail = await mod("app/view/agents/cockpiteventsrail.tsx");
        if ("mock" in fx) S.globalStore.set(D.devMockAgentsAtom, fx.mock);
        for (const [k, desc] of Object.entries(fx.rpc ?? {})) {
            if (desc) Object.defineProperty(RpcApi, k, desc);
            else delete RpcApi[k];
        }
        if (fx.terminals) model.terminalsAtom = fx.terminals;
        for (const oref of fx.orefs ?? []) {
            window.__sessionsFixtureHeld?.[oref]?.();
            delete window.__sessionsFixtureHeld?.[oref];
            WOS.getWaveObjectValue(oref).pendingPromise = null;
            await WOS.reloadWaveObject(oref).catch(() => {});
        }
        // the fixture finish would otherwise sit in the rail until a reload
        S.globalStore.set(rail.agentEventsAtom, (prev) => prev.filter((e) => !String(e.focusId ?? "").startsWith("fx-now-")));
        delete window.__overviewNowFx;
        return true;
    `);
}
