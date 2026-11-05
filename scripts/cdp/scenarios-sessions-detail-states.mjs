// The Sessions detail's states, on in-page fixture sessions and transcripts (nothing is written to disk).
// kit holds scenarios-shared.mjs's sessions helpers (SESSIONS_KIT); the fixtures are in sessions-page-fixtures.mjs.
//
// Each step selects its fixture through the app's own model (the cockpit route's), then reads the detail pane. The
// live step adds a fixture agent to the dev roster (devMockAgentsAtom) whose transcriptPath is a fixture session's,
// so the surface overlays that session as live.

import { randomUUID } from "node:crypto";
import {
    fixtureRun,
    fixtureSession,
    installRuns,
    installSessions,
    restoreSessions,
    setTranscript,
    stubTranscripts,
} from "./sessions-page-fixtures.mjs";

const NAME = "sessions-detail-states";
// more than the 2,000-line tail, so the tail comes back full and the first prompt is cut
const LONG_LINES = 2_400;
const RUN_TASKS = 12;
const DAY_MS = 86_400_000;
const NARROW_VIEWPORT = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const WIDE_VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const MIN_TITLE_WIDTH = 300;
const WAIT_MS = 10_000;
// the live refetch runs every 5s (LIVE_REFRESH_MS); two rounds of it
const LIVE_WAIT_MS = 12_000;
// the toast lives 6s (TOAST_TTL_MS), so it is read well inside that
const TOAST_WAIT_MS = 4_000;

// the app's module instance at path (under frontend/), the model the cockpit's UI route serves, and a poll
const PAGE_LIB = `
    const mod = async (path) => {
        const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
        const hit = names.filter((n) => n.endsWith("/" + path)).pop();
        const base = names.find((n) => n.endsWith("/app/store/jotaiStore.ts"));
        if (hit == null && base == null) throw new Error("no app module url for " + path);
        return import(hit ?? base.replace("app/store/jotaiStore.ts", path));
    };
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const model = (await mod("app/store/wshrpcutil.ts")).DefaultRouter.routeMap.get("cockpit")?.model;
    if (model == null) throw new Error("the cockpit route serves no model");
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = ${WAIT_MS}) => {
        for (const t0 = Date.now(); Date.now() - t0 < ms; await nap(150)) if (fn()) return true;
        return !!fn();
    };
    const text = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
`;
const page = (h, body) => h.ev(`(async () => { ${PAGE_LIB} ${body} })()`);

// selects sel (a session key or run:<id>) with member in view and the view (transcript | activity), then waits for
// the session body keyed bodyKey
const open = (h, { sel, member, view, bodyKey }) =>
    page(
        h,
        `
        globalStore.set(model.sessionsViewAtom, ${JSON.stringify(view)});
        globalStore.set(model.sessionsSelAtom, ${JSON.stringify(sel)});
        await nap(200);
        ${member ? `globalStore.set(model.sessionsMemberAtom, ${JSON.stringify(member)});` : ""}
        return until(() => document.querySelector('[data-session-key=${JSON.stringify(bodyKey)}]') != null);
    `
    );

// the session body keyed key and the pane around it (the solo detail, or the run member's pane)
const BODY = (key) => `
    const body = document.querySelector('[data-session-key=${JSON.stringify(key)}]');
    const pane = body?.parentElement;
`;

const keyOf = (s) => `claude:${s.id}`;
const userLine = (content) => JSON.stringify({ type: "user", message: { content } });
const replyLine = (t) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const toolLine = (i) =>
    JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: `tu-${i}`, name: "Bash", input: { description: `step ${i}` } }] },
    });

// 09:13 three days ago, so the label carries a date that is not today's
function threeDaysAgo() {
    const d = new Date(Date.now() - 3 * DAY_MS);
    d.setHours(9, 13, 0, 0);
    return d.getTime();
}

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "sessions",
            async arrange(h) {
                const tag = randomUUID().slice(0, 8);
                const now = Date.now();
                const started = threeDaysAgo();
                const { run, dag } = fixtureRun({
                    status: "done",
                    dagStatus: "done",
                    tasks: Array.from({ length: RUN_TASKS }, (_, i) => ({
                        id: `t-${i + 1}`,
                        label: `Fixture task ${i + 1}`,
                        state: "done",
                    })),
                });
                const member = (role, taskid, extra = {}) =>
                    fixtureSession({ task: `Run ${role} ${taskid} ${tag}`, runid: run.oid, role, taskid, ...extra });
                const fx = {
                    waiting: fixtureSession({ task: `Detail waiting ${tag}`, status: "waiting" }),
                    blocked: fixtureSession({
                        task: `Detail cwd gone ${tag}`,
                        resumeblocker: "its working directory C:\\arc-verify-sessions-fixture\\gone no longer exists",
                    }),
                    vanished: fixtureSession({
                        task: `Detail cwd vanished ${tag}`,
                        projectpath: `C:\\arc-verify-sessions-fixture\\vanished-${tag}`,
                    }),
                    long: fixtureSession({ task: `Detail long tail ${tag}` }),
                    dated: fixtureSession({
                        task: `Detail dated ${tag}`,
                        startedts: started,
                        durationms: 3 * 3_600_000,
                        events: [
                            { type: "started", ts: started, text: "Fixture session" },
                            { type: "committed", ts: now - 60_000, text: "Fixture commit" },
                        ],
                    }),
                    // a title longer than any header is wide, so its width is the room the header gives it
                    header: fixtureSession({
                        task: `Detail header ${tag} ${"with a very long task title ".repeat(8)}`,
                        startedts: started,
                        durationms: 3 * 3_600_000,
                    }),
                    pasted: fixtureSession({ task: `Detail pasted ${tag}` }),
                    live: fixtureSession({ task: `Detail live ${tag}` }),
                    failed: fixtureSession({ task: `Detail failed read ${tag}` }),
                    lead: member("lead", ""),
                    runBlocked: member("worker", "t-2", {
                        resumeblocker: "its working directory C:\\arc-verify-sessions-fixture\\gone no longer exists",
                    }),
                    task11: member("worker", "t-11"),
                };
                const firstPrompt = `First prompt ${tag}`;
                const longLines = [
                    userLine(firstPrompt),
                    ...Array.from({ length: LONG_LINES - 2 }, (_, i) => toolLine(i)),
                    replyLine(`Latest reply ${tag}`),
                ];
                const pastedBody = `Pasted body ${tag}`;
                const liveLines = [userLine(`Live prompt ${tag}`), replyLine(`Live reply one ${tag}`)];
                const transcripts = {
                    [fx.long.transcriptpath]: { lines: longLines },
                    [fx.pasted.transcriptpath]: {
                        lines: [
                            userLine(`<pasted_content id="p1">\n${pastedBody}\n</pasted_content id="p1">`),
                            replyLine(`Read it ${tag}`),
                        ],
                    },
                    [fx.live.transcriptpath]: { lines: liveLines },
                    [fx.failed.transcriptpath]: { error: `fixture read failure ${tag}` },
                };
                for (const s of [fx.waiting, fx.blocked, fx.vanished, fx.dated, fx.header, fx.lead, fx.runBlocked, fx.task11]) {
                    transcripts[s.transcriptpath] = { lines: [userLine(s.task), replyLine(`Reply ${tag}`)] };
                }
                await installSessions(h, Object.values(fx));
                await installRuns(h, [{ run, dag }]);
                await stubTranscripts(h, transcripts);
                return { fx, tag, run, firstPrompt, pastedBody, liveLines };
            },
            async assert(h, { fx, tag, run, firstPrompt, pastedBody, liveLines }) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: JSON.stringify(detail) });
                const solo = (s, view = "transcript") => open(h, { sel: keyOf(s), view, bodyKey: keyOf(s) });

                // 1. ended waiting
                await solo(fx.waiting);
                const s1 = await page(
                    h,
                    `${BODY(keyOf(fx.waiting))}
                    const card = document.querySelector('[data-session-row=${JSON.stringify(keyOf(fx.waiting))}]');
                    return { card: text(card), detail: text(pane?.firstElementChild) };`
                );
                await h.shot(`cdp-shots/${NAME}-1-waiting.png`);
                rec(
                    "1. an ended waiting session reads needs you on its card and its detail",
                    s1.card.includes("needs you") && s1.detail.includes("needs you"),
                    s1
                );

                // 2. blocked solo
                await solo(fx.blocked);
                const s2 = await page(
                    h,
                    `${BODY(keyOf(fx.blocked))}
                    const b = pane?.querySelector("[data-sessions-resume-blocked]");
                    const btn = b?.querySelector("button");
                    return { blocked: text(b), disabled: btn?.disabled ?? null, button: text(btn) };`
                );
                await h.shot(`cdp-shots/${NAME}-2-blocked.png`);
                rec(
                    "2. a session whose cwd is gone shows a disabled Resume with the reason",
                    s2.disabled === true && s2.button === "Resume" && s2.blocked.includes(fx.blocked.resumeblocker),
                    s2
                );

                // 3. blocked run member
                const runSel = `run:${run.oid}`;
                await open(h, { sel: runSel, member: "t-2", view: "transcript", bodyKey: keyOf(fx.runBlocked) });
                const s3 = await page(
                    h,
                    `${BODY(keyOf(fx.runBlocked))}
                    const b = pane?.querySelector("[data-sessions-resume-blocked]");
                    const btn = b?.querySelector("button");
                    return { blocked: text(b), disabled: btn?.disabled ?? null, button: text(btn) };`
                );
                await h.shot(`cdp-shots/${NAME}-3-run-blocked.png`);
                rec(
                    "3. a run member whose cwd is gone shows a disabled Resume with the reason",
                    s3.disabled === true && s3.button === "Resume" && s3.blocked.includes(fx.runBlocked.resumeblocker),
                    s3
                );

                // 4. the run header
                const s4 = await page(
                    h,
                    `const btn = [...document.querySelectorAll("button")].find((b) => text(b) === "Open run sheet");
                    const header = btn?.parentElement?.parentElement;
                    return { button: btn != null, header: text(header) };`
                );
                rec(
                    "4. the run detail's button reads Open run sheet, and a finished run's head reads done · <age> ago",
                    s4.button && /done · .+ ago/.test(s4.header),
                    s4
                );

                // 5. task 11 of 12 kept in view
                await page(h, `globalStore.set(model.sessionsMemberAtom, "t-11"); await nap(400);`);
                const s5 = await page(
                    h,
                    `const row = document.querySelector('[data-sessions-member="t-11"]');
                    const box = row?.parentElement?.getBoundingClientRect();
                    const r = row?.getBoundingClientRect();
                    return {
                        current: row?.getAttribute("aria-current") ?? null,
                        scrolled: row?.parentElement?.scrollTop ?? null,
                        inView: r != null && box != null && r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
                    };`
                );
                await h.shot(`cdp-shots/${NAME}-5-member-in-view.png`);
                rec(
                    "5. selecting task 11 of a 12-task run keeps its row in view in the member list",
                    s5.current === "true" && s5.inView && s5.scrolled > 0,
                    s5
                );

                // 6. Resume on a session whose cwd vanished after loading
                await solo(fx.vanished);
                const s6 = await page(
                    h,
                    `${BODY(keyOf(fx.vanished))}
                    const { atoms } = await mod("app/store/global-atoms.ts");
                    const tabs = () => globalStore.get(atoms.workspace)?.tabids?.length ?? null;
                    const toasts = () => [...document.querySelectorAll('[data-notification-toast="error"]')].map(text);
                    const tabsBefore = tabs();
                    const btn = [...(pane?.querySelectorAll("button") ?? [])].find((b) => text(b) === "Resume →");
                    btn?.click();
                    await until(() => toasts().length > 0, ${TOAST_WAIT_MS});
                    await nap(300);
                    return { clicked: btn != null, toasts: toasts(), surface: globalStore.get(model.surfaceAtom), tabsBefore, tabsAfter: tabs() };`
                );
                await h.shot(`cdp-shots/${NAME}-6-vanished-toast.png`);
                const reason = `Working directory no longer exists: ${fx.vanished.projectpath}`;
                rec(
                    "6. Resume on a session whose cwd vanished after loading toasts the reason and stays on Sessions",
                    s6.clicked &&
                        s6.toasts.some((t) => t.includes("Couldn't start the agent") && t.includes(reason)) &&
                        s6.surface === "sessions" &&
                        s6.tabsBefore != null &&
                        s6.tabsAfter === s6.tabsBefore,
                    s6
                );

                // 7. the long tail and Show earlier turns
                await solo(fx.long);
                const s7 = await page(
                    h,
                    `${BODY(keyOf(fx.long))}
                    const want = ${JSON.stringify(firstPrompt)};
                    await until(() => body.querySelector("[data-sessions-earlier]") != null);
                    const before = { earlier: body.querySelector("[data-sessions-earlier]") != null, first: text(body).includes(want) };
                    body.scrollTop = 0;
                    await nap(150);
                    body.querySelector("[data-sessions-earlier]")?.click();
                    await until(() => text(body).includes(want));
                    const calls = (window.__sessionsFixtureCalls ?? []).filter((c) => c.path === ${JSON.stringify(fx.long.transcriptpath)}).map((c) => c.maxlines);
                    return { before, calls, first: text(body).includes(want), earlier: body.querySelector("[data-sessions-earlier]") != null };`
                );
                await h.shot(`cdp-shots/${NAME}-7-earlier.png`);
                rec(
                    "7. a 2,000-line tail shows Show earlier turns, and clicking it fetches the whole file and shows the first prompt",
                    s7.before.earlier &&
                        !s7.before.first &&
                        s7.calls[0] === 2000 &&
                        s7.calls.includes(-1) &&
                        s7.first &&
                        !s7.earlier,
                    s7
                );

                // 8. meta and Activity dates
                await solo(fx.dated, "activity");
                const s8 = await page(
                    h,
                    `${BODY(keyOf(fx.dated))}
                    const { startedLabel, eventTime } = await mod("app/view/agents/sessionstime.ts");
                    const { formatAgeShort } = await mod("app/view/agents/agentsviewmodel.ts");
                    const now = Date.now();
                    await until(() => body.querySelector("[data-sessions-event-time]") != null);
                    const events = ${JSON.stringify(fx.dated.events)};
                    return {
                        meta: text(pane?.firstElementChild),
                        wantStarted: "started " + startedLabel(${fx.dated.startedts}, now),
                        wantRan: "ran " + formatAgeShort(${fx.dated.durationms}),
                        times: [...body.querySelectorAll("[data-sessions-event-time]")].map(text),
                        wantTimes: events.map((e) => eventTime(e.ts, now)),
                    };`
                );
                await h.shot(`cdp-shots/${NAME}-8-dated.png`);
                rec(
                    "8. the meta reads started <date> and ran <n>",
                    s8.meta.includes(s8.wantStarted) && s8.meta.includes(s8.wantRan),
                    { meta: s8.meta, wantStarted: s8.wantStarted, wantRan: s8.wantRan }
                );
                rec(
                    "9. an Activity row from another day carries its date",
                    JSON.stringify(s8.times) === JSON.stringify(s8.wantTimes) && s8.times[0] !== s8.times[0].slice(-5),
                    { times: s8.times, wantTimes: s8.wantTimes }
                );

                // 10. pasted_content
                await solo(fx.pasted);
                const s10 = await page(
                    h,
                    `${BODY(keyOf(fx.pasted))}
                    await until(() => text(body).includes(${JSON.stringify(pastedBody)}));
                    return { shows: text(body).includes(${JSON.stringify(pastedBody)}), tags: text(body).includes("pasted_content") };`
                );
                await h.shot(`cdp-shots/${NAME}-10-pasted.png`);
                rec("10. a pasted_content prompt shows without its tags", s10.shows && !s10.tags, s10);

                // 11. a live session's transcript grows
                const agent = {
                    id: randomUUID(),
                    name: "fixture",
                    task: fx.live.task,
                    state: "working",
                    agent: "claude",
                    project: fx.live.projectname,
                    transcriptPath: fx.live.transcriptpath,
                };
                await page(
                    h,
                    `const dm = await mod("app/view/agents/devmock.ts");
                    if (!("__sessionsDetailRoster" in window)) window.__sessionsDetailRoster = globalStore.get(dm.devMockAgentsAtom);
                    globalStore.set(dm.devMockAgentsAtom, [...globalStore.get(dm.devRosterAtom), ${JSON.stringify(agent)}]);`
                );
                await solo(fx.live);
                const appended = `Live reply two ${tag}`;
                const first = await page(
                    h,
                    `${BODY(keyOf(fx.live))}
                    return until(() => text(body).includes(${JSON.stringify(`Live reply one ${tag}`)}));`
                );
                await setTranscript(h, fx.live.transcriptpath, { lines: [...liveLines, replyLine(appended)] });
                const s11 = await page(
                    h,
                    `${BODY(keyOf(fx.live))}
                    const grew = await until(() => text(body).includes(${JSON.stringify(appended)}), ${LIVE_WAIT_MS});
                    return { grew, status: text(pane?.firstElementChild) };`
                );
                await h.shot(`cdp-shots/${NAME}-11-live.png`);
                rec(
                    "11. a live session's transcript shows a line appended after it opened",
                    first && s11.grew && s11.status.includes("running"),
                    { first, ...s11 }
                );

                // 12. a failed read
                await solo(fx.failed);
                const s12 = await page(
                    h,
                    `${BODY(keyOf(fx.failed))}
                    await until(() => body.querySelector("[data-sessions-transcript-error]") != null);
                    return text(body.querySelector("[data-sessions-transcript-error]"));`
                );
                await h.shot(`cdp-shots/${NAME}-12-read-error.png`);
                rec(
                    "12. a failed transcript read shows the error with its path",
                    s12.includes("Couldn't read the transcript") &&
                        s12.includes(fx.failed.transcriptpath) &&
                        s12.includes(`fixture read failure ${tag}`),
                    s12
                );

                // 13. the solo header at the narrow and the wide viewport
                const readHeader = () =>
                    page(
                        h,
                        `const header = document.querySelector("[data-sessions-solo-header]");
                        const title = header?.querySelector("h2")?.getBoundingClientRect();
                        const col = header?.querySelector("h2")?.parentElement?.parentElement?.getBoundingClientRect();
                        const meta = header?.querySelector("h2")?.parentElement?.nextElementSibling;
                        const toggle = header?.querySelector('[role="group"][aria-label="Session view"]')?.getBoundingClientRect();
                        const tops = new Set([...(meta?.children ?? [])].map((c) => Math.round(c.getBoundingClientRect().top)));
                        return header == null ? null : {
                            titleWidth: title?.width ?? null,
                            metaLines: tops.size,
                            actionsOnTitleRow: toggle != null && col != null && toggle.top < col.bottom - 1,
                            headerWidth: header.getBoundingClientRect().width,
                        };`
                    );
                try {
                    await h.cdp("Emulation.setDeviceMetricsOverride", NARROW_VIEWPORT);
                    await solo(fx.header);
                    await page(h, `await nap(600);`);
                    const narrow = await readHeader();
                    await h.shot(`cdp-shots/${NAME}-13-header-1000x700.png`);
                    rec(
                        "13. at 1000x700 the solo header's title keeps 300px and its meta takes at most two lines",
                        narrow != null && narrow.titleWidth >= MIN_TITLE_WIDTH && narrow.metaLines <= 2,
                        narrow
                    );
                    await h.cdp("Emulation.setDeviceMetricsOverride", WIDE_VIEWPORT);
                    await page(h, `await nap(600);`);
                    const wide = await readHeader();
                    await h.shot(`cdp-shots/${NAME}-14-header-1600x950.png`);
                    rec(
                        "14. at 1600x950 the solo header's actions sit on the title's row",
                        wide != null && wide.actionsOnTitleRow,
                        wide
                    );
                } finally {
                    await h.cdp("Emulation.clearDeviceMetricsOverride", {});
                }
                return steps;
            },
            async teardown(h) {
                await page(
                    h,
                    `const dm = await mod("app/view/agents/devmock.ts");
                    if ("__sessionsDetailRoster" in window) {
                        globalStore.set(dm.devMockAgentsAtom, window.__sessionsDetailRoster);
                        delete window.__sessionsDetailRoster;
                    }
                    globalStore.set(model.sessionsSelAtom, "all");
                    globalStore.set(model.sessionsViewAtom, "transcript");`
                );
                await restoreSessions(h);
            },
        },
    ];
}
