// The project Overview's History region (frontend/app/view/agents/projecthistory.tsx), checked inside the scenario
// scenarios-project-overview.mjs. It starts and ends with the modal open on ctx.project, restores in a finally
// whatever it installed, and names its steps "project-overview: <Board> board, history: <state>".
import { randomUUID } from "node:crypto";
import { closeOverview, openOverview, pageEval, shot } from "./project-overview-kit.mjs";
import { failRpc, releaseRpc } from "./scenarios-shared.mjs";
import {
    fixtureSession,
    holdArchiveRead,
    installSessions,
    releaseArchiveRead,
    restoreArchiveRead,
    restoreSessions,
} from "./sessions-page-fixtures.mjs";

const MIN = 60_000;
const DAY = 86_400_000;
const PAGE = 30;
const MANY = 40;

// the page side: the archive store, the object store, the region and its rows
const HLIB = `
    const store = await mod("app/view/agents/sessionsarchivestore.ts");
    const WOS = await mod("app/store/wos.ts");
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    const region = () => overview()?.querySelector('[data-overview-region="history"]');
    const head = () => [...(region()?.querySelector("div")?.children ?? [])].map(flat).filter(Boolean).join(" | ");
    const rowKeys = () => [...(region()?.querySelectorAll("[data-history-session], [data-history-run]") ?? [])].map((b) =>
        b.hasAttribute("data-history-session") ? "s:" + b.getAttribute("data-history-session") : (b.hasAttribute("data-history-nested") ? "nested:" : "run:") + b.getAttribute("data-history-run"));
    const search = () => region()?.querySelector('input[aria-label="Search this project\\'s history"]');
    const alerts = () => [...(region()?.querySelectorAll('[role="alert"]') ?? [])].map(flat);
    const typeInto = (el, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
    };
`;
const hEval = (h, body) => pageEval(h, `${HLIB} ${body}`);

// the run fixtures, built in the page against the project's own channel so opening one finds a sheet. Each is held
// in the object store as loaded, so openTarget's load resolves; GetChannelRunsCommand answers them.
function installRuns(h, ctx, runs) {
    return hEval(h, `
        const row = S.globalStore.get(ps.projectListAtom).find((r) => r.name === ${JSON.stringify(ctx.project)});
        const channel = row?.channel?.oid ?? "";
        const runs = ${JSON.stringify(runs)}.map((r) => ({
            otype: "run", oid: r.id, version: 1, meta: {}, workspaceid: "", projectpath: ${JSON.stringify(ctx.dir)},
            phases: [], status: "done", channeloid: channel, ...r,
        }));
        for (const r of runs) {
            const wov = WOS.getWaveObjectValue("run:" + r.oid);
            wov.pendingPromise = null;
            S.globalStore.set(wov.dataAtom, { value: r, loading: false, error: false });
            (window.__historyHeldRuns ??= new Set()).add("run:" + r.oid);
        }
        RpcApi.GetChannelRunsCommand = async () => ({ runs });
        return channel !== "";
    `);
}

async function restoreRuns(h) {
    await releaseRpc(h, "GetChannelRunsCommand");
    await hEval(h, `
        delete RpcApi.GetChannelRunsCommand;
        for (const oref of window.__historyHeldRuns ?? []) await WOS.reloadWaveObject(oref).catch(() => {});
        delete window.__historyHeldRuns;
    `);
}

// swaps the dev mock roster, keeping the one it replaced for restoreMockRoster
function setMockRoster(h, roster) {
    return hEval(h, `
        const D = await mod("app/view/agents/devmock.ts");
        if (!("__historyMock" in window)) window.__historyMock = S.globalStore.get(D.devMockAgentsAtom);
        S.globalStore.set(D.devMockAgentsAtom, ${JSON.stringify(roster)});
        await nap(600);
        return true;
    `);
}

function restoreMockRoster(h) {
    return hEval(h, `
        if (!("__historyMock" in window)) return true;
        const D = await mod("app/view/agents/devmock.ts");
        S.globalStore.set(D.devMockAgentsAtom, window.__historyMock);
        delete window.__historyMock;
        return true;
    `);
}

// reopening remounts the region, which reads the runs and the archive again
async function reopen(h, ctx) {
    await closeOverview(h);
    return openOverview(h, ctx.project);
}

function settled(h) {
    return hEval(h, `
        const ok = await until(() => region() != null && region().querySelector(".animate-pulse") == null, 8000);
        await nap(300);
        return ok;
    `);
}

export async function steps(h, ctx) {
    const out = [];
    const step = (name, ok, detail) =>
        out.push({ step: `project-overview: ${name}`, ok, detail: JSON.stringify(detail) });
    const now = Date.now();
    const at = (ms) => ({ lastactivets: now - ms, startedts: now - ms - 30 * MIN });
    const mine = { projectpath: ctx.dir, projectname: ctx.project };
    const recent = fixtureSession({ ...mine, ...at(5 * MIN), task: "History recent session" });
    const origin = fixtureSession({ ...mine, ...at(30 * MIN), task: "History origin session" });
    const older = fixtureSession({ ...mine, ...at(DAY), task: "History older session", runtime: "pi" });
    const stale = fixtureSession({ ...mine, ...at(31 * DAY), task: "History stale session" });
    const sessions = [recent, origin, older, stale];
    const runs = [
        {
            id: randomUUID(),
            goal: "History nested run",
            createdts: now - 20 * MIN,
            // the origin's transcript spelled with other slashes and case: it still nests
            origintranscript: origin.transcriptpath.replace(/\\/g, "/").toUpperCase(),
            land: { state: "landed" },
        },
        // an orchestrator run, so a lead in the roster puts it in the lineage (runRoleOf) and it gets a Cockpit card
        { id: randomUUID(), goal: "History cockpit run", createdts: now - 3 * 60 * MIN, mode: "orchestrator" },
        { id: randomUUID(), goal: "History cancelled run", createdts: now - 2 * DAY, status: "cancelled" },
    ];
    const [nested, cockpit, cancelled] = runs;
    try {
        await installSessions(h, sessions);
        const channel = await installRuns(h, ctx, runs);
        await reopen(h, ctx);
        await settled(h);

        // Main board: newest first, a run nested under its origin, a top-level cockpit run, a cancelled run's warn
        const main = await hEval(h, `
            return {
                head: head(),
                rows: rowKeys(),
                cancelledLine: flat(region().querySelector('[data-history-run="${cancelled.id}"]')),
                warnClass: region().querySelector('[data-history-run="${cancelled.id}"] .text-warning')?.textContent ?? null,
                nestedLine: flat(region().querySelector('[data-history-run="${nested.id}"]')),
                sessionLine: flat(region().querySelector('[data-history-session="claude:${recent.id}"]')),
                link: flat([...region().querySelectorAll("button")].pop()),
            };
        `);
        await shot(h, "history-main");
        const wantRows = [
            `s:claude:${recent.id}`,
            `s:claude:${origin.id}`,
            `nested:${nested.id}`,
            `run:${cockpit.id}`,
            `s:pi:${older.id}`,
            `run:${cancelled.id}`,
        ];
        step(
            "Main board, history: sessions newest first, a run nested under its origin, a top-level run, a cancelled warn",
            channel === true &&
                main?.head === "History | 3 sessions | last 30 days" &&
                JSON.stringify(main.rows) === JSON.stringify(wantRows) &&
                main.warnClass === " · cancelled" &&
                // a cancelled run with no dag names the cancel once
                main.cancelledLine.includes("run · cancelled") &&
                !main.cancelledLine.includes("cancelled · cancelled") &&
                main.nestedLine.includes("run · merged") &&
                main.sessionLine.includes("claude · 9m · 1k tokens") &&
                main.link === "older sessions in Sessions ↗",
            { channel, ...main, wantRows }
        );

        // "/" with focus in the modal focuses the search; typing narrows; no match says so; clearing restores
        const searched = await hEval(h, `
            const body = overview().querySelector("[data-overview-body]");
            body.tabIndex = -1;
            body.focus();
            body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
            const focused = document.activeElement === search();
            typeInto(search(), "nested");
            await until(() => rowKeys().length === 2, 3000);
            const narrowed = rowKeys();
            typeInto(search(), "zzq.none");
            await until(() => rowKeys().length === 0, 3000);
            const none = flat(region().querySelector("p"));
            return { focused, narrowed, none };
        `);
        await shot(h, "history-search-none");
        const cleared = await hEval(h, `
            typeInto(search(), "");
            await until(() => rowKeys().length === ${wantRows.length}, 3000);
            return rowKeys().length;
        `);
        step(
            "Main board, history: '/' focuses the search, typing narrows, no match says so, clearing restores",
            searched?.focused === true &&
                JSON.stringify(searched.narrowed) === JSON.stringify([`s:claude:${origin.id}`, `nested:${nested.id}`]) &&
                searched.none === "No sessions match “zzq.none”." &&
                cleared === wantRows.length,
            { ...searched, cleared }
        );

        // loading: the archive read held, with nothing loaded yet, draws skeleton lines
        await holdArchiveRead(h, []);
        const loading = await hEval(h, `
            window.__sessionsFixtureArchiveHold?.();
            delete window.__sessionsFixtureArchiveHold;
            S.globalStore.set(store.sessionsArchiveAtom, null);
            store.loadSessionsArchive();
            const skeleton = await until(() => region()?.querySelector(".animate-pulse") != null && rowKeys().length === 0, 3000);
            return { skeleton };
        `);
        await shot(h, "history-loading");
        await releaseArchiveRead(h);
        const loaded = await hEval(h, `return await until(() => rowKeys().length === ${wantRows.length}, 5000);`);
        step("Main board, history: loading shows skeleton lines while the archive read is held", loading?.skeleton === true && loaded === true, {
            ...loading,
            loaded,
        });
        await installSessions(h, sessions);

        // a session row lands on Sessions with it selected and the modal closed
        const toSession = await hEval(h, `
            region().querySelector('[data-history-session="claude:${origin.id}"]').click();
            const gone = await until(() => overview() == null, 4000);
            await until(() => S.globalStore.get(model.surfaceAtom) === "sessions", 3000);
            return { gone, surface: S.globalStore.get(model.surfaceAtom), sel: S.globalStore.get(model.sessionsSelAtom) };
        `);
        await shot(h, "history-to-session");
        step(
            "Main board, history: a session row opens Sessions with it selected, the modal closed",
            toSession?.gone === true && toSession.surface === "sessions" && toSession.sel === `claude:${origin.id}`,
            toSession
        );
        await openOverview(h, ctx.project);
        await settled(h);

        // a run row opens the run's card on the Cockpit, the modal closed. The card is its lead's, so the run gets a
        // lead in the dev mock roster: a run with no member in the roster has no card, and the Cockpit drops the cursor
        const lead = {
            id: "fx-history-lead", name: "fx-history-lead", project: ctx.project, task: "Fixture task", state: "working",
            agent: "claude", model: "opus", activeMs: 5 * MIN, blockId: "blk-fx-history-lead", runId: cockpit.id,
        };
        await setMockRoster(h, [lead]);
        const toRun = await hEval(h, `
            const before = S.globalStore.get(model.surfaceAtom);
            region().querySelector('[data-history-run="${cockpit.id}"]').click();
            const gone = await until(() => overview() == null, 4000);
            await until(() => S.globalStore.get(model.surfaceAtom) === "cockpit", 4000);
            return { gone, before, surface: S.globalStore.get(model.surfaceAtom), cursor: S.globalStore.get(model.cursorIdAtom) };
        `);
        await shot(h, "history-to-run");
        step(
            "Main board, history: a run row opens the run's card on the Cockpit, the modal closed",
            toRun?.gone === true && toRun.before === "sessions" && toRun.surface === "cockpit" && toRun.cursor === lead.id,
            toRun
        );
        await restoreMockRoster(h);
        await openOverview(h, ctx.project);
        await settled(h);

        // an ended run (no member in the roster, so out of the lineage) has no Cockpit card: its row opens the run's
        // sheet on the Hub and leaves the Cockpit cursor where it was
        const toSheet = await hEval(h, `
            const cursorBefore = S.globalStore.get(model.cursorIdAtom);
            region().querySelector('[data-history-run="${cancelled.id}"]').click();
            const gone = await until(() => overview() == null, 4000);
            await until(() => S.globalStore.get(model.surfaceAtom) === "jarvis", 4000);
            return {
                gone,
                surface: S.globalStore.get(model.surfaceAtom),
                cursorBefore,
                cursor: S.globalStore.get(model.cursorIdAtom),
            };
        `);
        await shot(h, "history-to-run-sheet");
        step(
            "Main board, history: an ended run's row opens its sheet on the Hub, the modal closed",
            toSheet?.gone === true && toSheet.surface === "jarvis" && toSheet.cursor === toSheet.cursorBefore,
            toSheet
        );
        await openOverview(h, ctx.project);
        await settled(h);

        // "older sessions in Sessions ↗" lands on Sessions
        const toSessions = await hEval(h, `
            S.globalStore.set(model.surfaceAtom, "cockpit");
            await nap(200);
            [...region().querySelectorAll("button")].find((b) => flat(b) === "older sessions in Sessions ↗").click();
            const gone = await until(() => overview() == null, 4000);
            await until(() => S.globalStore.get(model.surfaceAtom) === "sessions", 3000);
            return { gone, surface: S.globalStore.get(model.surfaceAtom) };
        `);
        await shot(h, "history-to-sessions");
        step(
            "Main board, history: 'older sessions in Sessions ↗' opens Sessions, the modal closed",
            toSessions?.gone === true && toSessions.surface === "sessions",
            toSessions
        );
        await openOverview(h, ctx.project);

        // paging: 40 sessions render 30, and scrolling the history list to the end renders more
        const many = Array.from({ length: MANY }, (_, i) =>
            fixtureSession({ ...mine, ...at((i + 1) * 10 * MIN), task: `History paged session ${i + 1}` })
        );
        await installSessions(h, many);
        await installRuns(h, ctx, []);
        await reopen(h, ctx);
        await settled(h);
        const paged = await hEval(h, `
            const first = rowKeys().length;
            const list = region().querySelector("[data-history-list]");
            for (let i = 0; i < 10 && rowKeys().length <= ${PAGE}; i++) {
                list.scrollTop = list.scrollHeight;
                await nap(250);
            }
            return { first, after: rowKeys().length };
        `);
        await shot(h, "history-paged");
        step(
            "Main board, history: 40 sessions render 30, scrolling to the end renders more",
            paged?.first === PAGE && paged.after === MANY,
            paged
        );

        // Quiet board: no sessions in the window
        await installSessions(h, [stale]);
        await reopen(h, ctx);
        await settled(h);
        const quiet = await hEval(h, `return { head: head(), note: flat(region().querySelector("p")), rows: rowKeys().length, search: search() != null };`);
        await shot(h, "history-quiet");
        step(
            "Quiet board, history: no sessions says so and counts 0 sessions",
            quiet?.head === "History | 0 sessions | last 30 days" &&
                quiet.note === `No sessions in ${ctx.project} in the last 30 days.` &&
                quiet.rows === 0 &&
                quiet.search === false,
            quiet
        );

        // Failures board: a failing runs read alerts above the sessions, which still list
        await installSessions(h, sessions);
        await failRpc(h, "GetChannelRunsCommand", "runs store unavailable");
        await reopen(h, ctx);
        await settled(h);
        const runsFailed = await hEval(h, `return { alerts: alerts(), rows: rowKeys() };`);
        await shot(h, "history-runs-failed");
        await releaseRpc(h, "GetChannelRunsCommand");
        step(
            "Failures board, history: a failing runs read alerts, and the sessions still list",
            runsFailed?.alerts.length === 1 &&
                runsFailed.alerts[0] === "Could not read runs, so sessions show without them. runs store unavailableRetry" &&
                JSON.stringify(runsFailed.rows) === JSON.stringify([`s:claude:${recent.id}`, `s:claude:${origin.id}`, `s:pi:${older.id}`]),
            runsFailed
        );

        // Failures board: a failing archive read alerts
        await failRpc(h, "GetSessionsActivityCommand", "archive unavailable");
        const archiveFailed = await hEval(h, `
            await store.loadSessionsArchive();
            await until(() => alerts().some((a) => a.startsWith("Could not read sessions.")), 3000);
            return { alerts: alerts() };
        `);
        await shot(h, "history-sessions-failed");
        await releaseRpc(h, "GetSessionsActivityCommand");
        step(
            "Failures board, history: a failing archive read shows the sessions alert",
            archiveFailed?.alerts.includes("Could not read sessions.Retry"),
            archiveFailed
        );
    } finally {
        await cleanup(h, ctx);
        await reopen(h, ctx).catch(() => {});
    }
    return out;
}

export async function cleanup(h, _ctx) {
    await releaseRpc(h, "GetSessionsActivityCommand").catch(() => {});
    await restoreMockRoster(h).catch(() => {});
    await restoreRuns(h).catch(() => {});
    await restoreArchiveRead(h).catch(() => {});
    await restoreSessions(h).catch(() => {});
}
