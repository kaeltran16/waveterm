// Cockpit review scenarios: a launch stays on the Cockpit.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    MODELS_VIEWPORT,
    lookEval,
    lookOpen,
    lookShot,
    polishNap,
    setInputExpr,
    skipStep,
    waveService,
} from "./scenarios-shared.mjs";

// unique per run, so a leftover tab of an earlier run can never take this project's first name
const LAUNCH_PROJECT = `verify-launch-${Date.now().toString(36)}`;
// a harmless process that outlives the scenario's checks and reports no agent status; closing its tab ends it
const LAUNCH_COMMAND = "ping -n 900 127.0.0.1";
// enough projects before LAUNCH_PROJECT (the list sorts by name) that it sits past the 236px list's fold
const FILLER_COUNT = 12;
const FILLER_PREFIX = `aa-fill-${Date.now().toString(36)}-`;
const LAYOUT_VIEWPORTS = [
    { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false },
    { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false },
];
const FLAGS_KEY = "agent.launch.flags";
const RECENT_KEY = "agent.launch.recentprojects";
const RUNNING_WAIT_MS = 15_000;
const ROW_WAIT_MS = 15_000;

// the cockpit's model, found the way the other scenarios find it: on the nav rail's props
const MODEL = `(() => {
    const nav = document.querySelector('nav');
    const key = nav && Object.keys(nav).find((k) => k.startsWith('__reactFiber$'));
    for (let f = key ? nav[key] : null; f != null; f = f.return) {
        if (f.memoizedProps?.model?.surfaceAtom != null) return f.memoizedProps.model;
    }
    return null;
})()`;

// opens New agent on the Cockpit and reads which project it preselects
const openNewAgent = (h) =>
    lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const model = ${MODEL};
        globalStore.set(model.newAgentOpenAtom, true);
        const modal = () => [...document.querySelectorAll('[role="dialog"]')].find((d) => /New agent/.test(flat(d.querySelector("h2"))));
        await until(() => modal()?.querySelector('[role="radiogroup"][aria-label="Project"] [aria-checked="true"]') != null, 5000);
        await nap(300);
        return {
            open: modal() != null,
            preselected: flat(modal()?.querySelector('[role="radiogroup"][aria-label="Project"] [aria-checked="true"]')),
        };
    `);

// With the dialog open: whether the preselected project row lies inside the list's own scroller, and whether the
// Codex mark loads and carries the near-white fill. Codex is offered only when installed, so the harness catalog
// is emptied (which offers every runtime) just while it is read, then put back.
const measureModalExpr = `
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const { harnessesAtom } = await mod("app/view/agents/harnessstore.ts");
    const modal = [...document.querySelectorAll('[role="dialog"]')].find((d) => /New agent/.test(flat(d.querySelector("h2"))));
    const row = modal?.querySelector('[role="radiogroup"][aria-label="Project"] [aria-checked="true"]');
    const scroller = row?.parentElement;
    if (!row || !scroller) return { found: false };
    const s = scroller.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const out = {
        found: true,
        listScrolls: scroller.scrollHeight > scroller.clientHeight + 1,
        scrollTop: Math.round(scroller.scrollTop),
        row: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
        scroller: { top: Math.round(s.top), bottom: Math.round(s.bottom) },
        rowInside: r.top >= s.top - 1 && r.bottom <= s.bottom + 1,
    };
    const prev = globalStore.get(harnessesAtom);
    globalStore.set(harnessesAtom, []);
    try {
        const mark = () => button(modal.querySelector('[role="radiogroup"][aria-label="Runtime"]'), /Codex/)?.querySelector("img");
        out.codexRow = await until(() => mark() != null, 3000);
        const img = mark();
        if (img) {
            out.codexLoaded = await until(() => img.complete && img.naturalWidth > 0, 5000);
            out.codexFill = (await (await fetch(img.src)).text()).includes("#ececec");
        }
    } finally {
        globalStore.set(harnessesAtom, prev);
    }
    return out;
`;

// opens New agent at a viewport, measures it, closes it, and puts the viewport back
async function modalLayoutAt(h, viewport) {
    await h.cdp("Emulation.setDeviceMetricsOverride", viewport);
    try {
        await polishNap(400);
        const opened = await openNewAgent(h);
        const m = await lookEval(h, measureModalExpr);
        await h.shot(lookShot(`cockpit-launch-stays-modal-${viewport.width}`));
        await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            globalStore.set(${MODEL}.newAgentOpenAtom, false);
            await until(() => ![...document.querySelectorAll('[role="dialog"]')].some((d) => /New agent/.test(flat(d.querySelector("h2")))), 5000);
        `);
        return { opened, ...m };
    } finally {
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
    }
}

// picks the Claude Code runtime (an agent runtime: a pending card and a started controller), types the
// command, launches, and returns the new tab once the modal has closed on success
async function launchFromModal(h) {
    await lookEval(h, `
        const modal = [...document.querySelectorAll('[role="dialog"]')].find((d) => /New agent/.test(flat(d.querySelector("h2"))));
        button(modal?.querySelector('[role="radiogroup"][aria-label="Runtime"]'), /Claude Code/)?.click();
        await nap(200);
    `);
    await h.ev(setInputExpr(`document.getElementById("na-cmd")`, LAUNCH_COMMAND));
    return lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const model = ${MODEL};
        const modal = () => [...document.querySelectorAll('[role="dialog"]')].find((d) => /New agent/.test(flat(d.querySelector("h2"))));
        const before = new Set(globalStore.get(model.pendingLaunchesAtom).map((p) => p.tabId));
        await nap(200);
        button(modal(), /^Launch agent/)?.click();
        const closed = await until(() => modal() == null, 15000);
        const pending = globalStore.get(model.pendingLaunchesAtom).find((p) => !before.has(p.tabId) && p.project === ${JSON.stringify(LAUNCH_PROJECT)});
        return {
            closed,
            error: closed ? null : flat(modal()),
            tabId: pending?.tabId ?? null,
            blockId: pending?.blockId ?? null,
            pendingName: pending?.name ?? null,
            surface: globalStore.get(model.surfaceAtom),
        };
    `);
}

async function controllerStatus(h, blockId) {
    for (let waited = 0; waited < RUNNING_WAIT_MS; waited += 250) {
        const rs = await waveService(h, "block", "GetControllerStatus", [blockId]).catch(() => null);
        if (rs?.shellprocstatus === "running") return rs.shellprocstatus;
        await polishNap(250);
    }
    return (await waveService(h, "block", "GetControllerStatus", [blockId]).catch(() => null))?.shellprocstatus ?? null;
}

export const cockpitLaunchStays = {
    name: "cockpit-launch-stays",
    surface: "cockpit",
    async arrange(h) {
        const ctx = { name: LAUNCH_PROJECT, tabIds: [] };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            ctx.dir = mkdtempSync(join(tmpdir(), "verify-launch-stays-"));
            ctx.fillers = Array.from({ length: FILLER_COUNT }, (_, i) => {
                const dir = join(ctx.dir, `fill-${i}`);
                mkdirSync(dir);
                return { name: `${FILLER_PREFIX}${String(i).padStart(2, "0")}`, dir };
            });
            ctx.prevFlags = await h.ev(`localStorage.getItem(${JSON.stringify(FLAGS_KEY)})`);
            ctx.prevRecent = await h.ev(`localStorage.getItem(${JSON.stringify(RECENT_KEY)})`);
            const r = await lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                const { atoms } = await mod("app/store/global-atoms.ts");
                const ps = await mod("app/view/agents/projectsstore.ts");
                const { naFlagsAtom } = await mod("app/view/agents/naflagsstore.ts");
                const model = ${MODEL};
                // registered as New project does, then scoped as it scopes
                await ps.registerProject(${JSON.stringify(LAUNCH_PROJECT)}, ${JSON.stringify(ctx.dir)});
                const fillers = ${JSON.stringify(ctx.fillers)};
                for (const f of fillers) await ps.registerProject(f.name, f.dir);
                const names = [${JSON.stringify(LAUNCH_PROJECT)}, ...fillers.map((f) => f.name)];
                const listed = await until(() => names.every((n) => globalStore.get(ps.projectListAtom).some((p) => p.name === n)), 10000);
                const prevScope = globalStore.get(model.projectFilterAtom);
                globalStore.set(model.projectFilterAtom, ${JSON.stringify(LAUNCH_PROJECT)});
                // a remembered flag would be appended to the command and make it exit
                globalStore.set(naFlagsAtom, {});
                return { listed, prevScope, workspaceId: globalStore.get(atoms.workspace)?.oid ?? null };
            `);
            ctx.madeProject = true;
            ctx.prevScope = r.prevScope;
            ctx.workspaceId = r.workspaceId;
            if (!r.listed) throw new Error(`project ${LAUNCH_PROJECT} never reached the project list`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError != null) {
            return [skipStep("cockpit-launch-stays", `could not verify: the arrange failed: ${ctx.arrangeError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        await lookOpen(h, "cockpit");

        // before any launch: a launch moves LAUNCH_PROJECT to the head of the recent-first list
        for (const vp of LAYOUT_VIEWPORTS) {
            const at = `${vp.width}x${vp.height}`;
            const m = await modalLayoutAt(h, vp);
            const detail = JSON.stringify(m);
            rec(
                `New agent scrolls the preselected project into its list at ${at}`,
                m.opened?.preselected === LAUNCH_PROJECT && m.listScrolls && m.scrollTop > 0 && m.rowInside,
                detail
            );
            rec(
                `New agent's Codex mark loads and is near-white at ${at}`,
                m.codexRow === true && m.codexLoaded === true && m.codexFill === true,
                detail
            );
        }

        const first = await openNewAgent(h);
        await h.shot(lookShot("cockpit-launch-stays-modal"));
        rec("New agent preselects the scoped project", first.open && first.preselected === LAUNCH_PROJECT, JSON.stringify(first));
        const one = await launchFromModal(h);
        if (one.tabId) ctx.tabIds.push(one.tabId);
        await polishNap(600);
        await h.shot(lookShot("cockpit-launch-stays-launched"));
        rec(
            "a launch from the Cockpit stays on the Cockpit",
            one.closed && one.tabId != null && one.surface === "cockpit",
            JSON.stringify(one)
        );
        if (one.blockId == null) return steps;

        const status = await controllerStatus(h, one.blockId);
        // the Agent surface stays mounted off-screen and mounts every agent's terminal there hidden; a hidden
        // terminal never resyncs, so a running process was started by the launch, not by a terminal
        const shown = await h.ev(
            `document.querySelector('[data-agent-terminal="${one.tabId}"]')?.checkVisibility() ?? false`
        );
        rec(
            "the launched process is running before its terminal is opened",
            status === "running" && shown === false,
            JSON.stringify({ status, terminalShown: shown })
        );

        const second = await openNewAgent(h);
        const two = await launchFromModal(h);
        if (two.tabId) ctx.tabIds.push(two.tabId);
        // a ping reports no agent status, so it never becomes a cockpit roster card; its roster name is the label
        // the session view model gives its tab, read through the app's own module
        const labels = await lookEval(h, `
            const { globalStore } = await mod("app/store/jotaiStore.ts");
            const sm = await mod("app/view/agents/session-models/sessionsidebarmodel.ts");
            const rows = () => globalStore.get(sm.sessionSidebarViewModelAtom).groups.flatMap((g) => g.sessions);
            const label = (id) => rows().find((r) => r.tabId === id)?.label ?? null;
            await until(() => label(${JSON.stringify(one.tabId)}) != null && label(${JSON.stringify(two.tabId)}) != null, ${ROW_WAIT_MS});
            return { first: label(${JSON.stringify(one.tabId)}), second: label(${JSON.stringify(two.tabId)}) };
        `);
        await h.shot(lookShot("cockpit-launch-stays-second"));
        rec(
            `a second launch in one project is named <project> 2 in the roster`,
            second.preselected === LAUNCH_PROJECT &&
                two.surface === "cockpit" &&
                labels.first === LAUNCH_PROJECT &&
                labels.second === `${LAUNCH_PROJECT} 2` &&
                two.pendingName === labels.second,
            `read from sessionSidebarViewModelAtom (a ping reports no agent status, so it gets no Agent tree agent row): ${JSON.stringify({ ...labels, pendingName: two.pendingName, surface: two.surface })}`
        );
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`cockpit-launch-stays teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        for (const tabId of ctx.tabIds ?? []) {
            await step("close a launched tab", () => waveService(h, "workspace", "CloseTab", [ctx.workspaceId, tabId, false]));
        }
        await step("restore the scope, flags and recent projects", () =>
            lookEval(h, `
                const { globalStore } = await mod("app/store/jotaiStore.ts");
                const { naFlagsAtom } = await mod("app/view/agents/naflagsstore.ts");
                const { recentProjectsAtom } = await mod("app/view/agents/projectsstore.ts");
                const model = ${MODEL};
                if (model && ${JSON.stringify(ctx.prevScope ?? null)} != null) globalStore.set(model.projectFilterAtom, ${JSON.stringify(ctx.prevScope ?? "all")});
                if (${JSON.stringify("prevFlags" in ctx)}) globalStore.set(naFlagsAtom, JSON.parse(${JSON.stringify(ctx.prevFlags ?? "{}")}));
                if (${JSON.stringify("prevRecent" in ctx)}) globalStore.set(recentProjectsAtom, JSON.parse(${JSON.stringify(ctx.prevRecent ?? "[]")}));
            `)
        );
        if (ctx.madeProject) await step("delete the project", () => h.rpc("deleteproject", { name: ctx.name }));
        for (const f of ctx.fillers ?? []) {
            await step("delete a filler project", () => h.rpc("deleteproject", { name: f.name }));
        }
        await step("clear the viewport override", () => h.cdp("Emulation.clearDeviceMetricsOverride"));
        if (ctx.dir) await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 3 }));
        await step("go home", () => h.goto("cockpit"));
    },
};
