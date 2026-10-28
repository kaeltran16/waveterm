// Palette and new-run scenarios: route picker, new run window, palette actions, goal, notes.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vaultRemote, vaultRoot } from "./notes-wsh.mjs";
import {
    MIN_FONT_PX,
    MODELS_PLAN,
    MODELS_VIEWPORT,
    NEW_RUN,
    NEW_RUN_FIELD,
    NEW_RUN_GOAL,
    NEW_RUN_LIST,
    NOTES_CLIP_RESTORE,
    PALETTE,
    PALETTE_INPUT,
    PALETTE_STATE,
    PALETTE_TOGGLE,
    PEEKS_ESC,
    RUN_SHEET,
    UI_ROUTE,
    channelRuns,
    clickByText,
    flatText,
    floorStep,
    lookEval,
    notesClipStub,
    openAddressExpr,
    openPalette,
    paletteKey,
    paletteStateWhen,
    polishNap,
    polishReload,
    polishWaitFor,
    setInputExpr,
    skipStep,
    teardownFixtureRun,
    waitForProjectInConfig,
} from "./scenarios-shared.mjs";

// ROUTE_PICKER_MAX_HEIGHT in frontend/app/view/agents/routepicker.tsx
const ROUTE_PICKER_MAX_HEIGHT = 480;

export const routePickerFlat = {
    name: "route-picker-flat",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const pressKey = async (key, windowsVirtualKeyCode) => {
            await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode });
            await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode });
        };
        await h.goto("settings");
        // the two-pane Settings surface renders one section at a time; the route picker lives in Run defaults
        await h.ev(
            `(() => { const b = document.querySelector('[data-section="run"]'); if (b) b.click(); return true; })()`
        );
        await settle(200);
        const pickerPresent = await h.ev(`(() => !!document.querySelector('[data-testid="route-picker"]'))()`);
        await h.ev(
            `(() => { document.querySelector('[data-testid="route-picker"]')?.scrollIntoView({ block: "center" }); return true; })()`
        );
        await settle(200);
        await h.ev(
            `(() => { const b = document.querySelector('[data-testid="route-picker"]'); if (b) b.click(); return true; })()`
        );
        await settle(400);
        const rowCount = await h.ev(`(() => document.querySelectorAll('[data-testid^="route-option-"]').length)()`);
        rec(
            "route picker opens with flat model rows",
            pickerPresent === true && rowCount > 0,
            `picker=${pickerPresent} rows=${rowCount}`
        );
        const layout = await h.ev(`(() => {
            const group = document.querySelector('[aria-label="Available routes"]');
            const panel = group?.parentElement;
            const scroll = document.querySelector('[data-testid="route-picker-scroll"]');
            if (!panel || !scroll) return null;
            const rect = panel.getBoundingClientRect();
            return {
                top: rect.top,
                bottom: rect.bottom,
                height: rect.height,
                viewportHeight: window.innerHeight,
                overflowY: getComputedStyle(scroll).overflowY,
                scrollHeight: scroll.scrollHeight,
                clientHeight: scroll.clientHeight,
            };
        })()`);
        rec(
            "route picker stays within the viewport and scrolls model rows",
            layout != null &&
                layout.top >= 8 &&
                layout.bottom <= layout.viewportHeight - 8 &&
                layout.height <= ROUTE_PICKER_MAX_HEIGHT &&
                layout.overflowY === "auto" &&
                layout.scrollHeight > layout.clientHeight,
            JSON.stringify(layout)
        );
        const openFocus = await h.ev(`document.activeElement?.getAttribute('aria-label') ?? ''`);
        rec("opening the route picker focuses its filter", openFocus === "Filter models", `focus="${openFocus}"`);
        await pressKey("ArrowDown", 40);
        await settle(100);
        const arrowFocus = await h.ev(`document.activeElement?.getAttribute('data-testid') ?? ''`);
        rec(
            "ArrowDown moves focus from the filter to a model row",
            arrowFocus.startsWith("route-option-"),
            `focus="${arrowFocus}"`
        );
        await pressKey("Escape", 27);
        await settle(100);
        const escapeState = await h.ev(`(() => {
            const picker = document.querySelector('[data-testid="route-picker"]');
            return { expanded: picker?.getAttribute('aria-expanded'), focused: document.activeElement === picker };
        })()`);
        rec(
            "Escape closes the route picker and restores trigger focus",
            escapeState?.expanded === "false" && escapeState.focused === true,
            JSON.stringify(escapeState)
        );
        await h.ev(`document.querySelector('[data-testid="route-picker"]')?.click()`);
        await settle(400);
        await h.shot("cdp-shots/route-picker-flat.png");
        // filter shrinks the row set
        const filterTyped = await h.ev(`(() => {
            const input = document.querySelector('input[aria-label="Filter models"]');
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, "opus");
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await settle(300);
        const filteredCount = await h.ev(
            `(() => document.querySelectorAll('[data-testid^="route-option-"]').length)()`
        );
        rec(
            "filter shrinks model rows",
            filterTyped === true && filteredCount > 0 && filteredCount < rowCount,
            `rows=${rowCount} filtered=${filteredCount}`
        );
        // choosing a row updates the face off "capable"
        await h.ev(`(() => {
            const input = document.querySelector('input[aria-label="Filter models"]');
            if (input) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(input, "");
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const row = document.querySelector('[data-testid^="route-option-"]');
            if (row) row.click();
            return true;
        })()`);
        await settle(400);
        const face = await h.ev(
            `((document.querySelector('[data-testid="route-picker"]')||{}).textContent||'').trim()`
        );
        rec("face shows the chosen model", !face.includes("· capable"), `face="${face}"`);
        return steps;
    },
};

// --- route-picker-refused: a route its provider refused is dimmed and named in the picker ----------------------
// Run bf3a2fe3 met a lapsed OpenCode Go plan: every turn came back 403. The engine records such a refusal in
// refused-routes.json in the data dir; this seeds one for a real catalog model and checks the row says so.
export const routePickerRefused = {
    name: "route-picker-refused",
    surface: "cockpit",
    async arrange(h) {
        const info = await h.rpc("waveinfo", null);
        const catalog = await h.rpc("listharnesses", null, { timeout: 30000 });
        const capability = (catalog?.harnesses ?? [])
            .filter((x) => x.installed && x.runworkercapable)
            .flatMap((x) => x.routecapabilities ?? [])
            .find((c) => c.model);
        const file = join(info.datadir, "refused-routes.json");
        // the dev store's own refusals are put back in teardown
        const saved = existsSync(file) ? readFileSync(file, "utf8") : null;
        if (capability) {
            const mark = {
                runtime: capability.runtime,
                model: capability.model,
                text: "403: An active subscription is required",
                ts: Date.now(),
            };
            writeFileSync(file, JSON.stringify([mark], null, 2));
        }
        return { file, saved, runtime: capability?.runtime, model: capability?.model };
    },
    async assert(h, ctx) {
        if (!ctx.model) {
            return [skipStep("a refused catalog row is dimmed and named", "no installed run-worker harness lists a model")];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const row = `document.querySelector('[data-testid=${JSON.stringify(`route-option-${ctx.runtime}-${ctx.model}`)}]')`;
        await h.goto("settings");
        await h.ev(`(() => { document.querySelector('[data-section="run"]')?.click(); return true; })()`);
        await settle(200);
        await h.ev(`(() => {
            const b = document.querySelector('[data-testid="route-picker"]');
            b?.scrollIntoView({ block: "center" });
            b?.click();
            return true;
        })()`);
        await settle(400);
        // the filter brings the seeded row to the top of a catalog that can run to hundreds of rows
        await h.ev(`(() => {
            const input = document.querySelector('input[aria-label="Filter models"]');
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, ${JSON.stringify(ctx.model)});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await settle(400);
        const state = await h.ev(`(() => {
            const r = ${row};
            if (!r) return null;
            return {
                refused: r.getAttribute('data-refused'),
                text: r.textContent,
                title: r.getAttribute('title'),
                opacity: getComputedStyle(r).opacity,
            };
        })()`);
        rec(
            "a refused catalog row is dimmed and names the refusal",
            state != null &&
                state.refused === "true" &&
                /refused 403 · \w{3} \d{1,2}/.test(state.text ?? "") &&
                Number(state.opacity) < 1 &&
                (state.title ?? "").startsWith("403:"),
            JSON.stringify(state)
        );
        await h.shot("cdp-shots/route-picker-refused.png");
        await h.ev(`(() => { ${row}?.click(); return true; })()`);
        await settle(400);
        const face = await h.ev(`((document.querySelector('[data-testid="route-picker"]')||{}).textContent||'').trim()`);
        rec("choosing the refused route warns on the picker's face", face.endsWith("refused"), `face="${face}"`);
        await h.shot("cdp-shots/route-picker-refused-face.png");
        return steps;
    },
    async teardown(_h, ctx) {
        if (ctx.saved != null) {
            writeFileSync(ctx.file, ctx.saved);
        } else {
            // wavesrv may be mid-read of it for the picker, which Windows reports as EBUSY
            rmSync(ctx.file, { force: true, maxRetries: 10, retryDelay: 200 });
        }
    },
};
const NEW_RUN_WORKERS = `${NEW_RUN}?.querySelector('[data-testid="route-picker"][aria-label="Workers model"]')`;
const NEW_RUN_PROJECT = "verify-new-run-window";
const NEW_RUN_LIGHT_GOAL =
    "verify new-run-window: a UI check drives this run; do nothing, make no file changes, submit no plan, and wait idle";
const RECENT_PROJECTS_KEY = "agent.launch.recentprojects";

// the list's group labels in order, and whether the project is listed under Recent
const newRunListExpr = (name) => `(() => {
    const list = ${NEW_RUN_LIST};
    if (!list) return null;
    const items = [...list.children].map((el) =>
        el.tagName === 'SPAN' ? { label: el.textContent.trim() } : { option: el.getAttribute('data-project-option') }
    );
    const at = items.findIndex((i) => i.option === ${JSON.stringify(name)});
    const recentAt = items.findIndex((i) => i.label === 'Recent');
    const allAt = items.findIndex((i) => i.label === 'All projects');
    return {
        labels: items.filter((i) => i.label != null).map((i) => i.label),
        listed: at >= 0,
        inRecent: recentAt >= 0 && at > recentAt && (allAt < 0 || at < allAt),
    };
})()`;

// a row's first cell is its task id; the needs cell can also read t-N, so only a first child counts
const NEW_RUN_PLAN = `(() => {
    const ready = ${NEW_RUN}?.querySelector('[data-jarvis-plan-preview="ready"]');
    if (!ready) return { error: (${NEW_RUN}?.querySelector('[data-jarvis-plan-preview="error"]')?.textContent ?? null) };
    const spans = [...ready.querySelectorAll('span')];
    const rows = spans
        .filter((s) => s.parentElement.firstElementChild === s && /^t-\\d+$/.test(s.textContent.trim()))
        .map((s) => {
            const cell = s.parentElement.lastElementChild;
            return {
                id: s.textContent.trim(),
                model: cell.textContent.trim(),
                struck: getComputedStyle(cell).textDecorationLine.includes('line-through'),
            };
        });
    const mix = spans.find((s) => /set by the plan|^all on /.test(s.textContent.trim()));
    return { rows, mix: mix ? mix.textContent.trim() : null };
})()`;

// the picker's rows are portaled out of the window, but only one picker is open at a time
async function pickWorkers(h, testId) {
    await h.ev(`${NEW_RUN_WORKERS}?.click()`);
    if (await polishWaitFor(h, `!!document.querySelector('[data-testid="${testId}"]')`, 3000)) {
        await h.ev(`document.querySelector('[data-testid="${testId}"]').click()`);
    }
    await polishNap(400);
    return h.ev(flatText(NEW_RUN_WORKERS));
}

async function channelRunCount(h, channelId) {
    return (await channelRuns(h, channelId)).length;
}

// Opens a route picker on its claude rows and picks model: its catalog row, or the custom model id when the catalog
// has none (the claude catalog lists no haiku). Returns the model, or null when the picker never offered claude.
// The rows are portaled out of their dialog, but only one picker is open at a time.
async function pickClaudeRoute(h, pickerExpr, model) {
    const anyClaude = `document.querySelector('[data-testid^="route-option-claude-"]')`;
    const row = `document.querySelector('[data-testid="route-option-claude-${model}"]')`;
    // a section is the header, its rows and its custom id entry
    const section = `${anyClaude}?.parentElement`;
    await h.ev(`${pickerExpr}?.click()`);
    await polishWaitFor(h, `!!document.querySelector('[data-testid="route-picker-scroll"]')`, 3000);
    // the picker opens scoped to the route it holds, which can be another harness
    await h.ev(`document.querySelector('[data-testid="route-harness-all"]')?.click()`);
    if (!(await polishWaitFor(h, `!!${anyClaude}`, 5000))) {
        await h.ev(`${pickerExpr}?.click()`);
        return null;
    }
    if (await h.ev(`!!${row}`)) {
        await h.ev(`${row}.click()`);
    } else {
        await h.ev(clickByText(section, "button", "custom model id…"));
        await polishWaitFor(h, `!!${section}?.querySelector('input[aria-label^="Custom model id for"]')`, 2000);
        await h.ev(setInputExpr(`${section}?.querySelector('input[aria-label^="Custom model id for"]')`, model));
        await polishNap(100);
        await h.ev(`${section}?.querySelector('button[aria-label="Use custom model"]')?.click()`);
    }
    await polishNap(300);
    return model;
}

// Starts an orchestrator run from a goal in the window, lead and Light reviewers on a haiku route. The goal keeps
// the lead idle, so the run has no dag when the run sheet step edits it.
async function newRunWithLightReviewers(h, ctx) {
    const out = { row: null, picked: null, lead: null, run: null };
    await h.ev(`document.querySelector('[data-new-run]')?.click()`);
    if (!(await polishWaitFor(h, `!!${NEW_RUN}`, 5000))) return { ...out, why: "the window did not open" };
    await h.ev(`${NEW_RUN_FIELD}?.click()`);
    await polishWaitFor(h, `!!${NEW_RUN_LIST}`, 3000);
    await h.ev(setInputExpr(`${NEW_RUN}?.querySelector('input[aria-label="Search projects"]')`, NEW_RUN_PROJECT));
    await polishNap(300);
    await h.ev(`${NEW_RUN_LIST}?.querySelector('[data-project-option="${NEW_RUN_PROJECT}"]')?.click()`);
    await polishNap(300);
    await h.ev(
        `[...(${NEW_RUN}?.querySelectorAll('button[aria-pressed]') ?? [])].find((b) => b.firstElementChild?.textContent.trim() === 'orchestrator')?.click()`
    );
    await polishNap(200);
    await h.ev(clickByText(`${NEW_RUN}?.querySelector('[role="group"][aria-label="Start from"]')`, "button", "Goal"));
    await h.ev(`(() => {
        const el = ${NEW_RUN_GOAL};
        if (!el) return false;
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(NEW_RUN_LIGHT_GOAL)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    out.lead = await pickClaudeRoute(h, `${NEW_RUN}?.querySelector('[data-testid="route-picker"][aria-label="Lead model"]')`, "haiku");
    out.picked = await pickClaudeRoute(h, `${NEW_RUN}?.querySelector('[data-light-reviewers-row] [data-testid="route-picker"]')`, "haiku");
    out.row = await h.ev(`(() => {
        const row = ${NEW_RUN}?.querySelector('[data-light-reviewers-row]');
        return row ? { label: ${flatText("row.firstElementChild")}, face: ${flatText(`row.querySelector('[data-testid="route-picker"]')`)} } : null;
    })()`);
    await h.shot("cdp-shots/new-run-window-3-light-reviewers.png");
    const before = new Set((await channelRuns(h, ctx.channelId)).map((r) => r.id));
    await h.ev(`${NEW_RUN_START}?.click()`);
    for (let waited = 0; waited < 20000 && out.run == null; waited += 500) {
        out.run = (await channelRuns(h, ctx.channelId)).find((r) => !before.has(r.id)) ?? null;
        if (out.run == null) await polishNap(500);
    }
    if (out.run == null) {
        out.why = await h.ev(flatText(NEW_RUN));
        await h.ev(clickByText(NEW_RUN, "button", "Cancel"));
    }
    ctx.createdRunId = out.run?.id;
    ctx.createdLandPath = out.run?.landpath;
    return out;
}

// On the window's run, before it has a dag: reads the run sheet's config line, opens adjust, moves Light reviewers
// to a sonnet route and saves.
async function editSheetLightReviewers(h, ctx) {
    const config = `${RUN_SHEET}?.querySelector('[data-jarvis-brief-sheet-config="editable"]')`;
    const row = `${RUN_SHEET}?.querySelector('[data-light-reviewers-row]')`;
    const runNow = async () => (await channelRuns(h, ctx.channelId)).find((r) => r.id === ctx.createdRunId) ?? null;
    const out = { dag: (await runNow())?.dagoref ?? "", summary: "", row: false, picked: null, saved: false, after: null };
    await h.goto("jarvis");
    await h.ev(openAddressExpr(`run:${ctx.createdRunId}`));
    if (!(await polishWaitFor(h, `!!${config}`, 10000))) return { ...out, why: "no editable config line on the run sheet" };
    out.summary = await h.ev(flatText(config));
    await h.ev(clickByText(config, "button", "adjust"));
    out.row = await polishWaitFor(h, `!!${row}`, 3000);
    out.picked = await pickClaudeRoute(h, `${row}?.querySelector('[data-testid="route-picker"]')`, "sonnet");
    await h.shot("cdp-shots/new-run-window-4-run-sheet.png");
    await h.ev(clickByText(RUN_SHEET, "button", "Save settings"));
    out.saved = await polishWaitFor(h, `!!${RUN_SHEET}?.querySelector('[data-jarvis-brief-sheet-state="saved"]')`, 8000);
    for (let waited = 0; waited < 5000; waited += 250) {
        out.after = (await runNow())?.lightreviewerroute ?? null;
        if (out.after?.model === out.picked) break;
        await polishNap(250);
    }
    await h.ev(PEEKS_ESC);
    return out;
}

// A channel with no run: its brief sheet is the launcher, whose orchestrator shape shows the routing pickers.
async function launcherLightReviewers(h, ctx) {
    const sheet = `document.querySelector('[data-jarvis-brief-sheet]')`;
    const row = `${sheet}?.querySelector('[data-light-reviewers-row]')`;
    await h.ev(openAddressExpr(`channel:${ctx.launcherChannelId}`));
    const out = { sheet: await polishWaitFor(h, `!!${sheet}?.querySelector('button[aria-pressed]')`, 8000) };
    await h.ev(
        `[...(${sheet}?.querySelectorAll('button[aria-pressed]') ?? [])].find((b) => b.firstElementChild?.textContent.trim() === 'orchestrator')?.click()`
    );
    out.row = await polishWaitFor(h, `!!${row}`, 3000);
    Object.assign(
        out,
        await h.ev(`({
            besideReviewers: !!${row}?.previousElementSibling?.querySelector('[data-testid="route-picker"][aria-label="Reviewers model"]'),
            face: ${flatText(`${row}?.querySelector('[data-testid="route-picker"][aria-label="Light reviewers model"]')`)},
        })`)
    );
    await h.shot("cdp-shots/new-run-window-5-launcher.png");
    await h.ev(PEEKS_ESC);
    return out;
}

export const newRunWindow = {
    name: "new-run-window",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-new-run-window-"));
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.rpc("createproject", { name: NEW_RUN_PROJECT, path: cwd });
            ctx.project = NEW_RUN_PROJECT;
            await waitForProjectInConfig(h, NEW_RUN_PROJECT);
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-new-run-window", projectpath: cwd });
            ctx.channelId = ch.oid;
            // a run held in planning makes the project recent without starting a worker
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: "verify new-run-window: do nothing, make no file changes, stop immediately",
                runtime: "claude",
                mode: "orchestrator",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            // a channel with no run, on a project of its own so the window's run cannot land in it: its brief sheet
            // is the launcher
            ctx.launcherCwd = mkdtempSync(join(tmpdir(), "verify-new-run-launcher-"));
            const launcher = await h.rpc("createchannel", { name: "verify-new-run-launcher", projectpath: ctx.launcherCwd });
            ctx.launcherChannelId = launcher.oid;
            // recent is the shared recent-projects list (projectsstore's recentProjectsAtom), which a launch
            // writes; seed it rather than launch, and put the developer's own list back in teardown
            ctx.prevRecent = await h.ev(`localStorage.getItem(${JSON.stringify(RECENT_PROJECTS_KEY)})`);
            const recent = [NEW_RUN_PROJECT, ...JSON.parse(ctx.prevRecent ?? "[]")];
            await h.ev(`localStorage.setItem(${JSON.stringify(RECENT_PROJECTS_KEY)}, ${JSON.stringify(JSON.stringify(recent))})`);
            // the window reads the boot-primed channel list
            await polishReload(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. the project, its channel, a planning run and its recent entry were made", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        // off the Brief on purpose: the app-bar button has to work where the Brief never loaded the channels
        await h.goto("files");
        await h.ev(`document.querySelector('[data-new-run]')?.click()`);
        const opened = await polishWaitFor(h, `!!${NEW_RUN}`, 5000);
        rec("1. New run opens the window from the app bar", opened, `dialog=${opened}`);
        if (!opened) return steps;

        await h.ev(`${NEW_RUN_FIELD}?.click()`);
        await polishWaitFor(h, `!!${NEW_RUN_LIST}`, 3000);
        const listed = await h.ev(newRunListExpr(NEW_RUN_PROJECT));
        await h.shot("cdp-shots/new-run-window-1-picker.png");
        rec(
            "2. the project picker lists Recent, holding the project, then All projects",
            listed != null && listed.labels[0] === "Recent" && listed.labels.includes("All projects") && listed.inRecent,
            JSON.stringify(listed)
        );
        // the picker shows only while its list is open
        steps.push(await floorStep(h, `2b. no visible text in the open project picker is under ${MIN_FONT_PX}px`, `${NEW_RUN_LIST}?.parentElement`));

        await h.ev(setInputExpr(`${NEW_RUN}?.querySelector('input[aria-label="Search projects"]')`, NEW_RUN_PROJECT));
        await polishNap(300);
        const searched = await h.ev(newRunListExpr(NEW_RUN_PROJECT));
        rec(
            "3. a query drops Recent and shows Matches",
            searched != null && !searched.labels.includes("Recent") && searched.labels[0] === "Matches" && searched.listed,
            JSON.stringify(searched)
        );

        await h.ev(`${NEW_RUN_LIST}?.querySelector('[data-project-option="${NEW_RUN_PROJECT}"]')?.click()`);
        await polishNap(300);
        const field = await h.ev(`({ expanded: ${NEW_RUN_FIELD}?.getAttribute('aria-expanded'), text: ${flatText(NEW_RUN_FIELD)} })`);
        rec(
            "4. picking the project closes the list on it",
            field.expanded === "false" && field.text.startsWith(NEW_RUN_PROJECT),
            JSON.stringify(field)
        );

        await h.ev(
            `[...(${NEW_RUN}?.querySelectorAll('button[aria-pressed]') ?? [])].find((b) => b.firstElementChild?.textContent.trim() === 'orchestrator')?.click()`
        );
        await polishNap(200);
        await h.ev(
            `[...(${NEW_RUN}?.querySelectorAll('[role="group"][aria-label="Start from"] button') ?? [])].find((b) => b.textContent.trim() === 'Plan file')?.click()`
        );
        await polishWaitFor(h, `!!${NEW_RUN}?.querySelector('[data-jarvis-plan-path]')`, 3000);
        await h.ev(setInputExpr(`${NEW_RUN}?.querySelector('[data-jarvis-plan-path]')`, MODELS_PLAN));
        // the profile may name a workers route, so Same as lead is chosen rather than assumed
        const sameAsLead = await pickWorkers(h, "route-option-inherit");
        await polishWaitFor(h, `!!${NEW_RUN}?.querySelector('[data-jarvis-plan-preview="ready"]')`, 10000);
        const onLead = await h.ev(NEW_RUN_PLAN);
        const planRow = (table) => table?.rows?.find((r) => r.id === "t-1");
        rec(
            "5. a plan file shows 3 rows, its Model line `sonnet · plan` struck through on Same as lead",
            sameAsLead.includes("Same as lead") &&
                onLead.rows?.length === 3 &&
                planRow(onLead)?.model === "sonnet · plan" &&
                planRow(onLead).struck === true,
            JSON.stringify({ workers: sameAsLead, plan: MODELS_PLAN, ...onLead })
        );

        const reviewerPicks = await pickWorkers(h, "route-option-extra");
        await polishNap(300);
        const onPicks = await h.ev(NEW_RUN_PLAN);
        const others = onPicks.rows?.filter((r) => r.id !== "t-1") ?? [];
        await h.shot("cdp-shots/new-run-window-2-picks.png");
        rec(
            "6. on Reviewer picks the Model line counts, the rest read `at review`, and the mix line says so",
            reviewerPicks.includes("Reviewer picks") &&
                planRow(onPicks)?.model === "sonnet · plan" &&
                planRow(onPicks).struck === false &&
                others.length === 2 &&
                others.every((r) => r.model === "at review") &&
                onPicks.mix === "1 set by the plan · 2 picked at review",
            JSON.stringify({ workers: reviewerPicks, ...onPicks })
        );

        const runsBefore = await channelRunCount(h, ctx.channelId);
        await h.ev(`[...(${NEW_RUN}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Cancel')?.click()`);
        const closed = await polishWaitFor(h, `!${NEW_RUN}`, 3000);
        const runsAfter = await channelRunCount(h, ctx.channelId);
        rec(
            "7. Cancel closes the window and starts no run",
            closed && runsAfter === runsBefore,
            JSON.stringify({ closed, runsBefore, runsAfter })
        );

        const created = await newRunWithLightReviewers(h, ctx);
        rec(
            "8. Light reviewers row picks a route the created run carries",
            created.row?.label === "Light reviewers" &&
                created.picked != null &&
                created.row.face.includes(created.picked) &&
                created.run?.lightreviewerroute?.runtime === "claude" &&
                created.run.lightreviewerroute.model === created.picked,
            JSON.stringify({ ...created, run: created.run && { id: created.run.id, lightreviewerroute: created.run.lightreviewerroute } })
        );
        if (created.run == null) return steps;

        const edited = await editSheetLightReviewers(h, ctx);
        rec(
            "9. the run sheet shows and edits the Light reviewers row",
            edited.dag === "" &&
                edited.summary.includes("light reviewers on claude") &&
                edited.row === true &&
                edited.picked != null &&
                edited.saved === true &&
                edited.after?.runtime === "claude" &&
                edited.after.model === edited.picked &&
                edited.after.model !== created.picked,
            JSON.stringify(edited)
        );

        const launcher = await launcherLightReviewers(h, ctx);
        rec(
            "10. the brief sheet's launcher shows the Light reviewers row beside Reviewers",
            launcher.sheet === true && launcher.row === true && launcher.besideReviewers === true && launcher.face !== "",
            JSON.stringify(launcher)
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`new-run-window teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        if (ctx.createdRunId) {
            await step("cancel the window's run", () => h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.createdRunId }));
        }
        if (ctx.launcherChannelId) {
            await step("delete the launcher channel", () => h.rpc("deletechannel", { channelid: ctx.launcherChannelId }));
        }
        if (ctx.launcherCwd) {
            await step("remove the launcher dir", () => rmSync(ctx.launcherCwd, { recursive: true, force: true }));
        }
        if (ctx.createdLandPath) {
            await step("remove the window run's tree", () =>
                rmSync(ctx.createdLandPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
            );
        }
        if (ctx.prevRecent !== undefined) {
            const key = JSON.stringify(RECENT_PROJECTS_KEY);
            await h.ev(
                ctx.prevRecent === null
                    ? `localStorage.removeItem(${key})`
                    : `localStorage.setItem(${key}, ${JSON.stringify(ctx.prevRecent)})`
            );
        }
        await teardownFixtureRun(h, ctx, "new-run-window", {
            what: "delete the project",
            fn: () => (ctx.project ? h.rpc("deleteproject", { name: ctx.project }) : null),
        });
    },
};

// --- new-run-attachments: a pasted image and a picked file reach the run as paths in its goal
// The native file dialog cannot be driven over CDP, so a picked path goes through window.__newRunAttachPaths, the
// handler the paperclip's dialog calls. The run is a real quick run, so one lead starts; teardown cancels it.
const NEW_RUN_ATTACH_PROJECT = "verify-new-run-attachments";
const NEW_RUN_ATTACH_GOAL = "verify new-run-attachments: do nothing, make no file changes, stop immediately";
const NEW_RUN_CHIPS = `[...(${NEW_RUN}?.querySelectorAll('[data-attachment-chip]') ?? [])]`;
const NEW_RUN_START = `[...(${NEW_RUN}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Start run')`;
const ONE_PX_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const OVER_CAP_BYTES = 10 * 1024 * 1024 + 1;

// dispatches a paste carrying either text or one file on the goal box; returns whether the page took it over
const pasteOnGoal = (what) => `(() => {
    const ta = ${NEW_RUN_GOAL};
    if (!ta) return null;
    ta.focus();
    const dt = new DataTransfer();
    const what = ${JSON.stringify(what)};
    if (what.text != null) {
        dt.setData('text/plain', what.text);
    } else {
        const bytes = what.png ? Uint8Array.from(atob(what.png), (c) => c.charCodeAt(0)) : new Uint8Array(what.size);
        dt.items.add(new File([bytes], what.name, { type: 'image/png' }));
    }
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    return ev.defaultPrevented;
})()`;
const chipsExpr = `${NEW_RUN_CHIPS}.map((c) => ({
    state: c.getAttribute('data-attachment-chip'),
    path: c.getAttribute('data-attachment-path'),
    name: c.querySelector('.font-mono')?.textContent ?? null,
    thumb: !!c.querySelector('img'),
}))`;
const newRunFooter = `({
    start: ${NEW_RUN_START}?.disabled ?? null,
    footer: ${flatText(`${NEW_RUN}?.querySelector('[data-new-run-footer]')`)},
})`;

export const newRunAttachments = {
    name: "new-run-attachments",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-new-run-attachments-"));
        const ctx = { cwd, picked: join(cwd, "notes.txt") };
        try {
            writeFileSync(ctx.picked, "picked through the dialog's handler\n");
            await h.rpc("createproject", { name: NEW_RUN_ATTACH_PROJECT, path: cwd });
            ctx.project = NEW_RUN_ATTACH_PROJECT;
            await waitForProjectInConfig(h, NEW_RUN_ATTACH_PROJECT);
            const ch = await h.rpc("createchannel", { name: "verify-new-run-attachments", projectpath: cwd });
            ctx.channelId = ch.oid;
            // the window opens on the most recent project, so it is seeded first and put back in teardown
            ctx.prevRecent = await h.ev(`localStorage.getItem(${JSON.stringify(RECENT_PROJECTS_KEY)})`);
            const recent = [NEW_RUN_ATTACH_PROJECT, ...JSON.parse(ctx.prevRecent ?? "[]")];
            await h.ev(`localStorage.setItem(${JSON.stringify(RECENT_PROJECTS_KEY)}, ${JSON.stringify(JSON.stringify(recent))})`);
            await polishReload(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. the project, its channel, a picked file and the recent entry were made", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await h.ev(`document.querySelector('[data-new-run]')?.click()`);
        const opened = await polishWaitFor(h, `!!${NEW_RUN_GOAL}`, 5000);
        // quick, so the run is one lead and the goal is its whole input
        await h.ev(
            `[...(${NEW_RUN}?.querySelectorAll('button[aria-pressed]') ?? [])].find((b) => b.firstElementChild?.textContent === 'quick')?.click()`
        );
        await polishNap(300);
        const field = await h.ev(flatText(NEW_RUN_FIELD));
        rec(
            "1. New run opens on the project, with the paperclip beside the goal",
            opened &&
                field.startsWith(NEW_RUN_ATTACH_PROJECT) &&
                (await h.ev(`!!${NEW_RUN}?.querySelector('[data-goal-attachments] [data-attach-files]')`)),
            JSON.stringify({ opened, field })
        );
        if (!opened) return steps;

        await h.ev(`(() => {
            const ta = ${NEW_RUN_GOAL};
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(NEW_RUN_ATTACH_GOAL)});
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        const textTaken = await h.ev(pasteOnGoal({ text: "plain words" }));
        const imageTaken = await h.ev(pasteOnGoal({ png: ONE_PX_PNG, name: "pasted.png" }));
        const ready = await polishWaitFor(h, `${NEW_RUN_CHIPS}.some((c) => c.getAttribute('data-attachment-chip') === 'ready')`, 8000);
        const pasted = (await h.ev(chipsExpr))[0] ?? null;
        ctx.pastedPath = pasted?.path ?? null;
        rec(
            "2. a text paste is left to the goal box; an image paste becomes a ready chip with a thumbnail and a temp copy",
            textTaken === false &&
                imageTaken === true &&
                ready &&
                pasted?.thumb === true &&
                pasted?.name === "pasted.png" &&
                (pasted?.path ?? "").includes("waveterm-attach-") &&
                pasted.path.endsWith("pasted.png"),
            JSON.stringify({ textTaken, imageTaken, ready, pasted })
        );

        // over the cap: rejected before any RPC, and the launch waits on it rather than dropping it
        await h.ev(pasteOnGoal({ size: OVER_CAP_BYTES, name: "too-big.png" }));
        await polishWaitFor(h, `${NEW_RUN_CHIPS}.some((c) => c.getAttribute('data-attachment-chip') === 'error')`, 3000);
        const failed = await h.ev(`({ chips: ${chipsExpr}, ...${newRunFooter} })`);
        await h.shot("cdp-shots/new-run-attachments-error.png");
        rec(
            "3. a failed attachment shows as an error chip and holds Start run, saying why",
            failed.chips.some((c) => c.state === "error" && c.name === "too-big.png") &&
                failed.start === true &&
                failed.footer.includes("Retry or remove the failed attachment"),
            JSON.stringify(failed)
        );
        await h.ev(
            `${NEW_RUN_CHIPS}.find((c) => c.getAttribute('data-attachment-chip') === 'error')?.querySelector('button[title="Remove"]')?.click()`
        );

        await h.ev(`window.__newRunAttachPaths?.(${JSON.stringify([ctx.picked])})`);
        await h.ev(`window.__newRunAttachPaths?.(${JSON.stringify([ctx.picked])})`);
        await polishNap(300);
        const both = await h.ev(`({ chips: ${chipsExpr}, ...${newRunFooter} })`);
        await h.shot("cdp-shots/new-run-attachments-chips.png");
        rec(
            "4. a picked path is a ready chip referenced in place, once; removing the failed chip frees Start run",
            both.chips.length === 2 &&
                both.chips[1].state === "ready" &&
                both.chips[1].path === ctx.picked &&
                both.chips[1].name === "notes.txt" &&
                both.start === false,
            JSON.stringify(both)
        );

        // a route picked by hand is the launch's route as it stands; the project's own is resolved against the
        // boot-time harness catalog, which an isolated Final store may not have loaded yet (one run failed with
        // "Selected route is unavailable"). So the lead's shown route is picked again by hand: the selected row,
        // else the first the picker lists
        await h.ev(`${NEW_RUN}?.querySelector('[data-testid="route-picker"][aria-label="Lead model"]')?.click()`);
        const routes = `[...document.querySelectorAll('[data-testid^="route-option-"]')].filter((o) => !/-(inherit|extra)$/.test(o.dataset.testid))`;
        const pickedRoute = (await polishWaitFor(h, `${routes}.length > 0`, 8000))
            ? await h.ev(`(() => {
                const opts = ${routes};
                const opt = opts.find((o) => o.getAttribute('aria-pressed') === 'true') ?? opts[0];
                opt.click();
                return opt.dataset.testid;
            })()`)
            : null;
        await polishNap(300);
        const runsBefore = (await channelRuns(h, ctx.channelId)).map((r) => r.id);
        await h.ev(`${NEW_RUN_START}?.click()`);
        let run = null;
        for (let waited = 0; waited < 20000 && run == null; waited += 500) {
            run = (await channelRuns(h, ctx.channelId)).find((r) => !runsBefore.includes(r.id)) ?? null;
            if (run == null) await polishNap(500);
        }
        ctx.runId = run?.id;
        // a launch that failed before the run existed keeps the window open with its error in the footer
        const after = await h.ev(`({ open: !!${NEW_RUN}, ...${newRunFooter} })`);
        if (run == null) await h.shot("cdp-shots/new-run-attachments-start.png");
        const expected = `${NEW_RUN_ATTACH_GOAL}\n\nAttachments (read these files):\n- ${ctx.pastedPath}\n- ${ctx.picked}`;
        rec(
            "5. Start run sends the typed goal with both paths appended",
            run != null && run.goal === expected,
            JSON.stringify({ goal: run?.goal ?? null, expected, pickedRoute, window: run == null ? after : undefined })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        if (ctx.prevRecent !== undefined) {
            const key = JSON.stringify(RECENT_PROJECTS_KEY);
            await h.ev(
                ctx.prevRecent === null
                    ? `localStorage.removeItem(${key})`
                    : `localStorage.setItem(${key}, ${JSON.stringify(ctx.prevRecent)})`
            );
        }
        // the temp copy sits in its own waveterm-attach-* dir, which the 24h sweep would otherwise reap
        if (ctx.pastedPath) rmSync(dirname(ctx.pastedPath), { recursive: true, force: true });
        await teardownFixtureRun(h, ctx, "new-run-attachments", {
            what: "delete the project",
            fn: () => (ctx.project ? h.rpc("deleteproject", { name: ctx.project }) : null),
        });
    },
};
// a key sent to the note editor's title or body; true when the editor took it (prevented its default)
// --- palette-actions, palette-goal: Ctrl+P acting on things (docs/superpowers/specs/2026-09-30-palette-actions-design.md)
// Every query is scoped to the palette's own dialog: the app bar's search button and the Brief also render rows.
const noteKeyIn = (field, key, mods = {}) => `(() => {
    const el = ${PALETTE}?.querySelector(${JSON.stringify(field === "body" ? "[data-note-body]" : "input[data-palette-input]")});
    if (!el) return null;
    return !el.dispatchEvent(new KeyboardEvent('keydown', { ...${JSON.stringify(mods)}, key: ${JSON.stringify(key)}, code: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
})()`;

// A run held in planning by deferstart is only a record: no worker spawns, so no lead joins the roster and of
// Steer's actions only Go autonomous applies, the run sheet being editable. The rest (message, focus, workers,
// relaunch, resume) are named on the Not now line instead.
export const paletteActions = {
    name: "palette-actions",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-palette-actions-"));
        const stamp = `palacts${Date.now() % 100000}`;
        const ctx = { cwd, stamp };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-palette-actions", projectpath: cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: `verify ${stamp}: do nothing, make no file changes, stop immediately`,
                runtime: "claude",
                mode: "orchestrator",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            // the palette lists runs from the boot-primed channel list
            await polishReload(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. a channel with one planning run was made", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await h.goto("jarvis");
        const opened = await openPalette(h);
        rec("1. Ctrl+P opens the palette", opened, `open=${opened}`);
        if (!opened) return steps;

        await h.ev(setInputExpr(PALETTE_INPUT, "r:"));
        const scoped = await paletteStateWhen(h, (s) => s.token === "Runs", 2000);
        const runsTab = await h.ev(`${PALETTE}?.querySelector('[data-palette-scope="runs"]')?.getAttribute('aria-pressed')`);
        rec(
            "2. typing r: narrows to Runs: the token names it, the field empties",
            scoped?.token === "Runs" && scoped.query === "" && runsTab === "true",
            JSON.stringify({ token: scoped?.token, query: scoped?.query, runsTab })
        );

        // the row's action count shows only once the kinds' sources load, so wait for it rather than sleep
        await h.ev(setInputExpr(PALETTE_INPUT, ctx.stamp));
        const listed = await paletteStateWhen(h, (s) => (s.selected ?? "").includes(ctx.stamp) && s.chip, 8000);
        rec(
            "3. the run's row is selected and says → N actions",
            (listed?.selected ?? "").includes(ctx.stamp) && listed.chip === true,
            JSON.stringify({ selected: listed?.selected, groups: listed?.groups })
        );

        await h.ev(paletteKey("ArrowRight"));
        const acts = await paletteStateWhen(h, (s) => s.drill != null && s.groups.length > 0, 3000);
        await h.shot("cdp-shots/palette-actions-list.png");
        const labels = acts?.groups.map((g) => g.label) ?? [];
        const rows = acts?.groups.flatMap((g) => g.rows) ?? [];
        rec(
            "4. → opens the run's actions: Open, Steer, Stop, Go autonomous and Cancel run among them, the rest of Steer's under Not now",
            acts != null &&
                acts.token == null &&
                acts.drill.startsWith("Run") &&
                acts.drill.includes(ctx.stamp) &&
                acts.placeholder === "Filter Run actions…" &&
                labels.join(",") === "Open,Steer,Stop" &&
                rows.some((r) => r.startsWith("Open in Jarvis")) &&
                rows.some((r) => r.startsWith("Go autonomous")) &&
                rows.some((r) => r.startsWith("Cancel run")) &&
                /Not now: .*Message the lead/.test(acts.text),
            JSON.stringify({ drill: acts?.drill, placeholder: acts?.placeholder, groups: acts?.groups })
        );

        await h.ev(paletteKey("Backspace"));
        const back = await paletteStateWhen(h, (s) => s.drill == null, 2000);
        rec(
            "5. Backspace on the empty filter returns to the run list, the query and the run's selection kept",
            back != null &&
                back.drill == null &&
                back.token === "Runs" &&
                back.query === ctx.stamp &&
                (back.selected ?? "").includes(ctx.stamp),
            JSON.stringify({ token: back?.token, query: back?.query, selected: back?.selected })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await teardownFixtureRun(h, ctx, "palette-actions");
    },
};

// --- palette-scope-indicator: the active scope's bar slides between tabs
// (docs/superpowers/specs/2026-10-28-palette-scope-indicator-design.md)
// One in-page promise samples every animation frame: a CDP round trip per sample is too slow to see a front-loaded
// 360 ms ease. The bar is compared to its target button in the same frame, so the modal's open scale cannot skew it.
const PALETTE_SCOPE_BTN = (scope) => `${PALETTE}?.querySelector('[data-palette-scope=${JSON.stringify(scope)}]')`;
const PALETTE_PRESSED_SCOPE = `(${PALETTE}?.querySelector('[data-palette-scope][aria-pressed="true"]')?.getAttribute('data-palette-scope') ?? null)`;

// each frame: { t, pressed, bar, target, source }, rects as { left, width }; source is the scope pressed before actionExpr
async function sampleIndicator(h, actionExpr, targetScope, ms = 600) {
    return h.ev(`new Promise((resolve) => {
        const rect = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, width: r.width };
        };
        const sourceScope = ${PALETTE_PRESSED_SCOPE};
        const frames = [];
        const t0 = performance.now();
        ${actionExpr};
        const tick = () => {
            frames.push({
                t: Math.round(performance.now() - t0),
                pressed: ${PALETTE_PRESSED_SCOPE},
                bar: rect(${PALETTE}?.querySelector('[data-palette-scope-indicator]')),
                target: rect(${PALETTE_SCOPE_BTN(targetScope)}),
                source: sourceScope == null ? null : rect(${PALETTE}?.querySelector('[data-palette-scope="' + sourceScope + '"]')),
            });
            if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
            else resolve(frames);
        };
        requestAnimationFrame(tick);
    })`);
}

const barMatches = (f) =>
    f?.bar != null && f.target != null && Math.abs(f.bar.left - f.target.left) <= 1 && Math.abs(f.bar.width - f.target.width) <= 1;
const barMidFlight = (f) => {
    if (f?.bar == null || f.source == null || f.target == null) return false;
    const lo = Math.min(f.source.left, f.target.left);
    const hi = Math.max(f.source.left, f.target.left);
    return f.bar.left > lo + 2 && f.bar.left < hi - 2;
};
const barDistance = (f) => Math.abs(f.bar.left - f.target.left) + Math.abs(f.bar.width - f.target.width);
const roundRect = (r) => (r == null ? null : { left: Math.round(r.left * 10) / 10, width: Math.round(r.width * 10) / 10 });
// the numbers a step's detail carries: frame count, how many were mid-flight, and the first and last frames
const sampleSummary = (frames) => ({
    n: frames.length,
    mid: frames.filter(barMidFlight).length,
    first: frames[0] && { t: frames[0].t, pressed: frames[0].pressed, bar: roundRect(frames[0].bar), target: roundRect(frames[0].target) },
    last: frames.at(-1) && {
        t: frames.at(-1).t,
        pressed: frames.at(-1).pressed,
        bar: roundRect(frames.at(-1).bar),
        target: roundRect(frames.at(-1).target),
        source: roundRect(frames.at(-1).source),
    },
});
const slidOk = (frames) => frames.some(barMidFlight) && barMatches(frames.at(-1));

async function settleIndicator(h, scope) {
    const settled = await polishWaitFor(
        h,
        `(() => {
            const bar = ${PALETTE}?.querySelector('[data-palette-scope-indicator]')?.getBoundingClientRect();
            const btn = ${PALETTE_SCOPE_BTN(scope)}?.getBoundingClientRect();
            return !!bar && !!btn && Math.abs(bar.left - btn.left) <= 1 && Math.abs(bar.width - btn.width) <= 1;
        })()`,
        3000
    );
    // the last pixel of the ease can still be moving when the poll first matches
    await polishNap(400);
    return settled;
}

export const paletteScopeIndicator = {
    name: "palette-scope-indicator",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
            await h.goto("jarvis");
            const opened = await openPalette(h);
            const startScope = opened ? await h.ev(PALETTE_PRESSED_SCOPE) : null;
            if (!opened || startScope !== "all") {
                rec("1. Ctrl+P opens the palette on All", false, JSON.stringify({ opened, startScope }));
                return steps;
            }

            const toNeeds = await sampleIndicator(h, paletteKey("Tab"), "needs");
            await settleIndicator(h, "needs");
            const one = await h.ev(`(() => {
                const bars = [...(${PALETTE}?.querySelectorAll('[data-palette-scope-indicator]') ?? [])];
                return { count: bars.length, inPressed: bars[0]?.closest('[data-palette-scope]')?.getAttribute('aria-pressed') ?? null };
            })()`);
            await h.shot("cdp-shots/palette-scope-indicator-rest.png");
            rec(
                "1. Tab from All slides the bar to Needs you; one bar, inside the pressed tab",
                slidOk(toNeeds) && one.count === 1 && one.inPressed === "true",
                JSON.stringify({ sample: sampleSummary(toNeeds), one })
            );

            const back = await sampleIndicator(h, paletteKey("Tab", { shiftKey: true }), "all");
            const wrap = await sampleIndicator(h, paletteKey("Tab", { shiftKey: true }), "commands");
            const bksp = await sampleIndicator(h, paletteKey("Backspace"), "all");
            await h.ev(paletteKey("Tab", { shiftKey: true }));
            const capture = await h.ev(`({
                bar: ${PALETTE}?.querySelector('[data-palette-scope-indicator]')?.getBoundingClientRect().left ?? null,
                all: ${PALETTE_SCOPE_BTN("all")}?.getBoundingClientRect().left ?? null,
                commands: ${PALETTE_SCOPE_BTN("commands")}?.getBoundingClientRect().left ?? null,
            })`);
            await h.shot("cdp-shots/palette-scope-indicator-midslide.png");
            await settleIndicator(h, "commands");
            await h.ev(paletteKey("Backspace"));
            await settleIndicator(h, "all");
            rec(
                "2. Shift+Tab back to All lands; Shift+Tab wraps to Commands and Backspace drops to All, both sliding",
                barMatches(back.at(-1)) && slidOk(wrap) && slidOk(bksp),
                JSON.stringify({
                    back: sampleSummary(back),
                    wrap: sampleSummary(wrap),
                    backspace: sampleSummary(bksp),
                    midSlideShot: capture,
                })
            );

            await h.ev(`${PALETTE_SCOPE_BTN("goto")}?.click()`);
            await settleIndicator(h, "goto");
            const clicked = await sampleIndicator(h, `${PALETTE_SCOPE_BTN("files")}?.click()`, "files");
            const last = clicked.at(-1);
            await h.ev(paletteKey("Backspace"));
            await settleIndicator(h, "all");
            const typed = await sampleIndicator(h, setInputExpr(PALETTE_INPUT, "f:"), "files");
            const token = (await h.ev(PALETTE_STATE))?.token ?? null;
            await h.ev(paletteKey("Backspace"));
            await settleIndicator(h, "all");
            rec(
                "3. clicking Files from Go to lands at Files' width; typing f: from All slides to Files",
                barMatches(last) &&
                    last.source != null &&
                    Math.abs(last.target.width - last.source.width) > 1 &&
                    token === "Files" &&
                    slidOk(typed),
                JSON.stringify({ click: sampleSummary(clicked), typed: sampleSummary(typed), token })
            );

            // one press per frame, each read by the render the previous one committed
            const held = await sampleIndicator(
                h,
                `(() => {
                    let n = 0;
                    const press = () => {
                        ${paletteKey("Tab")};
                        if (++n < 4) requestAnimationFrame(press);
                    };
                    press();
                })()`,
                "runs",
                900
            );
            const afterLast = held.filter((f) => f.pressed === "runs" && f.bar != null && f.target != null);
            const pressT = afterLast[0]?.t ?? null;
            const landedIdx = afterLast.findIndex((_, i) => afterLast.slice(i).every(barMatches));
            const landedT = landedIdx < 0 ? null : afterLast[landedIdx].t;
            const awayFrames = afterLast.filter((f, i) => i > 0 && barDistance(f) > barDistance(afterLast[i - 1]) + 1).map((f) => f.t);
            rec(
                "4. four Tabs a frame apart: the bar lands on Runs within 600 ms of the last press, never moving away",
                pressT != null && landedT != null && landedT - pressT <= 600 && awayFrames.length === 0,
                JSON.stringify({ sample: sampleSummary(held), pressT, landedT, awayFrames })
            );

            const reopened = await openPalette(h);
            await h.ev(setInputExpr(PALETTE_INPUT, "r:"));
            const onRuns = (await paletteStateWhen(h, (s) => s.token === "Runs", 2000))?.token === "Runs";
            await h.ev(PEEKS_ESC);
            const closed = await polishWaitFor(h, `!${PALETTE_INPUT}`, 2000);
            await h.goto("code");
            const reopen = await sampleIndicator(h, PALETTE_TOGGLE, "files", 800);
            const both = reopen.filter((f) => f.bar != null && f.target != null);
            const offFrames = both.filter((f) => !barMatches(f)).map((f) => ({ t: f.t, pressed: f.pressed, bar: roundRect(f.bar) }));
            await settleIndicator(h, "files");
            await h.shot("cdp-shots/palette-scope-indicator-reopen.png");
            rec(
                "5. closed on Runs, reopened on Code: the bar is under Files from its first frame, never sliding from Runs",
                reopened && onRuns && closed && both.length > 0 && offFrames.length === 0,
                JSON.stringify({ reopened, onRuns, closed, frames: both.length, first: sampleSummary(reopen).first, offFrames: offFrames.slice(0, 5) })
            );

            await h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
            // motion reads reduced motion only from the media query's change event, which fires on the next frame
            const reducedSeen = await h.ev(`new Promise((resolve) => {
                const mq = matchMedia("(prefers-reduced-motion)");
                const t0 = performance.now();
                const poll = () => {
                    if (mq.matches) requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
                    else if (performance.now() - t0 > 2000) resolve(false);
                    else requestAnimationFrame(poll);
                };
                poll();
            })`);
            const reduced = await sampleIndicator(h, paletteKey("Tab"), "commands");
            const onCommands = reduced.filter((f) => f.pressed === "commands").slice(0, 2);
            // the sampler's rAF can run before motion applies the projection in that frame, reading a DOM that never paints
            rec(
                "6. reduced motion: Tab from Files snaps the bar to Commands by its second frame, no frame in flight",
                onCommands.some(barMatches) && !reduced.some(barMidFlight),
                JSON.stringify({
                    reducedSeen,
                    sample: sampleSummary(reduced),
                    onCommands: onCommands.map((f) => ({ t: f.t, bar: roundRect(f.bar), target: roundRect(f.target) })),
                })
            );
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h) {
        // reset whatever failed: an emulation left on would turn off motion for every later scenario
        await h.cdp("Emulation.setEmulatedMedia", { features: [] }).catch((e) => {
            console.error(`palette-scope-indicator teardown: clear the media emulation failed: ${e?.message ?? e}`);
        });
        if (await h.ev(`!!${PALETTE_INPUT}`).catch(() => false)) {
            await h.ev(PEEKS_ESC).catch(() => {});
        }
    },
};

const PALETTE_GOAL_PROJECT = "verify-palette-goal";

// Orchestrate opens the New run window rather than starting a run, so firing it here spawns nothing; the
// Ctrl+Enter handler itself is covered by palette-launch.test.ts.
export const paletteGoal = {
    name: "palette-goal",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-palette-goal-"));
        const ctx = { cwd };
        try {
            await h.rpc("createproject", { name: PALETTE_GOAL_PROJECT, path: cwd });
            ctx.project = PALETTE_GOAL_PROJECT;
            await waitForProjectInConfig(h, PALETTE_GOAL_PROJECT);
            const ch = await h.rpc("createchannel", { name: "verify-palette-goal", projectpath: cwd });
            ctx.channelId = ch.oid;
            await polishReload(h);
            // the launch block starts in the active project, so the channel is made active the way an agent's
            // reveal does, and the sheet that opens with it is closed again
            await h.rpc("uireveal", { address: `channel:${ctx.channelId}` }, UI_ROUTE);
            await polishNap(600);
            await h.ev(PEEKS_ESC);
            await polishNap(300);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. an active project with no runs was made", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await h.goto("jarvis");
        const runsBefore = await channelRunCount(h, ctx.channelId);
        const opened = await openPalette(h);
        rec("1. Ctrl+P opens the palette", opened, `open=${opened}`);
        if (!opened) return steps;

        // a goal that names nothing: a made-up first word, so no verb row and no name match either
        const goal = `zqvx${Date.now() % 100000} tidy the palette fixture`;
        await h.ev(setInputExpr(PALETTE_INPUT, goal));
        const launch = await paletteStateWhen(h, (s) => s.groups[0]?.label.startsWith("Start in"), 3000);
        await h.shot("cdp-shots/palette-goal-launch.png");
        const block = launch?.groups[0];
        rec(
            "2. the launch block leads, in the active project, with Quick selected",
            block != null &&
                block.label === `Start in #${PALETTE_GOAL_PROJECT}` &&
                (block.rows[0] ?? "").startsWith("Quick") &&
                (launch.selected ?? "").startsWith("Quick") &&
                block.rows.some((r) => r.startsWith("Orchestrate")),
            JSON.stringify({ groups: launch?.groups, selected: launch?.selected })
        );
        rec(
            "3. the footer names Ctrl+Enter's Orchestrate",
            launch != null && launch.text.includes("ctrl ⏎") && launch.text.includes("Opens an orchestrator run instead"),
            launch?.text.slice(-240) ?? ""
        );

        // Quick → Orchestrate
        await h.ev(paletteKey("ArrowDown"));
        const onOrch = await paletteStateWhen(h, (s) => (s.selected ?? "").startsWith("Orchestrate"), 2000);
        await h.ev(paletteKey("Enter"));
        const windowOpen = await polishWaitFor(h, `!!${NEW_RUN}`, 5000);
        // the window fills the goal once its project list loads
        await polishWaitFor(
            h,
            `${NEW_RUN}?.querySelector('textarea[aria-label="Goal"]')?.value === ${JSON.stringify(goal)}`,
            3000
        );
        // the palette closes before the window opens, but its exit animation keeps the input mounted briefly
        const paletteGone = await polishWaitFor(h, `!${PALETTE_INPUT}`, 2000);
        const filled = await h.ev(`({
            palette: !!${PALETTE_INPUT},
            goal: ${NEW_RUN}?.querySelector('textarea[aria-label="Goal"]')?.value ?? null,
            project: ${flatText(NEW_RUN_FIELD)},
            text: ${flatText(NEW_RUN)},
        })`);
        const runsAfter = await channelRunCount(h, ctx.channelId);
        await h.shot("cdp-shots/palette-goal-window.png");
        rec(
            "4. Orchestrate opens the New run window with the goal, the project and the orchestrator shape filled, and starts nothing",
            (onOrch?.selected ?? "").startsWith("Orchestrate") &&
                windowOpen &&
                paletteGone &&
                filled.palette === false &&
                filled.goal === goal &&
                filled.project.startsWith(PALETTE_GOAL_PROJECT) &&
                filled.text.includes(`orchestrator × `) &&
                runsAfter === runsBefore,
            JSON.stringify({ selected: onOrch?.selected, windowOpen, paletteGone, ...filled, runsBefore, runsAfter })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await teardownFixtureRun(h, ctx, "palette-goal", {
            what: "delete the project",
            fn: () => (ctx.project ? h.rpc("deleteproject", { name: ctx.project }) : null),
        });
    },
};

// --- new-run-defaults: + Run opens on the project's saved profile and the harness preference, from the app bar and
// from a prefill (the palette's Orchestrate, the path a brainstorm's Approve and a canvas's Build this… take), and its
// Lead picker lists the model catalog. The profile is an override on the fixture's own channel rather than the global
// one, so the developer's vault is left alone; the launcher hydrates from the resolved profile either way.
const NEW_RUN_DEFAULTS_PROJECT = "verify-new-run-defaults";
// quick, so a prefill's orchestrator is visibly its own shape while everything else comes from here
const NEW_RUN_DEFAULTS_PROFILE = { defaultmode: "quick", parallelism: 5, reviewerpicks: true, autonomous: true };
const NEW_RUN_FACE = `(() => {
    const d = ${NEW_RUN};
    if (!d) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const pressed = [...d.querySelectorAll('button[aria-pressed="true"]')].map(flat);
    const picker = (label) => flat(d.querySelector('[data-testid="route-picker"][aria-label="' + label + '"]')) || null;
    return {
        project: flat(${NEW_RUN_FIELD}),
        shape: pressed.some((t) => t.startsWith('orchestrator')) ? 'orchestrator' : pressed.some((t) => t.startsWith('quick')) ? 'quick' : null,
        workers: d.querySelector('[aria-label="Fewer concurrent workers"]')?.nextElementSibling?.textContent.trim() ?? null,
        approvals: pressed.find((t) => t === 'Autonomous' || t === 'Ask me') ?? null,
        lead: picker('Lead model'),
        workersModel: picker('Workers model'),
        goal: d.querySelector('textarea[aria-label="Goal"]')?.value ?? null,
    };
})()`;
const NEW_RUN_CANCEL = `[...(${NEW_RUN}?.querySelectorAll('[data-new-run-footer] button') ?? [])].find((b) => b.textContent.trim() === 'Cancel')?.click()`;
// the Lead picker's open list: its model rows, and the empty-list line it shows instead of them
const LEAD_PICKER_LIST = `(() => {
    const panel = document.querySelector('[role="group"][aria-label="Available routes"]');
    if (!panel) return null;
    const rows = [...panel.querySelectorAll('[data-testid^="route-option-"]')]
        .map((b) => b.getAttribute('data-testid'))
        .filter((id) => id !== 'route-option-inherit' && id !== 'route-option-extra');
    const empty = [...panel.querySelectorAll('div')].map((d) => d.textContent.trim()).find((t) => t === 'Loading models…' || t === 'No run routes available.') ?? null;
    return { rows, empty };
})()`;

async function openNewRunFace(h) {
    await h.ev(`document.querySelector('[data-new-run]')?.click()`);
    if (!(await polishWaitFor(h, `!!${NEW_RUN}`, 5000))) return null;
    // the project's profile is read after the window draws
    await polishNap(1500);
    return h.ev(NEW_RUN_FACE);
}

async function closeNewRun(h) {
    await h.ev(NEW_RUN_CANCEL);
    await polishWaitFor(h, `!${NEW_RUN}`, 3000);
}

export const newRunDefaults = {
    name: "new-run-defaults",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-new-run-defaults-"));
        const ctx = { cwd };
        try {
            await h.rpc("createproject", { name: NEW_RUN_DEFAULTS_PROJECT, path: cwd });
            ctx.project = NEW_RUN_DEFAULTS_PROJECT;
            await waitForProjectInConfig(h, NEW_RUN_DEFAULTS_PROJECT);
            const ch = await h.rpc("createchannel", { name: NEW_RUN_DEFAULTS_PROJECT, projectpath: cwd });
            ctx.channelId = ch.oid;
            await h.rpc("setchannelprofile", { channelid: ctx.channelId, override: NEW_RUN_DEFAULTS_PROFILE });
            const settings = (await h.rpc("getfullconfig", null))?.settings ?? {};
            ctx.preferredModel = settings["harness:preferredmodel"] || "default";
            // + Run opens on the most recent project
            ctx.prevRecent = await h.ev(`localStorage.getItem(${JSON.stringify(RECENT_PROJECTS_KEY)})`);
            const recent = [NEW_RUN_DEFAULTS_PROJECT, ...JSON.parse(ctx.prevRecent ?? "[]")];
            await h.ev(`localStorage.setItem(${JSON.stringify(RECENT_PROJECTS_KEY)}, ${JSON.stringify(JSON.stringify(recent))})`);
            await polishReload(h);
            // the palette's launch block starts in the active project
            await h.rpc("uireveal", { address: `channel:${ctx.channelId}` }, UI_ROUTE);
            await polishNap(600);
            await h.ev(PEEKS_ESC);
            await polishNap(300);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. a project whose channel saves a profile was made", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        const preferred = ` · ${ctx.preferredModel}`;

        const plain = await openNewRunFace(h);
        await h.shot("cdp-shots/new-run-defaults-1-plain.png");
        rec(
            "1. + Run opens on the project's profile (quick) with the harness preference as the lead",
            plain != null &&
                plain.project.startsWith(NEW_RUN_DEFAULTS_PROJECT) &&
                plain.shape === "quick" &&
                (plain.lead ?? "").endsWith(preferred),
            JSON.stringify({ ...plain, preferred: ctx.preferredModel })
        );
        if (plain == null) return steps;

        // hand edits: the shape, the width and the lead, then the window is closed without launching
        await h.ev(
            `[...(${NEW_RUN}?.querySelectorAll('button[aria-pressed]') ?? [])].find((b) => b.firstElementChild?.textContent.trim() === 'orchestrator')?.click()`
        );
        await polishNap(200);
        await h.ev(`${NEW_RUN}?.querySelector('[aria-label="Fewer concurrent workers"]')?.click()`);
        await h.ev(`${NEW_RUN}?.querySelector('[data-testid="route-picker"][aria-label="Lead model"]')?.click()`);
        await polishWaitFor(h, `(${LEAD_PICKER_LIST})?.rows.length > 0`, 20000);
        const other = await h.ev(
            `(${LEAD_PICKER_LIST})?.rows.find((id) => !id.endsWith(${JSON.stringify("-" + ctx.preferredModel)})) ?? null`
        );
        if (other != null) await h.ev(`document.querySelector('[data-testid=${JSON.stringify(other)}]')?.click()`);
        await polishNap(300);
        const edited = await h.ev(NEW_RUN_FACE);
        await closeNewRun(h);
        const reopened = await openNewRunFace(h);
        rec(
            "2. the next + Run drops the closed window's hand edits and is back on the profile and the preference",
            edited?.shape === "orchestrator" &&
                !(edited.lead ?? "").endsWith(preferred) &&
                reopened != null &&
                reopened.shape === "quick" &&
                (reopened.lead ?? "").endsWith(preferred),
            JSON.stringify({ edited, reopened })
        );
        await closeNewRun(h);

        // the prefill path: the palette's Orchestrate fills the window the way a brainstorm's Approve does
        const goal = `zqvx${Date.now() % 100000} verify the launcher defaults`;
        const paletteOpen = await openPalette(h);
        await h.ev(setInputExpr(PALETTE_INPUT, goal));
        await paletteStateWhen(h, (s) => s.groups[0]?.label === `Start in #${NEW_RUN_DEFAULTS_PROJECT}`, 3000);
        await h.ev(paletteKey("ArrowDown"));
        const onOrch = await paletteStateWhen(h, (s) => (s.selected ?? "").startsWith("Orchestrate"), 2000);
        await h.ev(paletteKey("Enter"));
        await polishWaitFor(
            h,
            `${NEW_RUN}?.querySelector('textarea[aria-label="Goal"]')?.value === ${JSON.stringify(goal)}`,
            5000
        );
        await polishNap(1500);
        const prefilled = await h.ev(NEW_RUN_FACE);
        await h.shot("cdp-shots/new-run-defaults-2-prefill.png");
        rec(
            "3. a prefilled window keeps the orchestrator it was opened for and takes the width, Reviewer picks, Autonomous and the lead from the profile and the preference",
            paletteOpen &&
                (onOrch?.selected ?? "").startsWith("Orchestrate") &&
                prefilled != null &&
                prefilled.goal === goal &&
                prefilled.shape === "orchestrator" &&
                prefilled.workers === "5" &&
                prefilled.workersModel === "Reviewer picks" &&
                prefilled.approvals === "Autonomous" &&
                (prefilled.lead ?? "").endsWith(preferred),
            JSON.stringify({ selected: onOrch?.selected, ...prefilled })
        );

        await h.ev(`${NEW_RUN}?.querySelector('[data-testid="route-picker"][aria-label="Lead model"]')?.click()`);
        await polishWaitFor(h, `(${LEAD_PICKER_LIST})?.rows.length > 0`, 20000);
        const list = await h.ev(LEAD_PICKER_LIST);
        await h.shot("cdp-shots/new-run-defaults-3-lead-picker.png");
        rec(
            "4. the Lead picker lists the model catalog",
            list != null && list.rows.length > 0 && list.empty == null,
            JSON.stringify({ rows: list?.rows.length, first: list?.rows.slice(0, 3), empty: list?.empty })
        );
        await h.ev(PEEKS_ESC);
        await closeNewRun(h);
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await h.ev(NEW_RUN_CANCEL).catch(() => {});
        if (ctx.prevRecent !== undefined) {
            const key = JSON.stringify(RECENT_PROJECTS_KEY);
            await h
                .ev(
                    ctx.prevRecent === null
                        ? `localStorage.removeItem(${key})`
                        : `localStorage.setItem(${key}, ${JSON.stringify(ctx.prevRecent)})`
                )
                .catch(() => {});
        }
        await teardownFixtureRun(h, ctx, "new-run-defaults", {
            what: "delete the project",
            fn: () => (ctx.project ? h.rpc("deleteproject", { name: ctx.project }) : null),
        });
    },
};

// --- new-run-design: the Approved design start and Design first (docs/superpowers/specs/2026-10-27-lead-plans-from-approved-design-design.md)
// The prefill is set through the app's own newRunPrefillAtom, as a brainstorm's Approve and a canvas's Build this… set
// it, with an onStarted so the window stays put after a launch. RpcApi.CreateRunCommand is replaced in the page with a
// recorder that returns a stand-in run, so Start run sends its payload and no lead starts; teardown restores it.
const NEW_RUN_DESIGN_PROJECT = "verify-new-run-design";
const NEW_RUN_DESIGN_GOAL = "Build verify new-run-design.";
const NEW_RUN_DESIGN_EDITED = "Build verify new-run-design, renamed in the window.";
const NEW_RUN_DESIGN_FIRST_GOAL = "verify new-run-design: a UI check records this launch; nothing runs";
const NEW_RUN_DESIGN_STATE = "__newRunDesign";
const NEW_RUN_DESIGN_INSTALL = `
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    const s = (window.${NEW_RUN_DESIGN_STATE} ??= { calls: [], started: [] });
    if (!Object.prototype.hasOwnProperty.call(RpcApi, "CreateRunCommand")) {
        RpcApi.CreateRunCommand = (client, data) => {
            s.calls.push(data);
            return Promise.resolve({ run: { id: "verify-new-run-design-" + s.calls.length } });
        };
    }
    return true;
`;
// the own property shadows the class's method, so deleting it puts the app's back
const NEW_RUN_DESIGN_RESTORE = `
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
    if (Object.prototype.hasOwnProperty.call(RpcApi, "CreateRunCommand")) delete RpcApi.CreateRunCommand;
    delete window.${NEW_RUN_DESIGN_STATE};
    return true;
`;
const newRunDesignPrefill = (prefill) => `
    const [{ globalStore }, { newRunPrefillAtom }] = await Promise.all([
        mod("app/store/jotaiStore.ts"),
        mod("app/view/jarvis/newruncontrol.tsx"),
    ]);
    const s = window.${NEW_RUN_DESIGN_STATE};
    globalStore.set(newRunPrefillAtom, { ...${JSON.stringify(prefill)}, onStarted: (id) => s.started.push(id) });
    document.querySelector('[data-new-run]')?.click();
    return true;
`;
const NEW_RUN_DESIGN_CALLS = `(window.${NEW_RUN_DESIGN_STATE}?.calls ?? [])`;
const NEW_RUN_DESIGN_FACE = `(() => {
    const d = ${NEW_RUN};
    if (!d) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const group = (label) => {
        const g = d.querySelector('[role="group"][aria-label="' + label + '"]');
        if (!g) return null;
        const buttons = [...g.querySelectorAll('button')];
        return { options: buttons.map(flat), pressed: buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map(flat) };
    };
    const design = d.querySelector('[data-new-run-design]');
    const goal = d.querySelector('textarea[aria-label="Goal"]');
    const start = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start run');
    return {
        start: group('Start from'),
        designFirst: group('Design first'),
        approvals: group('Approvals'),
        design: design
            ? {
                  spec: flat(design.querySelector('[data-new-run-design-spec]')) || null,
                  prototype: flat(design.querySelector('[data-new-run-design-prototype]')) || null,
                  controls: design.querySelectorAll('input, textarea, button, [contenteditable="true"]').length,
              }
            : null,
        goal: goal ? { value: goal.value, editable: !goal.readOnly && !goal.disabled } : null,
        startDisabled: start?.disabled ?? null,
        footer: flat(d.querySelector('[data-new-run-footer]')),
    };
})()`;
const setGoalExpr = (value) => `(() => {
    const el = ${NEW_RUN}?.querySelector('textarea[aria-label="Goal"]');
    if (!el) return false;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
})()`;

// Opens the window from a prefill and waits for its goal and the project's profile.
async function openNewRunDesign(h, prefill) {
    await lookEval(h, newRunDesignPrefill(prefill));
    const opened = await polishWaitFor(
        h,
        `${NEW_RUN}?.querySelector('textarea[aria-label="Goal"]')?.value === ${JSON.stringify(prefill.goal)}`,
        5000
    );
    // the project's profile is read after the window draws, and hydration must not undo the prefill's start
    await polishNap(1500);
    return opened ? h.ev(NEW_RUN_DESIGN_FACE) : null;
}

// Presses Start run and waits for the recorder to hear the launch and the window to close. The launch first resolves
// the lead route against the route catalog, whose first listing can take tens of seconds (pi's has taken 17s to fail).
const NEW_RUN_DESIGN_LAUNCH_MS = 60000;
async function startNewRunDesign(h) {
    const before = await h.ev(`${NEW_RUN_DESIGN_CALLS}.length`);
    await h.ev(`${NEW_RUN_START}?.click()`);
    const sent = await polishWaitFor(h, `${NEW_RUN_DESIGN_CALLS}.length > ${before}`, NEW_RUN_DESIGN_LAUNCH_MS);
    const closed = await polishWaitFor(h, `!${NEW_RUN}`, 5000);
    return { sent, closed, payload: sent ? await h.ev(`${NEW_RUN_DESIGN_CALLS}.at(-1)`) : null };
}

export const newRunDesign = {
    name: "new-run-design",
    surface: "jarvis",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-new-run-design-"));
        const ctx = {
            cwd,
            spec: join(cwd, "docs", "superpowers", "specs", "2026-10-27-verify-design.md"),
            prototype: join(cwd, ".superpowers", "design", "verify", "project", "Main.dc.html"),
        };
        try {
            await h.rpc("createproject", { name: NEW_RUN_DESIGN_PROJECT, path: cwd });
            ctx.project = NEW_RUN_DESIGN_PROJECT;
            await waitForProjectInConfig(h, NEW_RUN_DESIGN_PROJECT);
            // the project's own channel, so a launch resolves it rather than minting one
            const ch = await h.rpc("createchannel", { name: NEW_RUN_DESIGN_PROJECT, projectpath: cwd });
            ctx.channelId = ch.oid;
            // a launch writes the recent-projects list; put the developer's own back in teardown
            ctx.prevRecent = await h.ev(`localStorage.getItem(${JSON.stringify(RECENT_PROJECTS_KEY)})`);
            await polishReload(h);
            ctx.installed = await lookEval(h, NEW_RUN_DESIGN_INSTALL);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null || ctx.installed !== true) {
            rec("0. the project, its channel and the CreateRun recorder were made", false, ctx.arrangeError ?? "no recorder");
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        const design = { projectName: NEW_RUN_DESIGN_PROJECT, goal: NEW_RUN_DESIGN_GOAL, shape: "orchestrator", spec: ctx.spec, prototype: ctx.prototype };

        const opened = await openNewRunDesign(h, design);
        await h.shot("cdp-shots/new-run-design-1-approved-design.png");
        rec(
            "1. a prefill with a spec and a prototype opens New run on the Approved design start",
            opened?.start != null &&
                opened.start.options.join("|") === "Approved design|Goal|Plan file" &&
                opened.start.pressed.join("|") === "Approved design",
            JSON.stringify(opened)
        );
        if (opened == null) return steps;

        await h.ev(setGoalExpr(NEW_RUN_DESIGN_EDITED));
        await polishNap(200);
        const edited = await h.ev(NEW_RUN_DESIGN_FACE);
        rec(
            "2. the spec and prototype show read-only and the goal is editable",
            opened.design != null &&
                opened.design.spec === `Spec · ${ctx.spec}` &&
                opened.design.prototype === `Prototype · ${ctx.prototype}` &&
                opened.design.controls === 0 &&
                opened.designFirst == null &&
                edited?.goal?.editable === true &&
                edited.goal.value === NEW_RUN_DESIGN_EDITED,
            JSON.stringify({ design: opened.design, designFirst: opened.designFirst, goal: edited?.goal })
        );

        const launched = await startNewRunDesign(h);
        const p = launched.payload;
        rec(
            "3. Start run sends spec and prototype as fields and the goal without the spec path",
            launched.sent &&
                launched.closed &&
                p?.mode === "orchestrator" &&
                p.spec === ctx.spec &&
                p.prototype === ctx.prototype &&
                p.goal === NEW_RUN_DESIGN_EDITED &&
                !p.goal.includes(ctx.spec) &&
                p.designfirst === undefined,
            JSON.stringify(launched)
        );

        const plain = { projectName: NEW_RUN_DESIGN_PROJECT, goal: NEW_RUN_DESIGN_FIRST_GOAL, shape: "orchestrator" };
        const onGoal = await openNewRunDesign(h, plain);
        await h.ev(clickByText(`${NEW_RUN}?.querySelector('[role="group"][aria-label="Approvals"]')`, "button", "Ask me"));
        await h.ev(clickByText(`${NEW_RUN}?.querySelector('[role="group"][aria-label="Design first"]')`, "button", "Brainstorm"));
        await polishNap(200);
        const brainstorm = await h.ev(NEW_RUN_DESIGN_FACE);
        await h.shot("cdp-shots/new-run-design-2-design-first.png");
        const firstLaunch = brainstorm?.startDisabled === false ? await startNewRunDesign(h) : { why: "Start run is disabled" };
        const fp = firstLaunch.payload;
        rec(
            "4. the Goal start shows Design first; Brainstorm sends designfirst brainstorm",
            onGoal?.start?.pressed.join("|") === "Goal" &&
                onGoal.designFirst?.options.join("|") === "Off|Brainstorm|Mock up" &&
                onGoal.designFirst.pressed.join("|") === "Off" &&
                brainstorm?.designFirst?.pressed.join("|") === "Brainstorm" &&
                firstLaunch.sent === true &&
                fp?.mode === "orchestrator" &&
                fp.designfirst === "brainstorm" &&
                fp.goal === NEW_RUN_DESIGN_FIRST_GOAL &&
                fp.spec === undefined &&
                fp.prototype === undefined,
            JSON.stringify({ onGoal: onGoal && { start: onGoal.start, designFirst: onGoal.designFirst }, brainstorm: brainstorm?.designFirst, firstLaunch })
        );

        const noDesign = await openNewRunDesign(h, plain);
        await h.ev(clickByText(`${NEW_RUN}?.querySelector('[role="group"][aria-label="Design first"]')`, "button", "Brainstorm"));
        await h.ev(clickByText(`${NEW_RUN}?.querySelector('[role="group"][aria-label="Approvals"]')`, "button", "Autonomous"));
        await polishNap(200);
        const blocked = await h.ev(NEW_RUN_DESIGN_FACE);
        await h.shot("cdp-shots/new-run-design-3-autonomous-blocked.png");
        const callsBefore = await h.ev(`${NEW_RUN_DESIGN_CALLS}.length`);
        await h.ev(`${NEW_RUN_START}?.click()`);
        await polishNap(800);
        const callsAfter = await h.ev(`${NEW_RUN_DESIGN_CALLS}.length`);
        rec(
            "5. with Approvals autonomous, Design first blocks the launch with its reason",
            blocked?.approvals?.pressed.join("|") === "Autonomous" &&
                blocked.designFirst?.pressed.join("|") === "Brainstorm" &&
                blocked.startDisabled === true &&
                blocked.footer.includes("Design first needs Ask me approvals") &&
                callsAfter === callsBefore,
            JSON.stringify({ approvals: blocked?.approvals, designFirst: blocked?.designFirst, startDisabled: blocked?.startDisabled, footer: blocked?.footer, callsBefore, callsAfter })
        );

        rec(
            "6. a prefill with no design offers only Goal and Plan file",
            noDesign?.start?.options.join("|") === "Goal|Plan file" && noDesign.design == null,
            JSON.stringify({ start: noDesign?.start, design: noDesign?.design })
        );
        await h.ev(NEW_RUN_CANCEL);
        await polishWaitFor(h, `!${NEW_RUN}`, 3000);
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(NEW_RUN_CANCEL).catch(() => {});
        await lookEval(h, NEW_RUN_DESIGN_RESTORE).catch((e) =>
            console.error(`new-run-design teardown: restore CreateRunCommand failed: ${e?.message ?? e}`)
        );
        if (ctx.prevRecent !== undefined) {
            const key = JSON.stringify(RECENT_PROJECTS_KEY);
            await h
                .ev(
                    ctx.prevRecent === null
                        ? `localStorage.removeItem(${key})`
                        : `localStorage.setItem(${key}, ${JSON.stringify(ctx.prevRecent)})`
                )
                .catch(() => {});
        }
        await teardownFixtureRun(h, ctx, "new-run-design", {
            what: "delete the project",
            fn: () => (ctx.project ? h.rpc("deleteproject", { name: ctx.project }) : null),
        });
    },
};

// --- palette-notes: the Notes scope of Ctrl+P (docs/superpowers/plans/2026-10-08-user-notes-palette.md)
// The vault may already hold notes, some of today's: rows are found by the run's stamp, and arrange adds its own
// last so they lead the list.
const NOTES_STATE = `(() => {
    const d = ${PALETTE};
    if (!d) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const rows = [...d.querySelectorAll('[data-note-row]')].map((b) => ({
        id: b.dataset.noteRow,
        text: flat(b),
        selected: b.getAttribute('aria-selected') === 'true',
        hit: [...b.querySelectorAll('span.font-semibold')].map((s) => s.textContent).join(''),
    }));
    const pane = d.querySelector('[data-note-preview]');
    const arm = d.querySelector('[data-palette-arm]');
    const alert = d.querySelector('[role="alert"]');
    const fresh = d.querySelector('[data-note-new]');
    const body = d.querySelector('[data-note-body]');
    const title = d.querySelector('input[data-palette-input]');
    return {
        newRow: fresh
            ? {
                  text: flat(fresh),
                  selected: fresh.getAttribute('aria-selected') === 'true',
                  last: [...d.querySelectorAll('[role="option"]')].pop() === fresh,
              }
            : null,
        editor: body
            ? {
                  chip: flat(d.querySelector('[data-palette-drill]')),
                  title: title?.value ?? null,
                  titleLabel: title?.getAttribute('aria-label') ?? null,
                  body: body.value,
                  focus: document.activeElement === body ? 'body' : document.activeElement === title ? 'title' : null,
                  scopeRow: !!d.querySelector('[role="group"][aria-label="Scope"]'),
                  results: !!d.querySelector('[role="listbox"]'),
              }
            : null,
        token: d.querySelector('[data-palette-token]') ? flat(d.querySelector('[data-palette-token]')) : null,
        query: d.querySelector('input[data-palette-input]')?.value ?? null,
        split: !!d.querySelector('[data-palette-notes]'),
        rows,
        selected: rows.find((r) => r.selected)?.id ?? null,
        preview: pane
            ? {
                  text: flat(pane),
                  steps: [...pane.querySelectorAll('ol > li')].map(flat),
                  code: [...pane.querySelectorAll('[data-code-head]')].map((el) => flat(el.parentElement)),
                  scrollTop: pane.scrollTop,
                  hidden: pane.scrollHeight - pane.clientHeight,
              }
            : null,
        arm: arm ? { key: arm.dataset.paletteArm, text: flat(arm) } : null,
        error: alert ? flat(alert) : null,
        text: (d.innerText ?? '').replace(/\\s+/g, ' ').trim(),
    };
})()`;

async function notesStateWhen(h, ok, ms) {
    let state = null;
    for (let waited = 0; waited <= ms; waited += 250) {
        state = await h.ev(NOTES_STATE).catch(() => null);
        if (state != null && ok(state)) break;
        await polishNap(250);
    }
    return state;
}

// paletteKey's event is not cancelable, so it cannot tell whether the palette took the key
const NOTES_DEL_TAKEN = `(() => {
    const el = ${PALETTE_INPUT};
    if (!el) return null;
    return !el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true }));
})()`;
const notesCaretExpr = (at) => `(() => {
    const el = ${PALETTE_INPUT};
    if (!el) return null;
    const pos = ${at === "end" ? "el.value.length" : at};
    el.setSelectionRange(pos, pos);
    return el.selectionStart;
})()`;
// setInputExpr's setter is the input's; the editor's body is a textarea
const noteBodyExpr = (value) => `(() => {
    const el = ${PALETTE}?.querySelector('[data-note-body]');
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
})()`;
// the scrim is the dialog's parent, and it leaves only on a press that lands on itself
const NOTES_BACKDROP_PRESS = `(() => {
    const scrim = ${PALETTE}?.parentElement;
    if (!scrim) return false;
    scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
})()`;

const NOTES_LONG_PARAGRAPHS = 120;

export const paletteNotes = {
    name: "palette-notes",
    surface: "jarvis",
    async arrange(h) {
        const stamp = `palnotes${Date.now().toString(36)}`;
        // newest first, as the list shows them: arrange adds them in reverse
        const fixtures = {
            markdown: {
                title: `verify ${stamp} markdown zebra`,
                body: `Steps of ${stamp}:\n\n1. first step alpha\n2. second step beta\n\n\`\`\`sh\necho fenced-${stamp}\n\`\`\``,
            },
            quokka: { title: `verify ${stamp} quokka`, body: `the quokka body of ${stamp}` },
            narwhal: { title: `verify ${stamp} narwhal`, body: `the narwhal body of ${stamp}` },
            long: {
                title: `verify ${stamp} long walrus`,
                body: Array.from({ length: NOTES_LONG_PARAGRAPHS }, (_, i) => `paragraph ${i + 1} of the long note`).join("\n\n"),
            },
        };
        const ctx = { stamp, fixtures, ids: {} };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            ctx.vault = await vaultRoot(h);
            const remote = vaultRemote(ctx.vault);
            if (remote) throw new Error(`the vault ${ctx.vault} has a git remote (${remote}): not writing fixture notes into it`);
            for (const name of ["long", "narwhal", "quokka", "markdown"]) {
                ctx.ids[name] = (await h.rpc("noteadd", fixtures[name])).id;
                // a file time of its own, so the order by modified time is the order added
                await polishNap(50);
            }
            await polishReload(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. four notes were added", false, ctx.arrangeError);
            return steps;
        }
        const { stamp, fixtures, ids } = ctx;
        const stamped = (s) => (s?.rows ?? []).filter((r) => r.text.includes(stamp)).map((r) => r.id);
        const exists = async (id) => ((await h.rpc("notelist", null)) ?? []).some((n) => n.id === id);
        const key = (k, mods) => h.ev(paletteKey(k, mods));
        const type = (text) => h.ev(setInputExpr(PALETTE_INPUT, text));
        const CTRL = { ctrlKey: true };
        const editorKey = (field, k, mods) => h.ev(noteKeyIn(field, k, mods));
        const typeBody = (text) => h.ev(noteBodyExpr(text));
        const inEditor = (s) => s.editor != null;
        const inList = (s) => s.editor == null && s.split;
        const noteOf = async (id) => ((await h.rpc("notelist", null)) ?? []).find((n) => n.id === id) ?? null;
        const editorBrief = (s) => JSON.stringify({ editor: s?.editor, arm: s?.arm, error: s?.error, split: s?.split, selected: s?.selected });
        const selectedIs = (id) => (s) => s.split && s.selected === id;
        const brief = (s) => JSON.stringify({ token: s?.token, query: s?.query, split: s?.split, selected: s?.selected, rows: stamped(s), arm: s?.arm, error: s?.error });

        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await h.goto("jarvis");
        if (!(await openPalette(h))) {
            rec("0. Ctrl+P opens the palette", false, "the palette never opened");
            return steps;
        }

        await h.ev(`${PALETTE}?.querySelector('[data-palette-scope="notes"]')?.click()`);
        const order = [ids.markdown, ids.quokka, ids.narwhal, ids.long];
        const list = await notesStateWhen(h, (s) => s.split && stamped(s).length === 4, 8000);
        await h.shot("cdp-shots/palette-notes-list.png");
        rec(
            "1. the Notes scope lists the notes beside a preview",
            list?.token === "Notes" && list.split && stamped(list).join() === order.join() && list.selected === ids.markdown,
            `want ${order.join()} with the first selected: ${brief(list)}`
        );

        rec(
            "2. the preview renders the selected note's markdown",
            list?.preview != null &&
                list.preview.steps.join("|") === "first step alpha|second step beta" &&
                list.preview.code.some((c) => c.includes(`echo fenced-${stamp}`)) &&
                !list.preview.text.includes("```"),
            JSON.stringify(list?.preview)
        );

        await key("ArrowDown");
        const second = await notesStateWhen(h, selectedIs(ids.quokka), 3000);
        rec(
            "3. ↓ moves the preview to the next note",
            second?.selected === ids.quokka && second.preview?.text === fixtures.quokka.body,
            JSON.stringify({ selected: second?.selected, preview: second?.preview?.text })
        );

        await type(`${stamp} quokka`);
        const filtered = await notesStateWhen(h, (s) => s.split && s.rows.length === 1, 3000);
        rec(
            "4. typing filters by title",
            filtered?.rows.length === 1 && filtered.rows[0].id === ids.quokka && filtered.rows[0].hit.includes("quokka"),
            JSON.stringify(filtered?.rows)
        );

        // each open starts fresh on All
        await openPalette(h);
        await type("no:");
        const prefixed = await notesStateWhen(h, (s) => s.token === "Notes", 3000);
        rec("5. no: from All narrows to Notes", prefixed?.token === "Notes" && prefixed.query === "", brief(prefixed));

        await openPalette(h);
        await type(`${stamp} narwhal`);
        const inAll = await paletteStateWhen(h, (s) => s.groups.some((g) => g.label === "Notes"), 5000);
        const notesGroup = inAll?.groups.find((g) => g.label === "Notes");
        const foundInAll =
            inAll?.token == null && notesGroup?.rows.some((r) => r.includes(fixtures.narwhal.title)) && (inAll.selected ?? "").includes(fixtures.narwhal.title);
        await key("Enter");
        const shown = await notesStateWhen(h, selectedIs(ids.narwhal), 3000);
        rec(
            "6. a note is found from All and Enter shows it in Notes",
            foundInAll && shown?.token === "Notes" && shown.selected === ids.narwhal && shown.preview?.text === fixtures.narwhal.body,
            `in All: ${JSON.stringify({ selected: inAll?.selected, groups: inAll?.groups })} then ${brief(shown)}`
        );

        // the whole list again, on the narwhal note: a neighbour on each side
        await type("");
        await notesStateWhen(h, (s) => s.split && stamped(s).length === 4, 3000);
        await key("ArrowDown");
        await key("ArrowDown");
        await notesStateWhen(h, selectedIs(ids.narwhal), 3000);
        await key("Delete");
        const armed = await notesStateWhen(h, (s) => s.arm != null, 3000);
        const armedExists = await exists(ids.narwhal);
        await key("ArrowDown");
        const disarmed = await notesStateWhen(h, (s) => s.arm == null && s.selected === ids.long, 3000);
        const disarmedExists = await exists(ids.narwhal);
        rec(
            "7. one del arms, another key disarms",
            armed?.arm?.key === "del" &&
                armed.arm.text.includes(`del again deletes “${fixtures.narwhal.title}”`) &&
                armedExists &&
                disarmed?.arm == null &&
                disarmed?.selected === ids.long &&
                disarmedExists,
            JSON.stringify({ armed: armed?.arm, armedExists, after: disarmed?.arm, selected: disarmed?.selected, disarmedExists })
        );

        await key("ArrowUp");
        await notesStateWhen(h, selectedIs(ids.narwhal), 3000);
        await key("Delete");
        await notesStateWhen(h, (s) => s.arm != null, 3000);
        await key("Delete");
        const deleted = await notesStateWhen(h, (s) => !stamped(s).includes(ids.narwhal), 5000);
        await h.shot("cdp-shots/palette-notes-deleted.png");
        const deletedExists = await exists(ids.narwhal);
        rec(
            "8. del twice deletes the note",
            deleted != null && stamped(deleted).join() === [ids.markdown, ids.quokka, ids.long].join() && deleted.selected === ids.long && !deletedExists,
            `still listed by RPC=${deletedExists} ${brief(deleted)}`
        );

        const top = await notesStateWhen(h, (s) => s.selected === ids.long && s.preview?.hidden > 0, 3000);
        await key("PageDown");
        const down = await notesStateWhen(h, (s) => s.preview?.scrollTop > 0, 3000);
        await key("PageUp");
        const up = await notesStateWhen(h, (s) => s.preview?.scrollTop === 0, 3000);
        rec(
            "9. PageDown and PageUp scroll a long note's preview",
            top?.preview?.scrollTop === 0 &&
                top.preview.hidden > 0 &&
                down?.preview?.scrollTop > 0 &&
                down.selected === ids.long &&
                up?.preview?.scrollTop === 0 &&
                up.selected === ids.long,
            JSON.stringify({
                hidden: top?.preview?.hidden,
                scroll: [top?.preview?.scrollTop, down?.preview?.scrollTop, up?.preview?.scrollTop],
                selected: [top?.selected, down?.selected, up?.selected],
            })
        );

        await type(stamp);
        await notesStateWhen(h, (s) => s.split && s.rows.length === 3 && s.selected != null, 3000);
        const caret = await h.ev(notesCaretExpr(0));
        const takenMid = await h.ev(NOTES_DEL_TAKEN);
        const mid = await h.ev(NOTES_STATE);
        const midExists = mid?.selected != null && (await exists(mid.selected));
        // the same key with the caret at the end is taken, so a false above is the caret's doing
        await h.ev(notesCaretExpr("end"));
        const takenEnd = await h.ev(NOTES_DEL_TAKEN);
        const endArmed = await notesStateWhen(h, (s) => s.arm != null, 3000);
        await key("Shift");
        await notesStateWhen(h, (s) => s.arm == null, 3000);
        rec(
            "10. del with the caret mid-query edits the text and arms nothing",
            caret === 0 && takenMid === false && mid?.arm == null && mid?.query === stamp && midExists && takenEnd === true && endArmed?.arm != null,
            JSON.stringify({ caret, takenMid, arm: mid?.arm, query: mid?.query, midExists, takenEnd, endArm: endArmed?.arm })
        );

        await type("");
        await notesStateWhen(h, (s) => s.split && stamped(s).length === 3, 3000);
        await key("ArrowDown");
        const onGone = await notesStateWhen(h, selectedIs(ids.quokka), 3000);
        await h.rpc("notedelete", { id: ids.quokka });
        await key("Delete");
        await notesStateWhen(h, (s) => s.arm != null, 3000);
        await key("Delete");
        const failed = await notesStateWhen(h, (s) => s.error != null && !stamped(s).includes(ids.quokka), 5000);
        rec(
            "11. deleting a note that is already gone says so and reloads the list",
            onGone?.selected === ids.quokka &&
                (failed?.error ?? "").startsWith("Delete failed") &&
                stamped(failed).join() === [ids.markdown, ids.long].join(),
            brief(failed)
        );

        rec(
            "12. the New note row sits last and is not the default",
            list?.selected === ids.markdown &&
                list.newRow?.last === true &&
                list.newRow.text.includes("New note") &&
                !list.newRow.selected &&
                list.text.includes("ctrl ⏎ Edits it"),
            JSON.stringify({ selected: list?.selected, newRow: list?.newRow, text: list?.text.slice(-260) })
        );

        // a fresh open: the markdown note leads and is selected
        await openPalette(h);
        await h.ev(`${PALETTE}?.querySelector('[data-palette-scope="notes"]')?.click()`);
        await notesStateWhen(h, (s) => selectedIs(ids.markdown)(s) && stamped(s).length === 2, 5000);
        await key("Enter", CTRL);
        const opened = await notesStateWhen(h, (s) => inEditor(s) && s.editor.focus === "body", 3000);
        await h.shot("cdp-shots/palette-notes-editor.png");
        rec(
            "13. ctrl ⏎ opens the note in the editor",
            opened?.editor != null &&
                /^Notes\s*›\s*Edit$/.test(opened.editor.chip) &&
                opened.editor.titleLabel === "Title" &&
                opened.editor.title === fixtures.markdown.title &&
                opened.editor.body.includes("```sh") &&
                opened.editor.body.includes(`echo fenced-${stamp}`) &&
                opened.editor.focus === "body" &&
                !opened.editor.scopeRow &&
                !opened.editor.results &&
                opened.text.includes(`Saves “${fixtures.markdown.title}”`),
            editorBrief(opened)
        );

        const focusAfter = async (field, k, mods) => {
            const taken = await editorKey(field, k, mods);
            const s = await h.ev(NOTES_STATE);
            return { taken, focus: s?.editor?.focus ?? null, title: s?.editor?.title, body: s?.editor?.body };
        };
        const toTitle = await focusAfter("body", "Tab");
        const toBody = await focusAfter("title", "Tab");
        const backToTitle = await focusAfter("body", "Tab", { shiftKey: true });
        const enterInTitle = await focusAfter("title", "Enter");
        rec(
            "14. Tab moves between title and body, and Enter in the title moves to the body",
            toTitle.focus === "title" &&
                toBody.focus === "body" &&
                backToTitle.focus === "title" &&
                enterInTitle.taken === true &&
                enterInTitle.focus === "body" &&
                enterInTitle.title === opened?.editor?.title &&
                enterInTitle.body === opened?.editor?.body,
            JSON.stringify({ focus: [toTitle.focus, toBody.focus, backToTitle.focus, enterInTitle.focus], enterTaken: enterInTitle.taken })
        );

        await h.ev(PEEKS_ESC);
        const escBack = await notesStateWhen(h, inList, 3000);
        await key("Enter", CTRL);
        const reopened = await notesStateWhen(h, inEditor, 3000);
        await h.ev(`${PALETTE}?.querySelector('[data-palette-drill]')?.click()`);
        const chipBack = await notesStateWhen(h, inList, 3000);
        rec(
            "15. esc on an unchanged draft goes straight back, and so does the chip",
            // Tab never cycled the scope: both leaves land on Notes
            escBack?.editor == null &&
                escBack?.token === "Notes" &&
                escBack.selected === ids.markdown &&
                reopened?.editor != null &&
                chipBack?.editor == null &&
                chipBack?.token === "Notes" &&
                chipBack.selected === ids.markdown,
            `after esc: ${editorBrief(escBack)} reopened: ${editorBrief(reopened)} after the chip: ${editorBrief(chipBack)}`
        );

        // the list wraps: ↑ from the first note is the New note row
        await key("ArrowUp");
        const onNew = await notesStateWhen(h, (s) => s.newRow?.selected === true, 3000);
        await key("Enter");
        const blank = await notesStateWhen(h, (s) => inEditor(s) && s.editor.focus === "title", 3000);
        await h.ev(PEEKS_ESC);
        const blankLeft = await notesStateWhen(h, inList, 3000);
        rec(
            "16. New note from an empty query opens on an empty title, and leaves without asking",
            onNew?.newRow?.selected === true &&
                onNew.preview?.text === "" &&
                onNew.text.includes("Writes a new note") &&
                blank?.editor != null &&
                /^Notes\s*›\s*New$/.test(blank.editor.chip) &&
                blank.editor.title === "" &&
                blank.editor.body === "" &&
                blank.editor.focus === "title" &&
                blank.text.includes("Saves the note") &&
                blankLeft?.editor == null &&
                blankLeft?.token === "Notes" &&
                stamped(blankLeft).length === 2,
            `row: ${JSON.stringify({ newRow: onNew?.newRow, preview: onNew?.preview?.text })} editor: ${editorBrief(blank)} left: ${editorBrief(blankLeft)}`
        );

        const edited = { title: `verify ${stamp} edited walrus`, body: `the edited body of ${stamp}` };
        await key("ArrowUp");
        await notesStateWhen(h, selectedIs(ids.long), 3000);
        await key("Enter", CTRL);
        await notesStateWhen(h, inEditor, 3000);
        await type(edited.title);
        await typeBody(edited.body);
        await editorKey("body", "Enter", CTRL);
        const saved = await notesStateWhen(h, (s) => inList(s) && s.preview?.text === edited.body, 5000);
        const savedNote = await noteOf(ids.long);
        rec(
            "17. ctrl ⏎ saves the edit",
            savedNote?.title === edited.title &&
                (savedNote.body ?? "").trim() === edited.body &&
                saved?.editor == null &&
                saved?.token === "Notes" &&
                saved.query === "" &&
                saved.selected === ids.long &&
                saved.preview?.text === edited.body,
            `by RPC: ${JSON.stringify(savedNote)} ${editorBrief(saved)} preview=${JSON.stringify(saved?.preview?.text)}`
        );

        await key("Enter", CTRL);
        await notesStateWhen(h, inEditor, 3000);
        const armedBy = async (text, leave) => {
            await typeBody(text);
            await notesStateWhen(h, (s) => s.arm == null && s.editor?.body === text, 3000);
            await h.ev(leave);
            const s = await notesStateWhen(h, (st) => st.arm != null || st.editor == null, 3000);
            return { open: await h.ev(`!!${PALETTE_INPUT}`), body: s?.editor?.body ?? null, arm: s?.arm ?? null };
        };
        const byEsc = await armedBy("typed, then esc", PEEKS_ESC);
        const byToggle = await armedBy("typed, then ctrl p", PALETTE_TOGGLE);
        const byBackdrop = await armedBy("typed, then a click outside", NOTES_BACKDROP_PRESS);
        await h.ev(PEEKS_ESC);
        const discarded = await notesStateWhen(h, inList, 3000);
        const keptNote = await noteOf(ids.long);
        const armedOk = (r, text) =>
            r.open === true && r.body === text && r.arm?.key === "esc" && r.arm.text.includes("esc again discards your changes");
        rec(
            "18. esc on a changed draft asks once, and so do Ctrl+P and a click outside",
            armedOk(byEsc, "typed, then esc") &&
                armedOk(byToggle, "typed, then ctrl p") &&
                armedOk(byBackdrop, "typed, then a click outside") &&
                discarded?.editor == null &&
                discarded?.token === "Notes" &&
                (keptNote?.body ?? "").trim() === edited.body,
            `${JSON.stringify({ byEsc, byToggle, byBackdrop })} then ${editorBrief(discarded)} by RPC: ${JSON.stringify(keptNote?.body)}`
        );

        await notesStateWhen(h, selectedIs(ids.long), 3000);
        await key("Enter", CTRL);
        await notesStateWhen(h, inEditor, 3000);
        const orphan = `typed for a note that is gone ${stamp}`;
        await typeBody(orphan);
        await h.rpc("notedelete", { id: ids.long });
        await editorKey("body", "Enter", CTRL);
        const saveFailed = await notesStateWhen(h, (s) => s.error != null, 5000);
        await h.ev(PEEKS_ESC);
        await notesStateWhen(h, (s) => s.arm != null, 3000);
        await h.ev(PEEKS_ESC);
        const afterGone = await notesStateWhen(h, inList, 3000);
        rec(
            "19. saving a note that is already gone says so and keeps the text",
            (saveFailed?.error ?? "").startsWith("Save failed") &&
                saveFailed.editor?.body === orphan &&
                afterGone?.editor == null &&
                stamped(afterGone).join() === ids.markdown,
            `${editorBrief(saveFailed)} then rows=${stamped(afterGone).join()}`
        );

        const freshTitle = `zzqx ${stamp} fresh`;
        const freshBody = `the body of a note written here, ${stamp}`;
        await type(freshTitle);
        const noMatch = await notesStateWhen(h, (s) => s.split && s.rows.length === 0 && s.newRow?.selected === true, 3000);
        await key("Enter");
        const fresh = await notesStateWhen(h, (s) => inEditor(s) && s.editor.focus === "body", 3000);
        await typeBody(freshBody);
        await notesStateWhen(h, (s) => s.editor?.body === freshBody, 3000);
        await h.shot("cdp-shots/palette-notes-new.png");
        await editorKey("body", "Enter", CTRL);
        const created = await notesStateWhen(h, (s) => inList(s) && s.preview?.text === freshBody, 5000);
        const createdNote = ((await h.rpc("notelist", null)) ?? []).find((n) => n.title === freshTitle) ?? null;
        rec(
            "20. New note takes the typed text as its title",
            noMatch?.rows.length === 0 &&
                noMatch.newRow?.selected === true &&
                noMatch.text.includes(`Writes a new note titled “${freshTitle}”`) &&
                fresh?.editor != null &&
                /^Notes\s*›\s*New$/.test(fresh.editor.chip) &&
                fresh.editor.title === freshTitle &&
                createdNote != null &&
                (createdNote.body ?? "").trim() === freshBody &&
                created?.selected === createdNote.id &&
                created.query === "",
            `no match: ${JSON.stringify({ rows: noMatch?.rows, newRow: noMatch?.newRow })} editor: ${editorBrief(fresh)} by RPC: ${JSON.stringify(createdNote)} ${editorBrief(created)}`
        );

        await key("Enter", CTRL);
        await notesStateWhen(h, inEditor, 3000);
        const keptText = `text kept through a refused title, ${stamp}`;
        await typeBody(keptText);
        await type("");
        await editorKey("title", "Enter", CTRL);
        const refusedTitle = await notesStateWhen(h, (s) => s.error != null, 3000);
        const untitled = createdNote != null ? await noteOf(createdNote.id) : null;
        await h.ev(PEEKS_ESC);
        await notesStateWhen(h, (s) => s.arm != null, 3000);
        await h.ev(PEEKS_ESC);
        await notesStateWhen(h, inList, 3000);
        rec(
            "21. a title the store refuses is named and the text kept",
            refusedTitle?.error === "A note needs a title." &&
                refusedTitle.editor?.title === "" &&
                refusedTitle.editor.body === keptText &&
                untitled?.title === freshTitle,
            `${editorBrief(refusedTitle)} by RPC: ${JSON.stringify(untitled)}`
        );

        await type(`${stamp} markdown`);
        const onCopy = await notesStateWhen(h, selectedIs(ids.markdown), 3000);
        await h.ev(notesClipStub(true));
        await key("Enter");
        const refused = await notesStateWhen(h, (s) => (s.error ?? "").startsWith("Copy failed"), 3000);
        rec(
            "22. a copy the clipboard refuses says so and keeps the palette open",
            onCopy?.selected === ids.markdown && (refused?.error ?? "").startsWith("Copy failed") && refused.selected === ids.markdown,
            brief(refused)
        );

        await h.ev(notesClipStub(false));
        await key("Enter");
        const closed = await polishWaitFor(h, `!${PALETTE_INPUT}`, 3000);
        const copied = await h.ev(`window.__notesClip ?? null`);
        const lingering = await h.ev(`[...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent).join(' | ')`);
        await h.ev(NOTES_CLIP_RESTORE);
        const want = `# ${fixtures.markdown.title}\n\n${fixtures.markdown.body}\n`;
        rec(
            "23. Enter copies the note and closes the palette",
            closed && copied?.length === 1 && copied[0] === want && !lingering.includes("failed"),
            JSON.stringify({ closed, copied, want, lingering })
        );
        return steps;
    },
    async teardown(h, ctx) {
        const failed = [];
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                failed.push(`${what}: ${e?.message ?? e}`);
            }
        };
        await step("restore the clipboard", () => h.ev(NOTES_CLIP_RESTORE));
        await step("close the palette", () => h.ev(PEEKS_ESC));
        await step("delete the notes this run left", async () => {
            for (const n of (await h.rpc("notelist", null)) ?? []) {
                if (n.title.includes(ctx.stamp)) await h.rpc("notedelete", { id: n.id });
            }
        });
        if (failed.length > 0) throw new Error(failed.join("; "));
    },
};
