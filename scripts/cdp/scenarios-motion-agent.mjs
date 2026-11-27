// motion-agent: the motion sweep's moments on the Agent surface panes (docs/superpowers/plans/2026-11-10-motion-sweep.md,
// Task 10). Each pane is mounted over the page with data each step changes (the run-sheet scenario's leaf approach):
// the changes measured here (a save failing, a monitor event arriving, a run's lead ending) are
// ones no fixture produces on demand, and the arrange scenarios' own checks run unchanged in agent-composer,
// shell-tasks, sessions-list and agent-rendered. Every moment is read in-page in one evaluation, since
// a CDP round trip per sample is slower than the fade it measures: an observer reads the opacity a node is added with
// (motion-gaps), a frame sampler what moves while it moves (dag-motion). Steps 21-23 are the follow-ups' (spec
// docs/superpowers/specs/2026-11-13-motion-sweep-follow-ups-design.md, section 6): a session detail's Show earlier
// turns and find bar, and the plan preview's own pane.

import { lookEval, OBS_WIDE, releaseRpc } from "./scenarios-shared.mjs";

const NAME = "motion-agent";
const NO_MEDIA = { features: [] };
// a fade or reveal mounts at (near) 0 and settles at 1; read this long after the change, past durMacro
const SETTLE_MS = 700;
const MOUNTED_HIDDEN = 0.1;
// a tween's last frame can stop a hair under 1
const SETTLED = 0.99;
const MOUNT_STYLE = "width:720px;max-height:80vh;overflow:auto;";
const PLAN_PATH = "C:/motion-agent/plan.md";
const PLAN_TEXT = "# Motion plan\n\n- the pane fades\n- the error nudges\n";
// a fixed height, so the detail's body is the scroller its sticky find bar sits in
const DETAIL_STYLE = "width:720px;height:70vh;";
const SOLO_ID = "motion-agent-solo";
const SOLO_PATH = "C:/motion-agent/solo.jsonl";
// claude's tail read (sessionstranscript.ts TAIL_LINES): a reread returning this many lines may be cut off
const TAIL_LINES = 2000;
// a live session is reread every LIVE_REFRESH_MS (5s); wait past one
const REREAD_MS = 8000;

const LIB = `
    const opacity = (el) => (el ? Number(getComputedStyle(el).opacity) : null);
    // a busy machine drops frames, so a fade can still be running after a fixed nap: wait for it to land (or give up)
    const settle = async (pick) => {
        await until(() => (opacity(pick()) ?? 0) >= ${SETTLED}, 3000);
        return opacity(pick());
    };
    // the opacity each node pick(n) returns has as it is added, in order
    const watchAdded = (pick) => {
        const seen = [];
        const obs = new MutationObserver((muts) => {
            for (const m of muts) for (const n of m.addedNodes) {
                const hit = n instanceof Element ? pick(n) : null;
                if (hit) seen.push(Number(getComputedStyle(hit).opacity));
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        return { seen, stop: () => obs.disconnect() };
    };
    // every distinct value read() takes, one read per frame, until stop()
    const sampleFrames = (read) => {
        const values = [];
        let on = true;
        const tick = () => {
            const v = read();
            if (v != null && v !== values.at(-1)) values.push(v);
            if (on) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return { values, stop: () => (on = false) };
    };
    const cockpitModel = async () => {
        const model = (await mod("app/store/wshrpcutil.ts")).DefaultRouter.routeMap.get("cockpit")?.model;
        if (model == null) throw new Error("the cockpit route serves no model");
        return model;
    };
`;
const motionEval = (h, body) => lookEval(h, `${LIB} ${body}`);

const revealed = (r) => r != null && r.first != null && r.first < MOUNTED_HIDDEN && r.settled >= SETTLED;
// a cross-fade's new mark is added part-way in (microFade), then settles
const crossFaded = (r) => r != null && r.first != null && r.first < 1 && r.settled >= SETTLED;

const QUESTION = (n) => ({
    header: "Way",
    question: "Which way should the pane go?",
    multiSelect: false,
    options: Array.from({ length: n }, (_, i) => ({
        label: `Option ${i + 1}`,
        description: `what option ${i + 1} does`,
        preview: `option_${i + 1}()`,
    })),
});
const ASKING = (n) => ({ id: "motion-agent-ask", name: "motion", task: "", state: "asking", ask: { questions: [QUESTION(n)] } });

async function answerBarSteps(h, rec) {
    const r = await motionEval(h, `
        unmountAll();
        const props = (p) => ({ agent: ${JSON.stringify(ASKING(2))}, selections: {}, texts: {}, numbered: true, onToggle: () => {}, onSubmit: () => {}, onSelectQuestion: () => {}, ...p });
        const host = await mount("app/view/agents/answerbar.tsx", "AnswerBar", props({}), { style: ${JSON.stringify(MOUNT_STYLE)} });
        const options = () => [...host.querySelectorAll("button")].filter((b) => /Option \\d/.test(flat(b)));
        if (options().length !== 2) return { error: "no options", text: flat(host) };

        const pw = watchAdded((n) => (host.contains(n) && n.matches('[data-answer-preview="1"]') ? n : null));
        // a mouseover is React's mouseenter; a programmatic focus does not reach onFocus while the page is unfocused
        options()[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
        await nap(${SETTLE_MS});
        pw.stop();
        const preview = { first: pw.seen[0] ?? null, settled: await settle(() => host.querySelector('[data-answer-preview="1"]')), text: flat(host.querySelector("[data-answer-preview]")) };

        const mw = watchAdded((n) => (host.contains(n) && n.matches('[data-crossfade="on"]') ? n : null));
        host.render(props({ selections: { 0: new Set([1]) } }));
        await nap(${SETTLE_MS});
        mw.stop();
        const marks = host.querySelectorAll('[data-crossfade="on"]');
        const mark = { first: mw.seen[0] ?? null, settled: await settle(() => marks[0]), count: marks.length, text: flat(marks[0]) };

        const box = host.firstElementChild?.firstElementChild;
        const heights = sampleFrames(() => Math.round(box.getBoundingClientRect().height));
        host.render(props({ agent: ${JSON.stringify(ASKING(5))} }));
        await nap(${SETTLE_MS});
        heights.stop();

        const inner = box.firstElementChild;
        const sw = watchAdded((n) => (n.parentElement === inner ? n : null));
        host.render(props({ agent: ${JSON.stringify(ASKING(5))}, selections: { 0: new Set([0]) }, sent: true }));
        await nap(${SETTLE_MS});
        sw.stop();
        const sent = { first: sw.seen[0] ?? null, settled: await settle(() => inner.firstElementChild), text: flat(inner) };
        return { preview, mark, heights: heights.values, sent };
    `);
    rec(
        "1. answer bar: focusing another option fades its preview in where the last one was",
        revealed(r?.preview) && r.preview.text === "option_2()",
        JSON.stringify(r?.preview ?? r)
    );
    rec(
        "2. answer bar: an option becoming selected cross-fades its mark in, on that option only",
        crossFaded(r?.mark) && r.mark.count === 1 && r.mark.text === "●",
        JSON.stringify(r?.mark ?? r)
    );
    rec(
        "3. answer bar: a question with more options grows the bar through intermediate heights",
        r?.heights != null && r.heights.length >= 3 && r.heights.at(-1) > r.heights[0],
        JSON.stringify(r?.heights ?? r)
    );
    rec(
        "4. answer bar: sending trades the question for its summary, fading in",
        revealed(r?.sent) && r.sent.text.startsWith("Answered: Option 1"),
        JSON.stringify(r?.sent ?? r)
    );
    await h.shot(`cdp-shots/${NAME}-answerbar.png`);
}

// the working line: a pure WorkingLine whose line each step rewrites, then the live one a host draws as its tail
const WORKING_LIB = `
    const t0 = Date.now();
    const spin = (verb, glyph = "✻") => ({ glyph, verb, detail: "24s · ↓ 1.8k tokens", tokens: "1.8k" });
    const working = (verb, glyph) => ({ kind: "working", spinner: spin(verb, glyph), elapsedMs: 24000, tokens: "1.8k", tools: 4 });
    const verbOf = () => flat(host.querySelector("[data-working-verb]"));
    const live = (state) => ({
        nowAtom: model.nowAtom,
        blockId: "motion-agent-working-block",
        state,
        entries: [{ kind: "user", text: "go", ts: t0 - 24000 }, { kind: "action", verb: "Bash", target: "go test", pending: true, startedTs: t0 - 2000 }],
    });
`;

async function workingLineSteps(h, rec) {
    const r = await motionEval(h, `
        unmountAll();
        const model = await cockpitModel();
        let host = null;
        ${WORKING_LIB}
        host = await mount("app/view/agents/nowlineview.tsx", "WorkingLine", { line: { kind: "hidden" } }, { style: ${JSON.stringify(MOUNT_STYLE)} });
        // the line arrives inside its height reveal, which carries the fade
        const wl = watchAdded((n) => (host.contains(n) && n.querySelector(":scope > [data-working-line]") ? n : null));
        host.render({ line: working("Cogitating…") });
        await nap(${SETTLE_MS});
        wl.stop();
        const enter = { first: wl.seen[0] ?? null, settled: await settle(() => host.querySelector("[data-working-line]")?.parentElement) };

        const cw = watchAdded((n) => (host.contains(n) && n.matches("[data-crossfade]") && n.textContent.includes("Pondering") ? n : null));
        host.render({ line: working("Pondering…") });
        await nap(${SETTLE_MS});
        cw.stop();
        const swapped = host.querySelector("[data-working-verb]")?.closest("[data-crossfade]");
        const verbSwap = { first: cw.seen[0] ?? null, settled: await settle(() => swapped), verb: verbOf() };

        // each 1s tick samples claude's cycling glyph at a different frame: only the verb may swap the copy
        const gw = watchAdded((n) => (host.contains(n) && n.matches("[data-crossfade]") ? n : null));
        const frames = sampleFrames(() => host.querySelector("[data-working-glyph]")?.textContent ?? null);
        const shimmer = sampleFrames(() => host.querySelector("[data-working-line]")?.style.getPropertyValue("--shimmer") || null);
        for (const g of ["✢", "✳", "✶", "·"]) {
            host.render({ line: working("Pondering…", g) });
            await nap(250);
        }
        frames.stop();
        shimmer.stop();
        gw.stop();
        const glyphTicks = { swaps: gw.seen.length, verb: verbOf(), frames: frames.values.length, shimmer: shimmer.values.length };

        unmountAll();
        host = await mount("app/view/agents/nowlineview.tsx", "LiveWorkingLine", live("working"), { style: ${JSON.stringify(MOUNT_STYLE)} });
        await until(() => host.querySelector("[data-working-line]") != null, 3000);
        const whileWorking = flat(host.querySelector("[data-working-line]"));
        host.render(live("idle"));
        await nap(${SETTLE_MS});
        return { enter, verbSwap, glyphTicks, idle: { whileWorking, gone: host.querySelector("[data-working-line]") == null } };
    `);
    rec(
        "5. working line: the line appearing when the agent starts working grows and fades in",
        revealed(r?.enter),
        JSON.stringify(r?.enter ?? r)
    );
    rec(
        "6. working line: the spinner's verb changing cross-fades the new verb in",
        crossFaded(r?.verbSwap) && r.verbSwap.verb === "Pondering…",
        JSON.stringify(r?.verbSwap ?? r)
    );
    rec(
        "6b. working line: a new spinner glyph with the same verb swaps nothing, while the drawn glyph cycles and the shimmer sweeps the verb",
        r?.glyphTicks != null &&
            r.glyphTicks.swaps === 0 &&
            r.glyphTicks.verb === "Pondering…" &&
            r.glyphTicks.frames >= 3 &&
            r.glyphTicks.shimmer >= 3,
        JSON.stringify(r?.glyphTicks ?? r)
    );
    rec(
        "7. working line: the live line reads Working and the turn's time with no spinner on screen, and leaves once the agent is idle",
        r?.idle != null && /^Working · \d+s · 1 tool$/.test(r.idle.whileWorking) && r.idle.gone,
        JSON.stringify(r?.idle ?? r)
    );
    await h.shot(`cdp-shots/${NAME}-workingline.png`);
}

const DIFF = [
    "diff --git a/pkg/a.go b/pkg/a.go",
    "index 1111111..2222222 100644",
    "--- a/pkg/a.go",
    "+++ b/pkg/a.go",
    "@@ -1,2 +1,2 @@",
    " package a",
    "-var x = 1",
    "+var x = 2",
].join("\n");
const DIFF_ACTION = { kind: "action", verb: "Bash", target: "git diff", detail: { kind: "bash", command: "git diff", output: DIFF, exit: 0 } };

async function toolCardSteps(h, rec) {
    const r = await motionEval(h, `
        unmountAll();
        const host = await mount("app/view/agents/toolrenderers.tsx", "ToolOutputRenderer", { action: ${JSON.stringify(DIFF_ACTION)} }, { style: ${JSON.stringify(MOUNT_STYLE)} });
        if (!host.querySelector('[data-card-view="parsed"]')) return { error: "no parsed body", text: flat(host) };
        const views = sampleFrames(() => host.querySelectorAll("[data-card-view]").length);
        const w = watchAdded((n) => (host.contains(n) && n.matches('[data-card-view="raw"]') ? n : null));
        host.querySelector("[data-raw-toggle]").click();
        await nap(${SETTLE_MS});
        w.stop();
        views.stop();
        const raw = host.querySelector('[data-card-view="raw"]');
        return { first: w.seen[0] ?? null, settled: await settle(() => raw), views: views.values, pre: raw?.querySelector("pre") != null };
    `);
    rec(
        "8. tool card: raw fades in where the parsed diff was, the two never on screen together",
        revealed(r) && r.pre && Math.max(...r.views) === 1,
        JSON.stringify(r)
    );
}

async function shellPeekSteps(h, rec) {
    const r = await motionEval(h, `
        unmountAll();
        const model = await cockpitModel();
        document.querySelector("[data-motion-agent-anchor]")?.remove();
        const anchor = document.createElement("div");
        anchor.setAttribute("data-motion-agent-anchor", "");
        anchor.style.cssText = "position:fixed;left:40px;top:120px;width:200px;height:24px;";
        document.body.append(anchor);
        const t0 = Date.now();
        const ev = (i) => ({ ts: t0 - 30000 + i * 1000, lines: ["event " + (i + 1)] });
        const task = (n) => ({ id: "motion-agent-mon", kind: "monitor", description: "watch ci", command: "gh run watch", startedTs: t0 - 60000, events: Array.from({ length: n }, (_, i) => ev(i)) });
        const host = await mount("app/view/agents/shelltaskpeek.tsx", "ShellTaskPeek", { model, task: task(1), anchor });
        const peek = () => document.querySelector('[data-shell-task-peek="motion-agent-mon"]');
        if (!peek()) return { error: "no peek" };
        const ew = watchAdded((n) => (peek()?.contains(n) && n.matches("[data-monitor-event]") ? n : null));
        host.render({ model, task: task(2), anchor });
        await nap(${SETTLE_MS});
        ew.stop();
        const rows = peek().querySelectorAll("[data-monitor-event]");
        const event = { seen: ew.seen, settled: await settle(() => rows[1]), count: rows.length };

        const vw = watchAdded((n) => (peek()?.contains(n) && n.matches('[data-peek-view="output"]') ? n : null));
        peek().querySelector('[data-peek-tab="output"]').click();
        await nap(${SETTLE_MS});
        vw.stop();
        const view = { first: vw.seen[0] ?? null, settled: await settle(() => peek().querySelector('[data-peek-view="output"]')), events: peek().querySelectorAll('[data-peek-view="events"]').length };
        return { event, view };
    `);
    rec(
        "9. monitor peek: an event arriving while open enters as a card from opacity 0, and only that one",
        r?.event != null && r.event.seen.length === 1 && r.event.seen[0] < MOUNTED_HIDDEN && r.event.settled >= SETTLED && r.event.count === 2,
        JSON.stringify(r?.event ?? r)
    );
    rec(
        "10. monitor peek: Events -> Output fades the output view in where the events were",
        revealed(r?.view) && r.view.events === 0,
        JSON.stringify(r?.view ?? r)
    );
    await h.shot(`cdp-shots/${NAME}-shellpeek.png`);
}

async function runDetailSteps(h, rec) {
    const r = await motionEval(h, `
        unmountAll();
        const model = await cockpitModel();
        const { LEAD_MEMBER } = await mod("app/view/agents/sessionsruns.ts");
        const t0 = Date.now();
        const lead = (live) => ({ key: LEAD_MEMBER, num: "", label: "Lead", status: { key: "running", text: "working" }, session: { live, runtime: "claude", id: "motion-lead" }, tokens: 0, durationMs: 0 });
        const view = (p) => ({ runId: "motion-agent-run", title: "Motion run", project: "arc", plan: "", runtime: "claude", live: true, open: true, head: { key: "running", text: "working" }, complete: false, segs: [], landed: 0, total: 2, members: [lead(false)], needs: [], tokens: 0, startedts: t0 - 600000, lastactivets: t0, ...p });
        const props = (v) => ({ model, view: v, member: v.members[0], now: t0 });
        const host = await mount("app/view/agents/sessionsdetail.tsx", "RunDetail", props(view({})), { style: ${JSON.stringify(MOUNT_STYLE)} });
        if (host.querySelector("[data-sessions-run-ask]") || host.querySelector("[data-sessions-jump-lead]")) return { error: "ask or jump at mount" };

        const aw = watchAdded((n) => (host.contains(n) && n.firstElementChild?.matches("[data-sessions-run-ask]") ? n : null));
        host.render(props(view({ ask: { member: LEAD_MEMBER, num: "2", text: "Which way?" } })));
        await nap(${SETTLE_MS});
        aw.stop();
        const ask = { first: aw.seen[0] ?? null, settled: await settle(() => host.querySelector("[data-sessions-run-ask]")?.parentElement), text: flat(host.querySelector("[data-sessions-run-ask]")) };

        const jw = watchAdded((n) => (host.contains(n) && n.matches('[data-crossfade="live"]') ? n : null));
        host.render(props(view({ members: [lead(true)] })));
        await nap(${SETTLE_MS});
        jw.stop();
        const jump = { first: jw.seen[0] ?? null, settled: await settle(() => host.querySelector('[data-crossfade="live"]')), button: host.querySelector("[data-sessions-jump-lead]") != null };
        return { ask, jump };
    `);
    rec(
        "11. run detail: a task's ask arriving grows its banner in from opacity 0",
        revealed(r?.ask) && r.ask.text.includes("Task 2 asks:"),
        JSON.stringify(r?.ask ?? r)
    );
    rec(
        "12. run detail: the lead going live cross-fades Jump to lead in",
        crossFaded(r?.jump) && r.jump.button,
        JSON.stringify(r?.jump ?? r)
    );
}

// the plan read answers after a beat (so loading is on screen), and the write is refused
const stubPlanRpc = (h) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const held = (window.__heldRpc ??= {});
        held.FileReadCommand ??= RpcApi.FileReadCommand;
        held.FileWriteCommand ??= RpcApi.FileWriteCommand;
        RpcApi.FileReadCommand = (client, data, opts) =>
            data?.info?.path === ${JSON.stringify(PLAN_PATH)}
                ? new Promise((ok) => setTimeout(() => ok({ data64: btoa(${JSON.stringify(PLAN_TEXT)}) }), 300))
                : held.FileReadCommand(client, data, opts);
        RpcApi.FileWriteCommand = (client, data, opts) =>
            data?.info?.path === ${JSON.stringify(PLAN_PATH)}
                ? Promise.reject(new Error("motion-agent: refused"))
                : held.FileWriteCommand(client, data, opts);
        return true;
    `);

async function planPreviewSteps(h, rec) {
    await stubPlanRpc(h);
    const r = await motionEval(h, `
        unmountAll();
        const lw = watchAdded((n) => (n.matches('[data-plan-view="ok"]') ? n : null));
        const host = await mount("app/view/agents/planpreview.tsx", "PlanPreview", { path: ${JSON.stringify(PLAN_PATH)} }, { style: ${JSON.stringify(MOUNT_STYLE)} });
        await until(() => host.querySelector('[data-plan-view="ok"]') != null, 4000);
        await nap(${SETTLE_MS});
        lw.stop();
        const loaded = { first: lw.seen[0] ?? null, settled: await settle(() => host.querySelector('[data-plan-view="ok"]')), text: flat(host.querySelector('[data-plan-view="ok"]')) };

        const ew = watchAdded((n) => (host.contains(n) && n.matches('[data-plan-view="edit"]') ? n : null));
        button(host, /^Edit$/)?.click();
        await nap(${SETTLE_MS});
        ew.stop();
        const edit = { first: ew.seen[0] ?? null, settled: await settle(() => host.querySelector('[data-plan-view="edit"]')), textarea: host.querySelector("textarea") != null };

        const xw = watchAdded((n) => (host.contains(n) && n.firstElementChild?.matches("[data-plan-save-error]") ? n : null));
        const err = () => host.querySelector("[data-plan-save-error]");
        const shakes = sampleFrames(() => (err() ? getComputedStyle(err()).transform : null));
        button(host, /^Save$/)?.click();
        await nap(${SETTLE_MS});
        xw.stop();
        shakes.stop();
        const failed = { first: xw.seen[0] ?? null, settled: await settle(() => err()?.parentElement), shakes: shakes.values, text: flat(err()), stillEditing: host.querySelector("textarea") != null };
        return { loaded, edit, failed };
    `);
    await releaseRpc(h, "FileReadCommand");
    await releaseRpc(h, "FileWriteCommand");
    rec(
        "16. plan preview: the plan replacing its loading lines fades in",
        revealed(r?.loaded) && r.loaded.text.includes("Motion plan"),
        JSON.stringify(r?.loaded ?? r)
    );
    rec(
        "17. plan preview: Edit fades the editor in where the plan was",
        revealed(r?.edit) && r.edit.textarea,
        JSON.stringify(r?.edit ?? r)
    );
    rec(
        "18. plan preview: a refused save grows its error in and nudges it sideways once, keeping the edit",
        revealed(r?.failed) &&
            r.failed.shakes.some((t) => /^matrix\(1, 0, 0, 1, -?[1-9]/.test(t)) &&
            /none|matrix\(1, 0, 0, 1, 0, 0\)/.test(r.failed.shakes.at(-1)) &&
            r.failed.text.startsWith("Couldn't save the plan") &&
            r.failed.stillEditing,
        JSON.stringify(r?.failed ?? r)
    );
    await h.shot(`cdp-shots/${NAME}-plan.png`);
}

async function launcherSteps(h, rec) {
    const r = await motionEval(h, `
        unmountAll();
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const s = await mod("app/view/agents/runconfigstore.ts");
        const names = ["runShapeAtom", "startAtom", "planPathAtom", "planPreviewAtom", "configTouchedAtom"];
        window.__motionAgentLauncher ??= Object.fromEntries(names.map((n) => [n, globalStore.get(s[n])]));
        globalStore.set(s.runShapeAtom, "quick");
        const host = await mount("app/view/agents/runlauncher.tsx", "RunLauncherSections", { projectPath: "" }, { style: ${JSON.stringify(MOUNT_STYLE)} });
        if (host.querySelector("[data-launcher-workers]") || host.querySelector("[data-launcher-worker-route]")) return { error: "orchestrator rows on quick" };
        const w = watchAdded((n) => (host.contains(n) && n.firstElementChild?.matches("[data-launcher-workers], [data-launcher-worker-route]") ? n : null));
        [...host.querySelectorAll("button[aria-pressed]")].find((b) => flat(b).startsWith("orchestrator"))?.click();
        await nap(${SETTLE_MS});
        w.stop();
        const rows = { seen: w.seen, workers: await settle(() => host.querySelector("[data-launcher-workers]")?.parentElement), route: await settle(() => host.querySelector("[data-launcher-worker-route]")?.parentElement) };

        globalStore.set(s.startAtom, "plan");
        await until(() => host.querySelector("[data-jarvis-plan-path]") != null, 2000);
        const pw = watchAdded((n) => (host.contains(n) && n.matches('[data-crossfade="error"]') ? n : null));
        globalStore.set(s.planPathAtom, "C:/motion-agent/no-such-plan.md");
        await until(() => host.querySelector('[data-jarvis-plan-preview="error"]') != null, 8000);
        await nap(${SETTLE_MS});
        pw.stop();
        const reading = { first: pw.seen[0] ?? null, settled: await settle(() => host.querySelector('[data-crossfade="error"]')), text: flat(host.querySelector('[data-jarvis-plan-preview="error"]')) };
        return { rows, reading };
    `);
    rec(
        "19. run launcher: switching to orchestrator grows the workers and worker-route rows in from opacity 0",
        r?.rows != null && r.rows.seen.length === 2 && r.rows.seen.every((o) => o < MOUNTED_HIDDEN) && r.rows.workers >= SETTLED && r.rows.route >= SETTLED,
        JSON.stringify(r?.rows ?? r)
    );
    rec(
        "20. run launcher: a plan path that will not run cross-fades the parser's message in",
        crossFaded(r?.reading) && r.reading.text !== "",
        JSON.stringify(r?.reading ?? r)
    );
    await h.shot(`cdp-shots/${NAME}-launcher.png`);
}

const restoreLauncher = (h) =>
    lookEval(h, `
        const saved = window.__motionAgentLauncher;
        if (!saved) return true;
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const s = await mod("app/view/agents/runconfigstore.ts");
        for (const [n, v] of Object.entries(saved)) globalStore.set(s[n], v);
        delete window.__motionAgentLauncher;
        return true;
    `);

const userLine = (content) => JSON.stringify({ type: "user", message: { content } });
const replyLine = (text) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolLine = (i) =>
    JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: `tu-${i}`, name: "Bash", input: { description: `step ${i}` } }] },
    });
const resultLine = (i) =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `tu-${i}`, content: "ok" }] } });
const SHORT_LINES = [userLine("motion prompt"), replyLine("motion reply")];
// A long session as one is written: turns of a prompt, calls each with its result, and a reply, longer than the tail
// so the reread comes back full and the transcript may hold earlier turns. A call left without a result is a running
// step with its own spinner, and one turn of thousands of them (spinning, never folded) starved the frames the find
// bar's growth is sampled in.
const TURN_CALLS = 50;
const TURN_LINES = 2 * TURN_CALLS + 2;
const TURNS = Math.ceil((TAIL_LINES + 200) / TURN_LINES);
const LONG_LINES = Array.from({ length: TURNS }, (_, t) => [
    userLine(t === 0 ? "motion prompt" : `prompt ${t}`),
    ...Array.from({ length: TURN_CALLS }, (_, c) => [toolLine(t * TURN_CALLS + c), resultLine(t * TURN_CALLS + c)]).flat(),
    replyLine(t === TURNS - 1 ? "motion reply" : `reply ${t}`),
]).flat();

// the session's transcript read serves window.__motionAgentTranscript (swapped by the step), tailed to maxlines
const stubTranscriptRpc = (h) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        const held = (window.__heldRpc ??= {});
        held.GetAgentTranscriptCommand ??= RpcApi.GetAgentTranscriptCommand;
        window.__motionAgentTranscript = ${JSON.stringify(SHORT_LINES)};
        RpcApi.GetAgentTranscriptCommand = async (client, data, opts) => {
            if (data?.path !== ${JSON.stringify(SOLO_PATH)}) return held.GetAgentTranscriptCommand(client, data, opts);
            const lines = window.__motionAgentTranscript;
            return { lines: data.maxlines > 0 ? lines.slice(-data.maxlines) : lines };
        };
        return true;
    `);

async function sessionDetailSteps(h, rec) {
    await stubTranscriptRpc(h);
    const r = await motionEval(h, `
        unmountAll();
        const model = await cockpitModel();
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const names = ["sessionsViewAtom", "sessionsFindAtom", "sessionsFoundAtom"];
        window.__motionAgentSessions ??= Object.fromEntries(names.map((n) => [n, globalStore.get(model[n])]));
        globalStore.set(model.sessionsViewAtom, "transcript");
        globalStore.set(model.sessionsFindAtom, null);
        const t0 = Date.now();
        const session = {
            id: ${JSON.stringify(SOLO_ID)}, runtime: "claude", projectpath: "C:/motion-agent", projectname: "motion-agent", branch: "main",
            task: "Motion session", tokenstotal: 0, lastactivets: t0, resumecommand: "", transcriptpath: ${JSON.stringify(SOLO_PATH)},
            status: "working", startedts: t0 - 600000, durationms: 600000, events: [], live: true, needsAttention: false,
        };
        const host = await mount("app/view/agents/sessionsdetail.tsx", "SoloDetail", { model, session }, { style: ${JSON.stringify(DETAIL_STYLE)} });
        if (!(await until(() => flat(host).includes("motion reply"), 4000))) return { error: "no transcript", text: flat(host) };
        if (host.querySelector("[data-sessions-earlier]")) return { error: "Show earlier turns at mount" };

        const ew = watchAdded((n) => (host.contains(n) && n.matches("[data-sessions-earlier]") ? n : null));
        window.__motionAgentTranscript = ${JSON.stringify(LONG_LINES)};
        await until(() => host.querySelector("[data-sessions-earlier]") != null, ${REREAD_MS});
        await nap(${SETTLE_MS});
        ew.stop();
        const earlierBtn = () => host.querySelector("[data-sessions-earlier]");
        const earlier = { seen: ew.seen, settled: await settle(earlierBtn), text: flat(earlierBtn()) };

        const bar = () => host.querySelector("[data-sessions-find]")?.parentElement;
        const fw = watchAdded((n) => (host.contains(n) && n.firstElementChild?.matches("[data-sessions-find]") ? n : null));
        const heights = sampleFrames(() => (bar() ? Math.round(bar().getBoundingClientRect().height) : null));
        const at = { sel: globalStore.get(model.sessionsSelAtom) };
        globalStore.set(model.sessionsFindAtom, { sessionKey: "claude:" + ${JSON.stringify(SOLO_ID)}, query: "motion", terms: ["motion"], target: { kind: "turn", ord: 0 }, at });
        await nap(${SETTLE_MS});
        fw.stop();
        heights.stop();
        const find = { first: fw.seen[0] ?? null, settled: await settle(bar), heights: heights.values, query: host.querySelector('[aria-label="Find in transcript"]')?.value ?? null };
        return { earlier, find };
    `);
    await h.shot(`cdp-shots/${NAME}-session.png`);
    // unmounted first, so the live reread stops before the real read is back
    await lookEval(h, `unmountAll(); return true;`);
    await releaseRpc(h, "GetAgentTranscriptCommand");
    await restoreSessions(h);
    rec(
        "21. session detail: a live reread coming back cut off fades Show earlier turns in from opacity 0, and only it",
        r?.earlier != null &&
            r.earlier.seen.length === 1 &&
            r.earlier.seen[0] < MOUNTED_HIDDEN &&
            r.earlier.settled >= SETTLED &&
            r.earlier.text === "Show earlier turns",
        JSON.stringify(r?.earlier ?? r)
    );
    rec(
        "22. session detail: a find opening on the transcript grows its bar in from opacity 0 through intermediate heights",
        revealed(r?.find) && r.find.heights.length >= 3 && r.find.heights.at(-1) > r.find.heights[0] && r.find.query === "motion",
        JSON.stringify(r?.find ?? r)
    );
}

const restoreSessions = (h) =>
    lookEval(h, `
        const saved = window.__motionAgentSessions;
        if (!saved) return true;
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const model = (await mod("app/store/wshrpcutil.ts")).DefaultRouter.routeMap.get("cockpit")?.model;
        if (model) for (const [n, v] of Object.entries(saved)) globalStore.set(model[n], v);
        delete window.__motionAgentSessions;
        delete window.__motionAgentTranscript;
        return true;
    `);

async function planPaneSteps(h, rec) {
    await stubPlanRpc(h);
    const r = await motionEval(h, `
        unmountAll();
        const host = await mount("app/view/agents/planpreview.tsx", "PlanPreview", { path: ${JSON.stringify(PLAN_PATH)} }, { style: ${JSON.stringify(MOUNT_STYLE)} });
        if (!(await until(() => host.querySelector('[data-plan-view="ok"]') != null, 4000))) return { error: "no plan", text: flat(host) };
        await nap(${SETTLE_MS});
        // the reveal around the scroller the view sits in
        const pane = () => host.querySelector("[data-plan-view]")?.parentElement?.parentElement;
        const height = () => (pane() ? Math.round(pane().getBoundingClientRect().height) : null);
        // its label and filename spans flatten together: "Planplan.md · 5 lines"
        const toggle = () => button(host, /^Plan/);

        const shut = sampleFrames(height);
        toggle()?.click();
        await nap(${SETTLE_MS});
        shut.stop();
        const collapse = { heights: shut.values, gone: pane() == null };

        const ow = watchAdded((n) => (host.contains(n) && n.querySelector?.("[data-plan-view]") && n.firstElementChild?.matches(".sc") ? n : null));
        const grow = sampleFrames(height);
        toggle()?.click();
        await nap(${SETTLE_MS});
        ow.stop();
        grow.stop();
        const open = { first: ow.seen[0] ?? null, settled: await settle(pane), heights: grow.values, text: flat(host.querySelector('[data-plan-view="ok"]')) };
        return { collapse, open };
    `);
    await releaseRpc(h, "FileReadCommand");
    await releaseRpc(h, "FileWriteCommand");
    rec(
        "23. plan preview: the Plan header shrinks the pane away, and opening it again grows it from opacity 0 through intermediate heights",
        r?.collapse != null &&
            r.collapse.gone &&
            r.collapse.heights.length >= 3 &&
            r.collapse.heights.at(-1) < r.collapse.heights[0] &&
            revealed(r.open) &&
            r.open.heights.length >= 3 &&
            r.open.heights.at(-1) > r.open.heights[0] &&
            r.open.text.includes("Motion plan"),
        JSON.stringify(r)
    );
    await h.shot(`cdp-shots/${NAME}-plan-pane.png`);
}

export const motionAgent = {
    name: NAME,
    surface: "cockpit",
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", OBS_WIDE);
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        // a phase that throws fails as one step and keeps the steps before it
        const phase = async (name, fn) => {
            try {
                await fn();
            } catch (e) {
                rec(`${name} ran to the end`, false, String(e?.stack ?? e));
            }
        };
        await phase("the answer bar's moments", () => answerBarSteps(h, rec));
        await phase("the working line's moments", () => workingLineSteps(h, rec));
        await phase("the tool card's moments", () => toolCardSteps(h, rec));
        await phase("the shell peek's moments", () => shellPeekSteps(h, rec));
        await phase("the run detail's moments", () => runDetailSteps(h, rec));
        await phase("the plan preview's moments", () => planPreviewSteps(h, rec));
        await phase("the run launcher's moments", () => launcherSteps(h, rec));
        await phase("the session detail's moments", () => sessionDetailSteps(h, rec));
        await phase("the plan pane's moments", () => planPaneSteps(h, rec));
        return steps;
    },
    async teardown(h) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("reset the media emulation", () => h.cdp("Emulation.setEmulatedMedia", NO_MEDIA));
        await step("clear the viewport override", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("unmount the look hosts", () =>
            lookEval(h, `unmountAll(); document.querySelector("[data-motion-agent-anchor]")?.remove(); return true;`)
        );
        await step("restore the plan reads and writes", async () => {
            await releaseRpc(h, "FileReadCommand");
            await releaseRpc(h, "FileWriteCommand");
        });
        await step("restore the transcript reads", () => releaseRpc(h, "GetAgentTranscriptCommand"));
        await step("restore the sessions' view and find", () => restoreSessions(h));
        await step("restore the launcher's config", () => restoreLauncher(h));
    },
};
