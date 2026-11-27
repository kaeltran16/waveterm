// Scenario `cockpit-thumbs`: the Cockpit's Grid board (docs/superpowers/specs/2026-11-27-cockpit-rethink-design.md).
// One page-only fixture, the prototype's sessions: a dev roster (setRoster) in all four states, their runs and digests
// in the runs store and the object cache under a fixture channel no server lists, each run's origintranscript set to
// its conductor's transcript path, the waits through the DEV attention seam, the Watching conductor's monitor in
// shellTasksByIdAtom, and its 5-minute timer advanced by writing the wait's escalation track (no 5-minute wait).
// Seeding order matters (cockpitsessionstore.ts): the roster first, so no wait on a loaded run ever reads its
// conductor as gone and latches as yours.
//
// Steps: grid (the Grid board), escalated (the Escalated board and the popup it raises), keys (the Prototype board's
// grid keys), zoom-final, zoom-asks and zoom-watching (the zoomed boards), zoom-keys (the Prototype board's zoom keys).
// Keys are dispatched as keydown events on the surface from page JS: CDP Input.dispatchKeyEvent often never reaches
// the WebView. Each session has a block id no server knows, so its Rendered view mounts in the zoom.

import { agentPage, restoreRoster, setRoster } from "./agent-page-fixtures.mjs";
import { SURFACE_LABEL } from "./attach.mjs";

const NAME = "cockpit-thumbs";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
// DEV_ATTENTION_ITEMS_KEY in frontend/app/view/agents/attentionstore.ts
const DEV_ITEMS_KEY = "wave:dev-attention-items";
const MIN = 60_000;
const DIR = "C:\\arc-verify-cockpit-thumbs";
const CHANNEL = "c7a1e0f2-3b4d-4c5e-8f60-71829a3b4c5d";
const tx = (id) => `${DIR}\\${id}.jsonl`;
const WAIT_MS = 10_000;
// the failed-Final run's dag, so its Run tab draws the Final row its wait sits under
const DAG_FT = "d4f2c19e-1a2b-4c3d-8e4f-5a6b7c8d9e10";
const FT_TASKS = 5;
// earlier turns of the conductor zoomed first, so the zoom is timed with a transcript of some length mounting
const DET_HISTORY_TURNS = 30;
// how long the zoom and the return are sampled for, past their own duration
const MORPH_SAMPLE_MS = 700;

// the prototype's sessions; the last three are quiet at first sight, so they start in the Idle line
const S = {
    det: { id: "cthumbs-det", name: "Detector on ClickHouse", project: "cyber-anomaly-detector" },
    plan: { id: "cthumbs-plan", name: "Plan-skill bench", project: "waveterm" },
    ws: { id: "cthumbs-ws", name: "Workspace pane: Run tab and Final", project: "waveterm" },
    kafka: { id: "cthumbs-kafka", name: "Avro schema cutover", project: "siem" },
    nas: { id: "cthumbs-nas", name: "NAS parser configs", project: "universal-parser-config-generator" },
    next: { id: "cthumbs-next", name: "Next steps for arc", project: "waveterm" },
    mem: { id: "cthumbs-mem", name: "Memory tab usability", project: "waveterm" },
    sub: { id: "cthumbs-sub", name: "Transcript subagents", project: "waveterm" },
    bfs: { id: "cthumbs-bfs", name: "Board forwarder fix", project: "waveterm" },
};
const GRID = ["det", "plan", "ws", "kafka", "nas", "next"];
const IDLE = ["mem", "sub", "bfs"];

const R = {
    ft: { id: "4f2c19e0-1a2b-4c3d-8e4f-5a6b7c8d9e01", title: "Feature tables in ClickHouse", by: "det" },
    dj: { id: "7d01b2aa-1a2b-4c3d-8e4f-5a6b7c8d9e02", title: "Detector job writes shared tables", by: "det" },
    rb: { id: "91a9c3d2-1a2b-4c3d-8e4f-5a6b7c8d9e03", title: "Run B: bench harness", by: "plan" },
    rf: { id: "a0cc84ea-1a2b-4c3d-8e4f-5a6b7c8d9e04", title: "Rework Final in the workspace", by: "ws" },
    rt: { id: "24f874c2-1a2b-4c3d-8e4f-5a6b7c8d9e05", title: "Run tab graph focus", by: "ws" },
    av: { id: "c3e0d917-1a2b-4c3d-8e4f-5a6b7c8d9e06", title: "Avro schema registry cutover", by: "kafka" },
    kf: { id: "1b3d4a7d-1a2b-4c3d-8e4f-5a6b7c8d9e07", title: "Batch of known-cause fixes", by: null },
    mh: { id: "5e136144-1a2b-4c3d-8e4f-5a6b7c8d9e08", title: "Memory hygiene", by: null },
    bfx: { id: "c0aab0ed-1a2b-4c3d-8e4f-5a6b7c8d9e09", title: "Fix the board forwarder roster loop", by: null },
};
const STRIP = ["kf", "mh", "bfx"];

const KEY = { ft: `${NAME}:ft-final`, rf: `${NAME}:rf-ask`, av: `${NAME}:av-plan`, kf: `${NAME}:kf-land` };

function fixture(now) {
    const agent = (k, over) => ({
        id: S[k].id,
        name: S[k].name,
        task: "",
        project: S[k].project,
        agent: "claude",
        transcriptPath: tx(k),
        blockId: `cthumbs-blk-${k}`,
        ...over,
    });
    const roster = [
        agent("det", { state: "idle", idleSince: now - 2 * MIN }),
        agent("plan", {
            state: "asking",
            blockedMs: 6 * MIN,
            ask: {
                questions: [
                    {
                        header: "Mutation scoring",
                        question: "Restart the mutation scoring now?",
                        options: [{ label: "After Rework Final lands" }, { label: "Restart now" }],
                    },
                ],
            },
        }),
        agent("ws", { state: "idle", idleSince: now - 22 * MIN }),
        agent("kafka", { state: "working", activeMs: MIN }),
        agent("nas", { state: "working", activeMs: 4 * MIN }),
        agent("next", { state: "idle", idleSince: now - 25 * MIN }),
        agent("mem", { state: "idle", idleSince: now - 3 * 60 * MIN }),
        agent("sub", { state: "idle", idleSince: now - 20 * 60 * MIN }),
        agent("bfs", { state: "idle", idleSince: now - 40 * MIN }),
    ];
    const user = (text) => ({ kind: "user", text });
    const say = (text) => ({ kind: "message", text });
    const did = (verb, target) => ({ kind: "action", verb, target, outcome: "ok" });
    const doing = (verb, target) => ({ kind: "action", verb, target, pending: true, startedTs: now - 5000 });
    const history = Array.from({ length: DET_HISTORY_TURNS }, (_, i) => [
        user(`check the feature tables, pass ${i + 1}`),
        did("Bash", `wsh runs show 4f2c19e0 --pass ${i + 1}`),
        say(`Pass ${i + 1}: the tables hold, the bench query runs in ${40 + i} s on lab-strong.`),
    ]).flat();
    const entries = {
        det: [
            ...history,
            user("monitor the runs and dispatch after they are finished"),
            did("Bash", "wsh runs show 4f2c19e0 --final"),
            say("Feature tables merged all five tasks, but its Final failed on step 3: the bench query timed out after 120 s on lab-strong."),
            say("Retry the step as it is, or send it back to t-4 with a smaller tenant-day window?"),
        ],
        plan: [
            user("hold the mutation scoring until Run B lands"),
            say("Run B landed at 10:20. The harness is on main and the first 12 cases pass."),
        ],
        ws: [
            user("dispatch a run for this, let the lead write the plan"),
            say("Dispatched it. I'll watch the run and pick up the next chunk when it lands."),
            did("Monitor", "wsh runs wait a0cc84ea --until done"),
        ],
        kafka: [
            user("go ahead with the cutover plan once the lead has it"),
            did("Read", "docs/avro-cutover.md"),
            say("The lead's plan has 4 tasks. Checking the consumer list against it before I approve."),
            doing("Grep", '"value.deserializer" in services/'),
        ],
        nas: [
            user("lets do step 2"),
            say("Generating the nas-31 config and validating it against the sample logs."),
            doing("Bash", "python gen_parser.py --dataset nas-31 --validate"),
        ],
        next: [
            user("arc is fairly stable now, whats next?"),
            say("Next: finish the plan-skill bench. It holds the most other work: the superpowers flip, and the cleanup after it."),
        ],
        mem: [say("Shipped. Nothing left on this one.")],
        sub: [say("The run landed; the live line shows on each Agent step.")],
        bfs: [say("Merged with --no-ff; tests pass on the merged result.")],
    };
    // createdts newest first in the order each list shows them; ended runs ended a few minutes ago, so "today" holds
    // whenever the scenario runs
    let age = 0;
    const run = (k, over) => {
        age += 1;
        const r = R[k];
        return {
            otype: "run",
            oid: r.id,
            id: r.id,
            version: 1,
            goal: r.title,
            title: r.title,
            workspaceid: "",
            projectpath: `C:\\code\\${r.by ? S[r.by].project : "waveterm"}`,
            phases: [],
            channeloid: CHANNEL,
            createdts: now - age * MIN,
            ...(r.by ? { origintranscript: tx(r.by) } : {}),
            ...over,
        };
    };
    const landed = { status: "done", completedts: now - 3 * MIN, land: { state: "landed" } };
    const runs = [
        run("ft", { status: "running", dagoref: DAG_FT }),
        run("dj", landed),
        run("rb", landed),
        run("rf", { status: "running" }),
        run("rt", landed),
        run("av", { status: "awaiting-review" }),
        run("kf", { status: "done", completedts: now - 2 * MIN, land: { state: "held" } }),
        run("mh", { status: "running" }),
        run("bfx", landed),
    ];
    const digest = (over) => ({ dagversion: 1, health: "", counts: { total: 0, done: 0 }, ...over });
    const digests = {
        [R.ft.id]: digest({ counts: { total: 5, done: 5 }, final: { state: "failed", round: 1, step: "step 3 of 5" } }),
        [R.rf.id]: digest({ counts: { total: 5, done: 2 } }),
        [R.mh.id]: digest({ counts: { total: 3, done: 1 } }),
    };
    const item = (k, kind, text, action) => ({
        key: KEY[k],
        kind,
        channelid: CHANNEL,
        runid: R[k].id,
        source: R[k].title,
        text,
        action,
        phaseidx: 0,
        waitingsince: now - 3 * MIN,
    });
    const items = [
        item("ft", "dag-blocked", "The final stage failed on step 3, bench", "Review"),
        item("rf", "ask", "keep the old Final panel beside the new one?", "Answer"),
        item("av", "dag-blocked", "Plan to approve · 4 tasks", "Review"),
        item("kf", "run-land-held", "Landing held: main moved", "Land"),
    ];
    const dags = [
        {
            otype: "dag",
            oid: DAG_FT,
            version: 1,
            id: DAG_FT,
            runid: R.ft.id,
            channelid: CHANNEL,
            parallelism: 2,
            status: "running",
            failures: 0,
            createdts: now - 40 * MIN,
            updatedts: now - 3 * MIN,
            tasks: Array.from({ length: FT_TASKS }, (_, i) => ({
                id: `t-${i + 1}`,
                label: `Feature table ${i + 1}`,
                state: "done",
                merged: true,
            })),
            final: { state: "failed", round: 1, step: "step 3 of 5", startedts: now - 8 * MIN },
        },
    ];
    return { roster, entries, runs, digests, items, dags };
}

// the board as the DOM draws it
const READ = `(() => {
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    // a cross-fading line holds the leaving text beside the arriving one: the arriving one is the last
    const line = (el) => {
        const texts = [...el.querySelectorAll("[data-run-line-text]")];
        return { id: el.dataset.runLine, tone: el.dataset.runTone, text: flat(texts[texts.length - 1]), settled: texts.length === 1 };
    };
    const thumbs = [...document.querySelectorAll("[data-cockpit-thumb]")].map((t) => {
        const transcript = t.querySelector("[data-thumb-transcript]");
        const animated = [...(transcript?.querySelectorAll("*") ?? [])].filter((el) => getComputedStyle(el).animationName !== "none").length;
        const infinite = t.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations === Infinity).length;
        return {
            id: t.dataset.cockpitThumb,
            state: t.dataset.thumbState,
            chip: flat(t.querySelector("[data-state-chip]")),
            selected: t.querySelector("[data-cockpit-ring]") != null,
            runs: [...t.querySelectorAll("[data-run-line]")].map(line),
            noRuns: t.querySelector("[data-thumb-no-runs]") != null,
            ring: t.querySelector('[aria-label="Running"]') != null,
            animated,
            infinite,
        };
    });
    const idle = document.querySelector("[data-cockpit-idle]");
    return {
        thumbs,
        turn: flat(document.querySelector("[data-cockpit-turn-count]")),
        idleNames: [...(idle?.querySelectorAll("[data-idle-name]") ?? [])].map((b) => b.dataset.idleName),
        idleCount: flat(idle?.querySelector("[data-idle-count]")),
        strip: [...document.querySelectorAll("[data-strip-run]")].map((s) => ({ id: s.dataset.stripRun, ...line(s.querySelector("[data-run-line]")) })),
        ring: document.querySelector("[data-cockpit-ring]")?.closest("[data-cockpit-stop]")?.dataset.cockpitStop ?? null,
    };
})()`;

const read = (h) => h.ev(READ);

// the zoomed view as the DOM draws it, or null while the grid shows
const READ_ZOOM = `(() => {
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    const z = document.querySelector("[data-cockpit-zoom]");
    if (z == null) return null;
    const rect = (el) => el?.getBoundingClientRect();
    const ask = rect(z.querySelector("[data-rendered-ask]"));
    const composer = rect(z.querySelector("[data-rendered-composer]"));
    const wait = z.querySelector("[data-workspace-run-wait]");
    return {
        id: z.dataset.cockpitZoom,
        // the zoom's entrance (an opacity and scale on its layer) has finished
        settled: getComputedStyle(z.parentElement).opacity === "1",
        state: z.querySelector("[data-cockpit-zoom-state]")?.dataset.cockpitZoomState ?? null,
        rendered: z.querySelector("[data-rendered-view]") != null,
        ask: ask != null,
        askAboveComposer: ask != null && composer != null && ask.bottom <= composer.top + 1,
        pane: z.querySelector("[data-workspace-pane]")?.dataset.workspacePane ?? null,
        shownRun: z.querySelector("[data-workspace-run]")?.dataset.workspaceRun ?? null,
        tabs: [...z.querySelectorAll("[data-workspace-tab]")].map((t) => ({
            key: t.dataset.workspaceTab,
            active: t.querySelector("[data-workspace-tab-indicator]") != null,
            held: t.querySelector("[data-workspace-tab-held]") != null,
            waiting: t.querySelector("[data-workspace-tab-waiting]") != null,
        })),
        wait: wait ? { who: wait.dataset.workspaceRunWait, note: flat(wait.querySelector("[data-wait-note]")) } : null,
        final: flat(z.querySelector('[data-workspace-run-stage="final"]')),
        filmCurrent: z.querySelector("[data-cockpit-film][data-current]")?.dataset.cockpitFilm ?? null,
    };
})()`;

const readZoom = (h) => h.ev(READ_ZOOM);

const waitZoom = (h, test) =>
    agentPage(h, `return until(() => { const z = ${READ_ZOOM}; return z?.settled === true && (${test})(z); }, ${WAIT_MS});`);

// one key on the surface, with the frame times sampled from just before it for MORPH_SAMPLE_MS: the zoom's entrance or
// its return, with the Rendered transcript mounting or unmounting under it. Recorded, not asserted: they are what chose
// the zoom's motion (cockpitsurface.tsx)
const pressTimed = (h, key) =>
    agentPage(
        h,
        `const el = document.querySelector("[data-cockpit-surface]");
        el.focus();
        const frames = [];
        let sampling = true;
        await new Promise((r) => requestAnimationFrame(() => r()));
        let last = performance.now();
        const tick = (t) => { frames.push(t - last); last = t; if (sampling) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
        await nap(${MORPH_SAMPLE_MS});
        sampling = false;
        const sorted = [...frames].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        const r = (n) => Math.round(n * 10) / 10;
        return { frames: frames.length, median: r(median), p95: r(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
            max: r(sorted[sorted.length - 1] ?? 0),
            // a frame over 1.5 refresh intervals missed at least one vsync
            dropped: frames.filter((f) => f > median * 1.5).length };`
    );

const clearZoom = (h) =>
    agentPage(
        h,
        `const { cockpitZoomAtom } = await mod("app/view/agents/cockpitsessionstore.ts");
        globalStore.set(cockpitZoomAtom, null);
        await nap(500);
        return true;`
    );

const waitBoard = (h, test) =>
    agentPage(h, `return until(() => { const b = ${READ}; return (${test})(b); }, ${WAIT_MS});`);

// key presses land on the surface itself, which is not editable, so the grid keys are live
const press = (h, keys) =>
    agentPage(
        h,
        `const { cockpitZoomAtom } = await mod("app/view/agents/cockpitsessionstore.ts");
        const model = agentsModel();
        const seen = [];
        for (const key of ${JSON.stringify(keys)}) {
            const el = document.querySelector("[data-cockpit-surface]");
            el.focus();
            el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
            await nap(150);
            seen.push({ cursor: globalStore.get(model.cursorIdAtom), zoom: globalStore.get(cockpitZoomAtom),
                ring: document.querySelector("[data-cockpit-ring]")?.closest("[data-cockpit-stop]")?.dataset.cockpitStop ?? null });
        }
        return seen;`
    );

const setCursor = (h, id) =>
    agentPage(h, `globalStore.set(agentsModel().cursorIdAtom, ${JSON.stringify(id)}); await nap(300); return true;`);

const ids = (keys) => keys.map((k) => S[k].id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const thumb = (board, k) => board.thumbs.find((t) => t.id === S[k].id);

export const cockpitThumbs = {
    name: NAME,
    surface: "cockpit",
    async arrange(h) {
        const ctx = {};
        try {
            await h.goto("cockpit");
            const f = fixture(Date.now());
            ctx.watchedId = S.ws.id;
            // the grid's idle sessions were prompted and are not dismissed, seen before the roster lists them so
            // they never pass through the Idle line (a return from it appends): only mem, sub and bfs are quiet
            await agentPage(
                h,
                `const C = await mod("app/view/agents/cockpitsessionstore.ts");
                const sight = { dismissedAt: null, prompted: true, state: "idle" };
                globalStore.set(C.sessionSightAtom, (prev) => ({ ...prev,
                    ...Object.fromEntries(${JSON.stringify(["det", "ws", "next"].map((k) => S[k].id))}.map((id) => [id, sight])) }));
                return true;`
            );
            await setRoster(h, f.roster);
            await agentPage(
                h,
                `const model = agentsModel();
                const C = await mod("app/view/agents/cockpitsessionstore.ts");
                const A = await mod("app/view/agents/attentionstore.ts");
                const L = await mod("app/view/agents/livetranscriptatoms.ts");
                const T = await mod("app/view/agents/shelltasksstore.ts");
                const G = await mod("app/view/agents/runlineagestore.ts");
                const f = ${JSON.stringify(f)};
                const ids = ${JSON.stringify(Object.fromEntries(Object.entries(S).map(([k, v]) => [k, v.id])))};
                const id = (k) => ids[k];
                // the roster's streams start on the fake paths and never publish, so the seeded lines stay
                await until(() => globalStore.get(model.agentsAtom).some((a) => a.id === id("det")));
                globalStore.set(T.shellTasksByIdAtom, (prev) => ({ ...prev,
                    [id("ws")]: [{ id: "m1", kind: "monitor", description: "wsh runs wait a0cc84ea --until done", persistent: true }] }));
                globalStore.set(L.liveEntriesByIdAtom, (prev) => ({ ...prev, ...Object.fromEntries(Object.entries(f.entries).map(([k, e]) => [id(k), e])) }));
                globalStore.set(G.runDigestsAtom, (prev) => ({ ...prev, ...f.digests }));
                for (const d of f.dags) WOS.updateWaveObject({ updatetype: "update", otype: "dag", oid: d.oid, obj: d });
                for (const r of f.runs) WOS.updateWaveObject({ updatetype: "update", otype: "run", oid: r.oid, obj: r });
                WOS.updateWaveObject({ updatetype: "update", otype: "channel", oid: ${JSON.stringify(CHANNEL)},
                    obj: { otype: "channel", oid: ${JSON.stringify(CHANNEL)}, version: 1, name: "cockpit-thumbs fixture" } });
                globalStore.set(C.cockpitRunsAtom, (prev) => ({
                    byChannel: { ...prev.byChannel, ${JSON.stringify(CHANNEL)}: f.runs },
                    fetchedAt: { ...prev.fetchedAt, ${JSON.stringify(CHANNEL)}: Date.now() },
                    loadedAt: prev.loadedAt ?? Date.now(),
                }));
                localStorage.setItem(${JSON.stringify(DEV_ITEMS_KEY)}, JSON.stringify(f.items));
                await A.loadAttention();
                C.stepCockpit(model);
                return true;`
            );
            const shown = await waitBoard(
                h,
                `(b) => ${JSON.stringify(ids(GRID))}.every((id) => b.thumbs.some((t) => t.id === id)) && b.strip.length >= ${STRIP.length}`
            );
            if (!shown) {
                throw new Error(`the fixture did not reach the grid: ${JSON.stringify(await read(h))}`);
            }
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("arrange the fixture sessions, runs and waits", false, ctx.arrangeError);
            return steps;
        }

        // grid: the Grid board
        const b = await read(h);
        await h.shot(SHOT(1, "grid"));
        const chips = Object.fromEntries(GRID.map((k) => [k, thumb(b, k)?.chip]));
        const det = thumb(b, "det");
        const kafka = thumb(b, "kafka");
        const ws = thumb(b, "ws");
        const fixtureThumbs = b.thumbs.filter((t) => t.id.startsWith("cthumbs-"));
        rec(
            "grid: thumbnails in all four states with their chips; a Working conductor's wait reads muted '· conductor has it', a Your turn conductor's one amber '· waits on you'; 'No runs today'; the Idle line with its count; the strip; no spinner or infinite animation in a thumbnail",
            same(chips, {
                det: "Your turn",
                plan: "Asks you",
                ws: "Watching",
                kafka: "Working",
                nas: "Working",
                next: "Your turn",
            }) &&
                kafka?.runs.some((r) => r.id === R.av.id && r.tone === "conductor" && r.text === "Plan to approve · conductor has it") &&
                det?.runs.filter((r) => r.tone === "yours").length === 1 &&
                det.runs.some((r) => r.id === R.ft.id && r.text === "Final failed · waits on you") &&
                ws?.runs.some((r) => r.id === R.rf.id && r.tone === "conductor") &&
                thumb(b, "nas")?.noRuns === true &&
                thumb(b, "next")?.noRuns === true &&
                ids(IDLE).every((id) => b.idleNames.includes(id)) &&
                b.idleCount === String(b.idleNames.length) &&
                STRIP.every((k) => b.strip.some((s) => s.id === R[k].id)) &&
                b.strip.some((s) => s.id === R.kf.id && s.text === "Landing held · waits on you") &&
                kafka?.ring === true &&
                fixtureThumbs.every((t) => t.animated === 0 && t.infinite === 0),
            JSON.stringify({ chips, det: det?.runs, kafka: kafka?.runs, ws: ws?.runs, idle: b.idleNames, idleCount: b.idleCount, strip: b.strip, spin: fixtureThumbs.map((t) => [t.id, t.ring, t.animated, t.infinite]) })
        );

        // escalated: the Watching conductor's timer runs out
        const esc = await agentPage(
            h,
            `const C = await mod("app/view/agents/cockpitsessionstore.ts");
            const M = await mod("app/view/agents/cockpitsessionmodel.ts");
            const P = await mod("app/view/agents/attentionpopup.ts");
            const model = agentsModel();
            const key = ${JSON.stringify(KEY.rf)};
            const before = globalStore.get(C.outwardAttentionAtomFor(model));
            const track = globalStore.get(C.escalationStateAtom)[key];
            if (track == null) return { error: "the wait has no escalation track" };
            globalStore.set(C.escalationStateAtom, (prev) => ({ ...prev, [key]: { ...prev[key], watchedMs: M.WAIT_TIMER_MS } }));
            const after = globalStore.get(C.outwardAttentionAtomFor(model));
            const bubble = P.popupBubble(before, after, false);
            return { beforeHas: before.some((i) => i.key === key), afterHas: after.some((i) => i.key === key), bubble };`
        );
        const turned = await waitBoard(
            h,
            `(b) => b.thumbs.find((t) => t.id === ${JSON.stringify(S.ws.id)})?.runs.some((r) => r.id === ${JSON.stringify(R.rf.id)} && r.tone === "yours" && r.settled)`
        );
        const e = await read(h);
        await h.shot(SHOT(2, "escalated"));
        const rf = thumb(e, "ws")?.runs.find((r) => r.id === R.rf.id);
        rec(
            "escalated: the Watching conductor's muted wait turns amber '· waits on you' once its timer passes 5 min, the 'on your turn' count unchanged; the outward list gains it then, and the popup raises exactly one bubble for it with the timer reason",
            turned &&
                rf?.text === "Asks · waits on you" &&
                thumb(e, "ws")?.chip === "Watching" &&
                e.turn === b.turn &&
                esc.beforeHas === false &&
                esc.afterHas === true &&
                esc.bubble?.key === KEY.rf &&
                esc.bubble?.more === 0 &&
                esc.bubble?.detail === `${S.ws.name} is Watching but didn't pick it up within 5 min.`,
            JSON.stringify({ rf, turnBefore: b.turn, turnAfter: e.turn, esc })
        );

        // keys: the Prototype board's grid keys. The grid takes three columns, or two under 1100 px
        const columns = await h.ev(
            `getComputedStyle(document.querySelector("[data-cockpit-grid]")).gridTemplateColumns.split(" ").length`
        );
        // the dev roster is the fixture alone: det plan ws / kafka nas next in three columns, det plan / ws kafka /
        // nas next in two
        const lead = await read(h);
        const gridIds = lead.thumbs.map((t) => t.id);
        await setCursor(h, S.det.id);
        const walkKeys = ["ArrowRight", "ArrowDown", "ArrowDown", "ArrowRight", "ArrowUp", "ArrowUp"];
        const firstIdle = lead.idleNames[0];
        const want =
            columns === 3
                ? [S.plan.id, S.nas.id, firstIdle, lead.idleNames[1], S.nas.id, S.plan.id]
                : [S.plan.id, S.kafka.id, S.next.id, S.next.id, S.kafka.id, S.plan.id];
        const walk = await press(h, walkKeys);
        rec(
            `keys: the arrows move the ring along the path (${columns} columns): thumbnails, down to the Idle line, and Up retraces`,
            same(gridIds, ids(GRID)) && same(walk.map((w) => w.ring), want) && same(walk.map((w) => w.cursor), want),
            JSON.stringify({ columns, gridIds, want, walk })
        );

        // d: the selected thumbnail leaves for the Idle line and its count rises
        await setCursor(h, S.next.id);
        const idleBefore = (await read(h)).idleNames.length;
        await press(h, ["d"]);
        const dismissed = await waitBoard(
            h,
            `(b) => !b.thumbs.some((t) => t.id === ${JSON.stringify(S.next.id)}) && b.idleNames.includes(${JSON.stringify(S.next.id)})`
        );
        const d = await read(h);
        await h.shot(SHOT(3, "dismissed"));
        rec(
            "keys: d moves the selected thumbnail to the Idle line, its count rises, and the ring moves on",
            dismissed && d.idleNames.length === idleBefore + 1 && d.idleCount === String(idleBefore + 1) && d.ring != null && d.ring !== S.next.id,
            JSON.stringify({ idleBefore, idle: d.idleNames, idleCount: d.idleCount, ring: d.ring })
        );

        // Space on a thumbnail sets the zoom atom (the zoom itself renders from a later task)
        await setCursor(h, S.plan.id);
        const zoomed = await press(h, [" "]);
        await agentPage(
            h,
            `const { cockpitZoomAtom } = await mod("app/view/agents/cockpitsessionstore.ts"); globalStore.set(cockpitZoomAtom, null); return true;`
        );
        rec("keys: Space on a thumbnail sets the zoom atom to it", zoomed[0]?.zoom === S.plan.id, JSON.stringify(zoomed));

        // Space on a strip line opens its run on its own surface
        await setCursor(h, `strip:${R.kf.id}`);
        await press(h, [" "]);
        const opened = await agentPage(
            h,
            `await until(() => [...document.querySelectorAll("nav button")].some((b) => (b.className || "").includes("text-accent-soft") && (b.getAttribute("aria-label") || b.textContent.trim()) === ${JSON.stringify(SURFACE_LABEL.jarvis)}), ${WAIT_MS});
            return true;`
        );
        const onHub = await h.activeSurfaceLabel();
        await h.shot(SHOT(4, "strip-open"));
        rec(
            "keys: Space on a strip line opens that run on its own surface (Hub)",
            opened === true && onHub === SURFACE_LABEL.jarvis,
            JSON.stringify({ onHub })
        );

        // Enter lands on the Agent surface with that session focused
        await h.goto("cockpit");
        await setCursor(h, S.det.id);
        await press(h, ["Enter"]);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const onAgent = await h.activeSurfaceLabel();
        const focused = await agentPage(h, `return globalStore.get(agentsModel().focusIdAtom);`);
        await h.shot(SHOT(5, "enter"));
        rec(
            "keys: Enter lands on the Agent surface with the selected session focused",
            onAgent === SURFACE_LABEL.agent && focused === S.det.id,
            JSON.stringify({ onAgent, focused })
        );
        await h.goto("cockpit");
        await clearZoom(h);

        // zoom-final: a Your turn conductor zoomed, its pane on the run whose Final failed, the wait amber and yours
        await setCursor(h, S.det.id);
        const zoomIn = await pressTimed(h, " ");
        const finalShown = await waitZoom(
            h,
            `(z) => z?.id === ${JSON.stringify(S.det.id)} && z.rendered && z.shownRun === ${JSON.stringify(R.ft.id)} && z.wait != null`
        );
        const zf = await readZoom(h);
        await h.shot(SHOT(6, "zoom-final"));
        const ftTab = zf?.tabs.find((t) => t.key === `run:${R.ft.id}`);
        rec(
            "zoom-final: Space zooms the Your turn conductor; its pane shows the run whose Final failed, its tab active with the waiting dot, and the waiting row amber with 'Waits on you'",
            finalShown &&
                zf.state === "turn" &&
                ftTab?.active === true &&
                ftTab.waiting === true &&
                zf.wait.who === "you" &&
                zf.wait.note.startsWith("Waits on you") &&
                zf.final.includes("Final verification"),
            JSON.stringify({ zf, zoomIn })
        );

        // Esc plays the zoom back and lands on the same thumbnail
        const zoomOut = await pressTimed(h, "Escape");
        const back = await waitBoard(
            h,
            `(b) => b.ring === ${JSON.stringify(S.det.id)} && document.querySelector("[data-cockpit-zoom]") == null`
        );
        rec(
            "zoom-final: Esc returns to the grid with the zoomed thumbnail still selected",
            back,
            JSON.stringify({ back, zoomOut })
        );

        // zoom-asks: the answer bar above the composer, the pane on the landed run; an answer collapses the bar
        await setCursor(h, S.plan.id);
        await press(h, [" "]);
        const asksShown = await waitZoom(
            h,
            `(z) => z?.id === ${JSON.stringify(S.plan.id)} && z.ask && z.shownRun === ${JSON.stringify(R.rb.id)}`
        );
        const za = await readZoom(h);
        await h.shot(SHOT(7, "zoom-asks"));
        // the answer reaching the agent: its ask closes and it goes back to work
        await agentPage(
            h,
            `const D = await mod("app/view/agents/devmock.ts");
            globalStore.set(D.devMockAgentsAtom, (prev) => prev.map((a) => a.id === ${JSON.stringify(S.plan.id)}
                ? { ...a, state: "working", ask: undefined, blockedMs: undefined, activeMs: 1000 } : a));
            return true;`
        );
        const collapsed = await waitZoom(h, `(z) => z?.id === ${JSON.stringify(S.plan.id)} && !z.ask`);
        await h.shot(SHOT(8, "zoom-asks-answered"));
        rec(
            "zoom-asks: an Asks you session zoomed shows its answer bar above the composer and its pane on its landed run; answering collapses the bar",
            asksShown &&
                za.state === "asks" &&
                za.askAboveComposer &&
                za.tabs.find((t) => t.key === `run:${R.rb.id}`)?.active === true &&
                collapsed,
            JSON.stringify({ za, collapsed })
        );
        await press(h, ["Escape"]);

        // zoom-watching: the escalated step made this wait yours, so its decision restarts with the conductor Watching
        await agentPage(
            h,
            `const C = await mod("app/view/agents/cockpitsessionstore.ts");
            const key = ${JSON.stringify(KEY.rf)};
            globalStore.set(C.escalationStateAtom, (prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)));
            C.stepCockpit(agentsModel());
            return true;`
        );
        await setCursor(h, S.ws.id);
        await press(h, [" "]);
        const watchShown = await waitZoom(
            h,
            `(z) => z?.id === ${JSON.stringify(S.ws.id)} && z.wait?.who === "conductor" && z.shownRun === ${JSON.stringify(R.rf.id)}`
        );
        const zw = await readZoom(h);
        await h.shot(SHOT(9, "zoom-watching"));
        const rfKey = `run:${R.rf.id}`;
        const rfTab = zw?.tabs.find((t) => t.key === rfKey);
        await press(h, ["]"]);
        const moved = await waitZoom(
            h,
            `(z) => z != null && z.tabs.some((t) => t.active) && !z.tabs.find((t) => t.key === ${JSON.stringify(rfKey)})?.active`
        );
        const zm = await readZoom(h);
        await press(h, ["d"]);
        const strip = await waitZoom(h, `(z) => z?.pane === "strip"`);
        await h.shot(SHOT(10, "zoom-watching-strip"));
        rec(
            "zoom-watching: a Watching conductor's run tab draws the muted dot and its row the note with minutes left; ] moves the pane tab, d collapses the pane to its strip",
            watchShown &&
                zw.state === "watching" &&
                rfTab?.held === true &&
                rfTab.waiting === false &&
                zw.wait.note === `${S.ws.name} has it: it is Watching. This comes to you in 5 min if it doesn't act.` &&
                moved &&
                strip,
            JSON.stringify({ zw, after: zm?.tabs, strip })
        );
        // the pane open again, for whoever zooms it next
        await press(h, ["d", "Escape"]);

        // zoom-keys: Space zooms, a filmstrip click hops, Esc lands on the hopped-to thumbnail, Enter opens it
        await setCursor(h, S.kafka.id);
        const spaced = await press(h, [" "]);
        await waitZoom(h, `(z) => z?.id === ${JSON.stringify(S.kafka.id)}`);
        const hop = await agentPage(
            h,
            `document.querySelector('[data-cockpit-film="${S.plan.id}"]')?.click();
            await until(() => document.querySelector("[data-cockpit-zoom]")?.dataset.cockpitZoom === ${JSON.stringify(S.plan.id)}, ${WAIT_MS});
            await nap(400);
            return { zoom: document.querySelector("[data-cockpit-zoom]")?.dataset.cockpitZoom ?? null,
                current: document.querySelector("[data-cockpit-film][data-current]")?.dataset.cockpitFilm ?? null };`
        );
        await h.shot(SHOT(11, "zoom-hop"));
        const escaped = await press(h, ["Escape"]);
        const landed = await waitBoard(
            h,
            `(b) => b.ring === ${JSON.stringify(S.plan.id)} && document.querySelector("[data-cockpit-zoom]") == null`
        );
        await press(h, [" "]);
        await waitZoom(h, `(z) => z?.id === ${JSON.stringify(S.plan.id)}`);
        await press(h, ["Enter"]);
        await h.ev("new Promise((r) => setTimeout(r, 500))");
        const enterSurface = await h.activeSurfaceLabel();
        const enterFocus = await agentPage(h, `return globalStore.get(agentsModel().focusIdAtom);`);
        await h.shot(SHOT(12, "zoom-enter"));
        rec(
            "zoom-keys: Space zooms the selected thumbnail, a filmstrip click hops sessions, Esc returns with the hopped-to thumbnail selected, and Enter (composer unfocused) lands on the Agent surface",
            spaced[0]?.zoom === S.kafka.id &&
                hop.zoom === S.plan.id &&
                hop.current === S.plan.id &&
                escaped[0]?.zoom === null &&
                escaped[0]?.cursor === S.plan.id &&
                landed &&
                enterSurface === SURFACE_LABEL.agent &&
                enterFocus === S.plan.id,
            JSON.stringify({ spaced, hop, escaped, landed, enterSurface, enterFocus })
        );
        await clearZoom(h);
        await h.goto("cockpit");
        return steps;
    },
    async teardown(h, ctx) {
        try {
            await agentPage(
                h,
                `const C = await mod("app/view/agents/cockpitsessionstore.ts");
                const A = await mod("app/view/agents/attentionstore.ts");
                const T = await mod("app/view/agents/shelltasksstore.ts");
                localStorage.removeItem(${JSON.stringify(DEV_ITEMS_KEY)});
                globalStore.set(C.cockpitZoomAtom, null);
                globalStore.set(C.cockpitRunsAtom, (prev) => {
                    const { [${JSON.stringify(CHANNEL)}]: _r, ...byChannel } = prev.byChannel;
                    const { [${JSON.stringify(CHANNEL)}]: _f, ...fetchedAt } = prev.fetchedAt;
                    return { ...prev, byChannel, fetchedAt };
                });
                const keys = ${JSON.stringify(Object.values(KEY))};
                globalStore.set(C.escalationStateAtom, (prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !keys.includes(k))));
                globalStore.set(C.sessionSightAtom, (prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith("cthumbs-"))));
                globalStore.set(T.shellTasksByIdAtom, (prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith("cthumbs-"))));
                await A.loadAttention();
                return true;`
            );
        } catch (e) {
            console.error(`${NAME}: clearing the fixture state failed: ${e?.message ?? e}`);
        }
        await restoreRoster(h);
    },
};
