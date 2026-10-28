// Agent surface scenarios: terminal, TUI, agent tree rail, canvases, resource monitor, composer.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SURFACE_LABEL } from "./attach.mjs";
import { SCENARIOS as COCKPIT_FIXTURES } from "../cockpit-fixtures/scenarios.mjs";
import {
    CANVAS_PANE,
    CANVAS_TABS_WAIT_MS,
    CANVAS_TOPIC,
    COCKPIT,
    CTRL,
    LOOK_TOOLTIP_STYLE,
    MIN_FONT_PX,
    MODELS_VIEWPORT,
    PALETTE,
    PALETTE_INPUT,
    PALETTE_STATE,
    RAIL_VISIBLE_KEY,
    RUN_SHEET_POLISH_TASKS,
    TREE_RAIL_FIXTURE,
    TREE_RAIL_LEAD,
    UI_ROUTE,
    arrangeFixtureRun,
    floorDetail,
    floorOk,
    floorStep,
    fstWriteRun,
    git,
    lookEval,
    lookHover,
    lookOpen,
    lookShot,
    openCanvasTerminal,
    openPalette,
    paintEval,
    paletteKey,
    polishNap,
    polishWaitFor,
    pressCanvasKey,
    setFinderQuery,
    setInputExpr,
    skipStep,
    teardownFixtureRun,
    tooltipLookOk,
    treeRailRoster,
    waitForDispatch,
    waitForProjectInConfig,
    waveService,
} from "./scenarios-shared.mjs";

// --- terminal palette follows the cockpit theme -------------------------------------------------
// Asserts against window.term (term.tsx assigns it) + the resolved custom properties, NOT pixels:
// reading the applied xterm theme is exact, where a screenshot sample is not. The shots are for a
// human to judge whether Claude Code's own diff colors read well, which no assertion can decide.
export const terminalTheme = {
    name: "terminal-theme",
    surface: "agent",
    async arrange(h) {
        // step 4 reads window.term, which an HMR can leave pointing at a detached TermWrap — see freshBoot
        return { booted: await freshBoot(h) };
    },
    async assert(h, ctx) {
        const steps = [];
        steps.push({
            step: "0. fresh boot, so window.term is the mounted terminal",
            ok: ctx.booted === true,
            detail: `reloaded=${ctx.booted}`,
        });
        const readVar = (name) =>
            h.ev(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
        const readTheme = (field) => h.ev(`window.term?.terminal?.options?.theme?.${field} ?? null`);
        // Scoped to the theme grid: a document-wide button query picks the app bar's global search
        // button instead of the preset the name belongs to (see cdp-scenario-unscoped-button-query).
        const pickPreset = (name) =>
            h.ev(`(() => {
                const scope = document.querySelector('[data-theme-presets]') || document;
                const b = [...scope.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(name)});
                if (!b) return false;
                b.click();
                return true;
            })()`);

        await h.goto("agent");
        const bg = await readTheme("background");
        const cssBg = await readVar("--color-background");
        steps.push({
            step: "1. xterm background === --color-background (the black seam is gone)",
            ok: !!bg && bg.toLowerCase() === cssBg.toLowerCase(),
            detail: `xterm=${bg} css=${cssBg}`,
        });

        const blue = await readTheme("blue");
        const cssAccent = await readVar("--color-accent");
        steps.push({
            step: "2. xterm ANSI blue === --color-accent (palette derives from theme roles)",
            ok: !!blue && blue.toLowerCase() === cssAccent.toLowerCase(),
            detail: `blue=${blue} accent=${cssAccent}`,
        });

        steps.push({
            step: "3. xterm background is opaque (#rrggbb, never #00000000)",
            ok: typeof bg === "string" && /^#[0-9a-f]{6}$/i.test(bg),
            detail: `background=${bg}`,
        });
        await h.shot("cdp-shots/terminal-theme-midnight.png");

        // switch presets in Settings, return to the Agent surface, and confirm the TUI re-skinned
        await h.goto("settings");
        const picked = await pickPreset("Monokai");
        await h.goto("agent");
        const bg2 = await readTheme("background");
        steps.push({
            step: "4. switching preset re-skins the live TUI with no remount",
            ok: picked && !!bg2 && bg2.toLowerCase() !== bg.toLowerCase(),
            detail: `picked=${picked} before=${bg} after=${bg2}`,
        });
        await h.shot("cdp-shots/terminal-theme-monokai.png");
        return steps;
    },
    async teardown(h) {
        // restore the default preset so a later scenario is not judged against Monokai
        await h.goto("settings");
        await h.ev(`(() => {
            const scope = document.querySelector('[data-theme-presets]') || document;
            const b = [...scope.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Midnight');
            if (b) b.click();
            return true;
        })()`);
        await h.goto("cockpit");
    },
};

// Focus the terminal by clicking its body: terminal.focus() alone leaves document.activeElement on
// BODY, which would make every assertion below run in the wrong (non-editable) posture.
// --- cockpit chords reach through a focused TUI -------------------------------------------------
// The leak is the failure mode that matters, so every step below asserts CONSUMPTION as well as
// effect. How consumption is observed, and why it is not a terminal-buffer diff:
//
// The dispatcher listens on window CAPTURE and calls stopImmediatePropagation() for a key it claims
// (dispatcher.ts). A sibling window-capture listener registered afterwards therefore fires only for
// keys the cockpit did NOT claim — and a claimed key raises no event anywhere, so it cannot reach
// xterm's textarea handler and cannot reach the PTY. Every step carries a control press through the
// same probe, so "consumed" can never be a silent no-op.
//
// Two observables that look more direct are unusable here. A terminal-buffer diff only moves when a
// live shell echoes, and the dev app's terminals are frequently idle — the diff then reads "no leak"
// for every key, including one that leaked. A probe on the xterm textarea is worse: xterm's own
// handler is registered on that element first and stops immediate propagation, so an unclaimed key
// looks identical to a claimed one.
const focusTui = async (h) => {
    await h.goto("agent");
    const box = await h.ev(`(() => {
        const el = document.querySelector('.cockpit-focus-pane .xterm-screen') || document.querySelector('.cockpit-focus-pane');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!box) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
        await h.cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await new Promise((r) => setTimeout(r, 500));
    return h.ev(
        `(() => { const a = document.activeElement; return !!(a && a.classList && a.classList.contains('xterm-helper-textarea')); })()`
    );
};

// A full page reload, for two reasons that both bite only after a dev-session hot reload:
//
//  1. Probe ordering. Capture-phase listeners on the same target run in REGISTRATION order, so the
//     consumption probe below is valid only when the dispatcher registered first. Boot registers it;
//     an HMR of a keybinding file re-registers it at the BACK of the queue, after the probe, and every
//     "consumed" step then reports a leak that is not real.
//  2. window.term freshness. term.tsx assigns window.term on mount. After an HMR the global can point
//     at a DETACHED TermWrap whose TermThemeUpdater is gone, so its options.theme never changes again
//     and "switching preset re-skins the TUI" fails against a terminal that is no longer on screen.
//
// Both failure modes are safe in direction (no false PASS) but waste a run, so pay the reload.
const freshBoot = async (h) => {
    await h.ev("location.reload()");
    for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const ready = await h.ev(`document.querySelectorAll('nav button').length > 0`).catch(() => false);
        if (ready) {
            await new Promise((r) => setTimeout(r, 1500)); // let boot settle before driving it
            return true;
        }
    }
    return false;
};

const installProbe = (h) =>
    h.ev(`(() => {
        window.__seen = [];
        window.__probeFn = (e) => window.__seen.push((e.ctrlKey ? "Ctrl+" : "") + e.key);
        window.addEventListener("keydown", window.__probeFn, true);
        return true;
    })()`);

// Returns the keys the probe saw: [] means the cockpit consumed the press.
const pressKey = async (h, { key, code, keyCode, modifiers = 0 }) => {
    await h.ev("window.__seen = []");
    for (const type of ["keyDown", "keyUp"]) {
        await h.cdp("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: keyCode });
    }
    await new Promise((r) => setTimeout(r, 450));
    return JSON.parse(await h.ev("JSON.stringify(window.__seen || [])"));
};
const whichKeyOpen = (h) => h.ev(`document.body.innerText.includes('Cockpit (home)')`);
const treeVisible = (h) => h.ev(`!!document.querySelector('[data-agent-tree]')`);

export const tuiLeader = {
    name: "tui-leader",
    surface: "agent",
    async arrange(h) {
        const booted = await freshBoot(h);
        const focused = await focusTui(h);
        await installProbe(h);
        return { booted, focused };
    },
    async assert(h, ctx) {
        const steps = [];
        steps.push({
            step: "0. the terminal holds focus, so these run in the editable posture",
            ok: ctx.booted === true && ctx.focused === true,
            detail: `reloaded=${ctx.booted} xterm textarea focused=${ctx.focused}`,
        });

        // Control press. Without this, every "consumed" verdict below could be a dead probe.
        const seenX = await pressKey(h, { key: "x", code: "KeyX", keyCode: 88 });
        steps.push({
            step: "1. control: an unclaimed key is NOT consumed (the probe is live)",
            ok: seenX.length > 0,
            detail: `probe saw ${JSON.stringify(seenX)}`,
        });

        // The pre-existing posture must not regress: a bare letter still belongs to the agent.
        const seenG = await pressKey(h, { key: "g", code: "KeyG", keyCode: 71 });
        const wkBare = await whichKeyOpen(h);
        steps.push({
            step: "2. a bare g still reaches the agent and opens no leader",
            ok: seenG.length > 0 && wkBare === false,
            detail: `probe saw ${JSON.stringify(seenG)}, which-key=${wkBare}`,
        });

        const seenCtrlG = await pressKey(h, { key: "g", code: "KeyG", keyCode: 71, modifiers: CTRL });
        const wkChord = await whichKeyOpen(h);
        steps.push({
            step: "3. Ctrl+G opens the which-key bar and is consumed (no ^G to the PTY)",
            ok: seenCtrlG.length === 0 && wkChord === true,
            detail: `probe saw ${JSON.stringify(seenCtrlG)}, which-key=${wkChord}`,
        });

        // singles fallback: `]` is a navigate-guarded single, dormant in the TUI without a leader
        const surfBefore = await h.activeSurfaceLabel();
        const seenBracket = await pressKey(h, { key: "]", code: "BracketRight", keyCode: 221 });
        const surfAfter = await h.activeSurfaceLabel();
        steps.push({
            step: "4. under the leader, the singles fallback runs ']' and consumes it",
            ok: seenBracket.length === 0 && surfAfter !== surfBefore,
            detail: `${surfBefore} -> ${surfAfter}, probe saw ${JSON.stringify(seenBracket)}`,
        });

        // sequence continuation from inside the terminal
        await focusTui(h);
        await pressKey(h, { key: "g", code: "KeyG", keyCode: 71, modifiers: CTRL });
        const seenC = await pressKey(h, { key: "c", code: "KeyC", keyCode: 67 });
        const surfC = await h.activeSurfaceLabel();
        steps.push({
            step: "5. Ctrl+G then c teleports to Jarvis from inside the terminal",
            ok: seenC.length === 0 && surfC === SURFACE_LABEL.jarvis,
            detail: `active=${surfC}, probe saw ${JSON.stringify(seenC)}`,
        });

        // Escape means cancel while the which-key bar is showing — never navigate (spec decision 8)
        await focusTui(h);
        await pressKey(h, { key: "g", code: "KeyG", keyCode: 71, modifiers: CTRL });
        const wkOn = await whichKeyOpen(h);
        const escFrom = await h.activeSurfaceLabel();
        await pressKey(h, { key: "Escape", code: "Escape", keyCode: 27 });
        const wkOff = await whichKeyOpen(h);
        const escTo = await h.activeSurfaceLabel();
        steps.push({
            step: "6. Ctrl+G then Escape cancels the leader without navigating",
            ok: wkOn === true && wkOff === false && escTo === escFrom,
            detail: `which-key ${wkOn}->${wkOff}, surface ${escFrom}->${escTo}`,
        });

        await h.shot("cdp-shots/tui-leader.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

export const tuiFullscreen = {
    name: "tui-fullscreen",
    surface: "agent",
    async arrange(h) {
        await freshBoot(h);
        const focused = await focusTui(h);
        await installProbe(h);
        return { focused };
    },
    async assert(h, ctx) {
        const steps = [];
        // fullscreen unmounts the agent tree (agentsurface.tsx); its absence is the observable
        const before = await treeVisible(h);
        const winBefore = await h.ev(
            `JSON.stringify({fullscreenEl: !!document.fullscreenElement, w: window.innerWidth, h: window.innerHeight})`
        );
        const seen = await pressKey(h, { key: "F11", code: "F11", keyCode: 122 });
        const after = await treeVisible(h);
        const winAfter = await h.ev(
            `JSON.stringify({fullscreenEl: !!document.fullscreenElement, w: window.innerWidth, h: window.innerHeight})`
        );
        steps.push({
            step: "1. F11 toggles terminal fullscreen and is consumed (no F11 to the PTY)",
            ok: ctx.focused === true && seen.length === 0 && after !== before,
            detail: `focused=${ctx.focused}, treeVisible ${before} -> ${after}, probe saw ${JSON.stringify(seen)}`,
        });
        // the specific worry about F11: that WebView2 answers it with its own fullscreen, the way an
        // unclaimed Ctrl+P once reached it and raised a print dialog (ccc90133)
        steps.push({
            step: "2. no WebView2 fullscreen default fired (viewport unchanged)",
            ok: winBefore === winAfter,
            detail: `${winBefore} -> ${winAfter}`,
        });
        await h.shot("cdp-shots/tui-fullscreen.png");
        await pressKey(h, { key: "F11", code: "F11", keyCode: 122 });
        const restored = await treeVisible(h);
        steps.push({
            step: "3. F11 again restores the split view",
            ok: restored === before,
            detail: `treeVisible=${restored}`,
        });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// --- element primitives: the terminal view and the icon/copy buttons -------------------------------
// Guards the Tailwind port of the element SCSS (iconbutton, copybutton, term). Besides the shots it writes
// the computed style of every ported element, in each state it can reach, to element-primitives-styles.json:
// diffing that file between two trees is the look-did-not-change check, which a screenshot is too coarse for.
const PRIMITIVES_PROJECT = "verify-element-primitives";
const PRIMITIVES_TOPIC = "verify-primitives";
const PRIMITIVES_STYLES = "cdp-shots/element-primitives-styles.json";
const PRIMITIVES_WAIT_MS = 10000;
const PRIMITIVES_HOVER_MARK = "data-verify-hover";
const PRIMITIVE_PROPS = [
    "display", "position", "flex-direction", "flex-grow", "flex-shrink", "flex-basis", "align-items",
    "justify-content", "column-gap", "row-gap", "width", "height", "min-width", "max-width", "min-height",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "border-top-width", "border-top-style", "border-top-color", "border-left-width", "border-left-style",
    "border-top-left-radius", "background-color", "background-image", "color", "opacity", "cursor",
    "pointer-events", "visibility", "font-size", "font-family", "font-weight", "line-height", "outline-style",
    "outline-width", "outline-color", "box-shadow", "overflow-x", "overflow-y", "z-index",
];

// an in-page expression: the computed style and box of the element `sel` (a JS expression) names
const primitiveStyle = (sel) => `(() => {
    const el = ${sel};
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const out = { box: [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10] };
    for (const p of ${JSON.stringify(PRIMITIVE_PROPS)}) out[p] = cs.getPropertyValue(p);
    return out;
})()`;

// :hover forced through the CSS domain: a synthetic mouse move did not set it in the dev app's WebView
async function primitiveForceHover(h, sel, on) {
    await h.ev(`(() => {
        document.querySelectorAll('[${PRIMITIVES_HOVER_MARK}]').forEach((e) => e.removeAttribute('${PRIMITIVES_HOVER_MARK}'));
        ${sel}?.setAttribute('${PRIMITIVES_HOVER_MARK}', '');
    })()`);
    await h.cdp("DOM.enable", {});
    await h.cdp("CSS.enable", {});
    const { root } = await h.cdp("DOM.getDocument", { depth: 0 });
    const { nodeId } = await h.cdp("DOM.querySelector", { nodeId: root.nodeId, selector: `[${PRIMITIVES_HOVER_MARK}]` });
    if (!nodeId) return false;
    await h.cdp("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: on ? ["hover"] : [] });
    return true;
}

export const elementPrimitives = {
    name: "element-primitives",
    surface: "agent",
    async arrange(h) {
        const ctx = { name: PRIMITIVES_PROJECT };
        try {
            ctx.dir = mkdtempSync(join(tmpdir(), "verify-primitives-"));
            git(ctx.dir, "init", "-q", "--initial-branch=main");
            writeFileSync(join(ctx.dir, "README.md"), "# Primitives\n\nA paragraph.\n\n```sh\necho hello\n```\n");
            git(ctx.dir, "add", ".");
            git(ctx.dir, "commit", "-q", "-m", "seed the primitives fixture");
            await h.rpc("createproject", { name: ctx.name, path: ctx.dir });
            ctx.madeProject = true;
            await waitForProjectInConfig(h, ctx.name);
            await openCanvasTerminal(h, ctx, PRIMITIVES_TOPIC);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.arrangeError != null) {
            return [skipStep("element primitives", `could not verify: the arrange failed: ${ctx.arrangeError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const styles = {};
        const take = async (key, sel) => (styles[key] = await h.ev(primitiveStyle(sel)));
        try {
            await primitiveSteps(h, ctx, rec, styles, take);
        } finally {
            mkdirSync(dirname(PRIMITIVES_STYLES), { recursive: true });
            writeFileSync(PRIMITIVES_STYLES, JSON.stringify(styles, null, 2) + "\n");
        }
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`element-primitives teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        if (ctx.tabId) {
            await step("close the terminal tab", () =>
                waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false])
            );
        }
        if (ctx.madeProject) await step("delete the project", () => h.rpc("deleteproject", { name: ctx.name }));
        if (ctx.dir) await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true, maxRetries: 3 }));
        await step("go home", () => h.goto("cockpit"));
    },
};

async function primitiveSteps(h, ctx, rec, styles, take) {
    const TERM = `document.querySelector('[data-agent-terminal="${ctx.tabId}"] [data-term-view]')`;
    await h.goto("agent");
    await polishWaitFor(h, `!!document.querySelector('[data-tree-terminal="${ctx.tabId}"]')`, PRIMITIVES_WAIT_MS);
    await h.ev(`document.querySelector('[data-tree-terminal="${ctx.tabId}"]')?.click()`);
    const mounted = await polishWaitFor(h, `!!${TERM}?.querySelector('.xterm-viewport')`, PRIMITIVES_WAIT_MS);
    rec("a. the shell terminal mounts its view on the Agent surface", mounted, `tab=${ctx.tabId}`);
    if (!mounted) return;
    // the shell prints its banner a moment after the mount; the shot should show text in the viewport
    await polishWaitFor(h, `(${TERM}.querySelector('.xterm-rows')?.textContent ?? '').trim() !== ''`, PRIMITIVES_WAIT_MS);
    await take("term.root", TERM);
    await take("term.connect", `${TERM}.querySelector('.terminal')?.parentElement`);
    await take("term.terminal", `${TERM}.querySelector('.terminal')`);
    await take("term.viewport", `${TERM}.querySelector('.xterm-viewport')`);
    await take("term.ruler", `${TERM}.querySelector('.xterm-decoration-overview-ruler')`);
    rec(
        "b. the terminal fills its view, its viewport is transparent and the overview ruler is hidden",
        styles["term.root"]?.display === "flex" &&
            styles["term.terminal"]?.width === styles["term.connect"]?.width &&
            styles["term.viewport"]?.["background-color"] === "rgba(0, 0, 0, 0)" &&
            (styles["term.ruler"] == null || styles["term.ruler"].display === "none"),
        JSON.stringify({
            root: styles["term.root"]?.box,
            viewportBg: styles["term.viewport"]?.["background-color"],
            ruler: styles["term.ruler"]?.display ?? "absent",
        })
    );
    await h.shot("cdp-shots/element-primitives-terminal.png");

    // a markdown code block in the Code preview carries the copy button, an IconButton
    await h.goto("code");
    const row = `document.querySelector('[data-code-picker-row=${JSON.stringify(ctx.name)}]')`;
    if (!(await h.ev(`!!${row}`))) await h.ev(`document.querySelector('[data-code-project-picker]')?.click()`);
    const picked = (await polishWaitFor(h, `!!${row}`, 5000)) && (await h.ev(`(() => { ${row}.click(); return true; })()`));
    await polishNap(1200); // the index is one git ls-files call
    await h.ev(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true }))`
    );
    await polishNap(300);
    const typed = await setFinderQuery(h, "README.md");
    const CODEBLOCK = `document.querySelector('.markdown pre.codeblock')`;
    const COPY = `${CODEBLOCK}?.querySelector('button[title="Copy"]')`;
    const block = await polishWaitFor(h, `!!${COPY}`, PRIMITIVES_WAIT_MS);
    const seen = block
        ? null
        : await h.ev(`({ markdown: !!document.querySelector('.markdown'), pre: document.querySelectorAll('pre').length,
            heading: document.querySelector('.markdown .heading')?.textContent ?? null })`);
    rec(
        "c. README.md renders a code block with a copy button",
        picked === true && block,
        JSON.stringify({ picked, typed, seen })
    );
    if (!block) {
        await h.shot("cdp-shots/element-primitives-nocodeblock.png");
        return;
    }
    await take("copy.button", COPY);
    await take("copy.icon", `${COPY}?.querySelector('i')`);
    const hovered = await primitiveForceHover(h, COPY, true);
    await take("copy.button.hover", COPY);
    await primitiveForceHover(h, COPY, false);
    rec(
        "d. the copy button rests dim and hover lifts it to full opacity",
        hovered && styles["copy.button"]?.opacity === "0.7" && styles["copy.button.hover"]?.opacity === "1",
        JSON.stringify({ rest: styles["copy.button"]?.opacity, hover: styles["copy.button.hover"]?.opacity })
    );
    // the actions strip shows on the block's hover; force it so the shot shows the button
    await primitiveForceHover(h, CODEBLOCK, true);
    await h.shot("cdp-shots/element-primitives-copy.png");
    await h.ev(`${COPY}?.click()`);
    const copied = await polishWaitFor(h, `!!${COPY}?.querySelector('i.fa-check')`, 1500);
    await take("copy.button.copied", COPY);
    await take("copy.icon.copied", `${COPY}?.querySelector('i')`);
    const success = await h.ev(`(() => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--color-success)';
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
    })()`);
    rec(
        "e. clicking copy shows the check in the success color at full opacity",
        copied && styles["copy.button.copied"]?.opacity === "1" && styles["copy.icon.copied"]?.color === success,
        JSON.stringify({ copied, color: styles["copy.icon.copied"]?.color, success })
    );
    await h.shot("cdp-shots/element-primitives-copied.png");
    await primitiveForceHover(h, CODEBLOCK, false);
}
// the text glyphs the polish replaced with lucide icons
const TREE_RAIL_GLYPHS = ["↳", "◆", "▸", "▾", "›_", "↗", "‹"];

const TREE_RAIL_SUBAGENT_PROMPT = "survey the tree rail";

// a parent transcript with one subagent file whose last record is not an assistant turn, so it reads as working
function writeLeadTranscript(cwd) {
    const parent = join(cwd, "lead.jsonl");
    const subs = join(cwd, "lead", "subagents");
    mkdirSync(subs, { recursive: true });
    const userTurn = (content) => JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    writeFileSync(parent, userTurn("verify tree rail"));
    writeFileSync(join(subs, "agent-fxsub.jsonl"), userTurn(TREE_RAIL_SUBAGENT_PROMPT));
    return parent;
}

async function arrangeTreeRail(h, ctx) {
    await arrangeFixtureRun(h, ctx, "tree-rail", TREE_RAIL_LEAD, { transcriptPath: writeLeadTranscript(ctx.cwd) });
    await h.rpc("dagsubmit", {
        channelid: ctx.channelId,
        runid: ctx.runId,
        title: "verify tree-rail",
        parallelism: 1,
        tasks: RUN_SHEET_POLISH_TASKS,
    });
    // a queued task folds away, so t-1 has a worker row only once it dispatches
    await waitForDispatch(h, ctx, "t-1");
    // the rail is off by default and persisted, and the fixture roster is read once at boot
    await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
    await h.ev("location.reload()");
    await h.ev(`(async () => {
        for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
            await new Promise((r) => setTimeout(r, 500));
        }
    })()`);
    await h.goto("agent");
    // the lead row nests once its run loads, which is when its mark turns from a dot into the Workflow icon
    ctx.leadFocused = await h.ev(`(async () => {
        const leadRow = () => {
            const tree = document.querySelector("[data-agent-tree]");
            const name = tree && [...tree.querySelectorAll("div")].find(
                (d) => d.textContent.trim() === ${JSON.stringify(TREE_RAIL_LEAD)} && d.children.length === 0
            );
            return name ? name.closest(".cursor-pointer") : null;
        };
        for (let i = 0; i < 40; i++) {
            const row = leadRow();
            if (row && row.firstElementChild?.firstElementChild?.tagName.toLowerCase() === "svg") {
                row.click();
                return true;
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        return false;
    })()`);
    // let the rail's width slide and the run section settle before the shot
    await new Promise((r) => setTimeout(r, 1200));
}

export const agentTreeRail = {
    name: "agent-tree-rail",
    surface: "agent",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-tree-rail-"));
        const ctx = { cwd, prevRail: await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await arrangeTreeRail(h, ctx);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
        const TREE = `document.querySelector("[data-agent-tree]")`;
        const HEADER = `document.querySelector("[data-agent-header]")`;
        rec(
            "0. the lead row nested under its run and was focused, and t-1 dispatched",
            ctx.arrangeError == null && ctx.leadFocused === true && ctx.dispatched === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, dispatched: ctx.dispatched, dispatchMs: ctx.dispatchMs })
        );

        const badges = await h.ev(`(() => {
            const tree = ${TREE};
            if (!tree) return null;
            return [...tree.querySelectorAll("span")]
                .map((s) => s.textContent.trim())
                .filter((t) => /^\\d+ asking$/.test(t));
        })()`);
        rec(
            "1. each live project's group carries an asking badge",
            Array.isArray(badges) && badges.filter((t) => t === "1 asking").length === 2,
            `badges=${JSON.stringify(badges)}`
        );

        const glyphs = await h.ev(`(() => {
            const glyphs = ${JSON.stringify(TREE_RAIL_GLYPHS)};
            const hits = [];
            for (const root of [${TREE}, ${RAIL}, ${HEADER}]) {
                if (!root) continue;
                const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                    if (glyphs.some((g) => n.data.includes(g))) hits.push(n.data.trim());
                }
            }
            return { tree: !!${TREE}, rail: !!${RAIL}, header: !!${HEADER}, hits };
        })()`);
        rec(
            "2. no text glyph survives in the tree, the rail or the focused lead's header",
            glyphs.tree && glyphs.rail && glyphs.header && glyphs.hits.length === 0,
            JSON.stringify(glyphs)
        );

        const mark = await h.ev(`(() => {
            const tree = ${TREE};
            const name = tree && [...tree.querySelectorAll("div")].find(
                (d) => d.textContent.trim() === ${JSON.stringify(TREE_RAIL_LEAD)} && d.children.length === 0
            );
            const row = name && name.closest(".cursor-pointer");
            const slot = row && row.firstElementChild;
            const first = slot && slot.firstElementChild;
            return {
                tag: first ? first.tagName.toLowerCase() : null,
                slotWidth: slot ? getComputedStyle(slot).width : null,
            };
        })()`);
        rec(
            "3. the lead row's mark is an svg in the 14px leading column",
            mark.tag === "svg" && mark.slotWidth === "14px",
            JSON.stringify(mark)
        );

        const labels = await h.ev(`(() => {
            const rail = ${RAIL};
            if (!rail) return null;
            const out = {};
            for (const h3 of rail.querySelectorAll("h3")) {
                const t = h3.textContent.trim();
                if (t === "Details" || t === "Run") {
                    const cs = getComputedStyle(h3);
                    out[t] = { size: cs.fontSize, weight: cs.fontWeight };
                }
            }
            return out;
        })()`);
        const onScale = (l) => l != null && l.size === `${MIN_FONT_PX}px` && l.weight === "700";
        rec(
            "4. the rail's Details and Run headings are 10.5px bold",
            labels != null && onScale(labels.Details) && onScale(labels.Run),
            JSON.stringify(labels)
        );

        steps.push(await floorStep(h, "5. no visible text in the tree or the rail is under 10.5px", TREE, RAIL));

        const collapse = await h.ev(`(() => {
            const b = ${RAIL}?.querySelector('[aria-label="Collapse panel"]');
            return b ? !!b.querySelector("svg") : null;
        })()`);
        rec("6. the rail's collapse control is an icon", collapse === true, `svg=${collapse}`);

        // the rows the sweeps above only cover when they render: a nested row's guide is a 1px line in its first column
        const nested = await h.ev(`(() => {
            const tree = ${TREE};
            if (!tree) return null;
            const rowOf = (text) => {
                const name = [...tree.querySelectorAll("div")].find(
                    (d) => d.textContent.trim() === text && d.children.length === 0
                );
                return name ? name.closest(".relative") : null;
            };
            const guides = (row) =>
                row ? [...row.children].filter((c) => c.tagName === "SPAN" && getComputedStyle(c).width === "1px").length : 0;
            const lead = rowOf(${JSON.stringify(TREE_RAIL_LEAD)});
            const worker = rowOf(${JSON.stringify(RUN_SHEET_POLISH_TASKS[0].label)});
            const sub = rowOf(${JSON.stringify(TREE_RAIL_SUBAGENT_PROMPT)});
            return {
                strip: lead?.querySelector("[role=img]")?.getAttribute("aria-label") ?? null,
                workersChip: lead?.querySelector('button[aria-label="Hide workers"]')?.textContent.trim() ?? null,
                progress: (() => {
                    const s = lead?.querySelector("span.truncate.text-muted");
                    return s ? { text: s.textContent.trim(), clipped: s.scrollWidth > s.clientWidth } : null;
                })(),
                worker: !!worker,
                workerGuides: guides(worker),
                sub: !!sub,
                subGuides: guides(sub),
            };
        })()`);
        rec(
            "7. the lead's run line carries its workers chip, unclipped progress and the task strip",
            nested != null &&
                /^\d+ of 3 tasks done/.test(nested.strip ?? "") &&
                /workers?$/.test(nested.workersChip ?? "") &&
                nested.progress != null &&
                !nested.progress.clipped,
            JSON.stringify(nested)
        );
        rec(
            "8. t-1's worker row sits under the lead with one guide line",
            nested != null && nested.worker && nested.workerGuides === 1,
            JSON.stringify(nested)
        );
        rec(
            "9. the lead's working subagent is listed under it with one guide line",
            nested != null && nested.sub && nested.subGuides === 1,
            JSON.stringify(nested)
        );
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "agent-tree-rail", {
            what: "restore the rail preference",
            fn: () =>
                h.ev(
                    ctx.prevRail == null
                        ? `localStorage.removeItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`
                        : `localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, ${JSON.stringify(ctx.prevRail)})`
                ),
        });
    },
};

// Leaving the Agent surface and coming straight back must not replay a slide on the tree. The switch commit that
// hides the surface (display:none) used to re-render the tree, so motion measured every layout="position" row at
// (0,0) and began tweening it there; back within ~400ms, the list visibly shrank into place. Needs a roster with
// at least two rows (live, or a cockpit fixture).
const QUICK_RETURN_DWELL_MS = 250;
const QUICK_RETURN_SAMPLE_MS = 600;

export const agentTreeQuickReturn = {
    name: "agent-tree-quick-return",
    surface: "agent",
    async arrange() {
        return {};
    },
    async assert(h) {
        const rows = await h.ev(`document.querySelectorAll("[data-agent-tree] .overflow-y-auto > div").length`);
        if (rows < 2) {
            return [
                skipStep(
                    "rows hold still on a quick return",
                    `${rows} tree rows; seed a roster (npm run cockpit:fixtures -- mixed)`
                ),
            ];
        }
        const r = await h.ev(`new Promise((resolve) => {
            const nav = (label) => [...document.querySelectorAll("nav button")]
                .find((x) => x.getAttribute("aria-label") === label || (x.textContent || "").trim() === label)
                .click();
            nav(${JSON.stringify(SURFACE_LABEL.code)});
            setTimeout(() => {
                nav(${JSON.stringify(SURFACE_LABEL.agent)});
                let max = 0;
                const t0 = performance.now();
                const tick = () => {
                    for (const el of document.querySelectorAll("[data-agent-tree] .overflow-y-auto > div")) {
                        const tf = getComputedStyle(el).transform;
                        if (tf && tf !== "none") {
                            const m = new DOMMatrix(tf);
                            max = Math.max(max, Math.abs(m.m41), Math.abs(m.m42));
                        }
                    }
                    if (performance.now() - t0 < ${QUICK_RETURN_SAMPLE_MS}) requestAnimationFrame(tick);
                    else resolve(Math.round(max * 10) / 10);
                };
                requestAnimationFrame(tick);
            }, ${QUICK_RETURN_DWELL_MS});
        })`);
        return [
            {
                step: `rows hold still on a return within ${QUICK_RETURN_DWELL_MS}ms`,
                ok: r < 1,
                detail: `${rows} rows; max row offset ${r}px over ${QUICK_RETURN_SAMPLE_MS}ms`,
            },
        ];
    },
    async teardown() {},
};

// --- agent-rail-file-link: a file clicked in the agent rail is the file the Diff surface opens on ----------
// Issue 8 (2026-08-03): the rail's file link switched to the Diff surface and landed on the scope's first changed
// file. A fixture agent whose transcript names a temp repo with three modified files; the third is clicked, so
// landing on the first reads as the defect. The link is claimed once: a later visit keeps the row picked there.
const RAIL_LINK_AGENT = "rail-link agent";
const RAIL_LINK_FILES = ["alpha.txt", "bravo.txt", "charlie.txt"];
const RAIL_LINK_RAIL = `document.querySelector('aside[aria-label="Agent details"]')`;
const RAIL_LINK_LIB = `
    const railFile = (name) =>
        [...(${RAIL_LINK_RAIL}?.querySelectorAll("button") ?? [])].find((b) => (b.textContent || "").includes(name));
    const diffRow = (name) => document.querySelector('[data-changed-file-row="' + name + '"]');
    const selectedRows = () =>
        [...document.querySelectorAll("[data-changed-file-row]")]
            .filter((r) => r.getAttribute("aria-current") === "true")
            .map((r) => r.getAttribute("data-changed-file-row"));
    const until = async (fn) => {
        for (let i = 0; i < 80 && !fn(); i++) {
            await new Promise((r) => setTimeout(r, 250));
        }
        return !!fn();
    };
`;

function writeRailLinkRepo(cwd) {
    const git = (...args) =>
        execFileSync("git", ["-C", cwd, "-c", "user.name=verify", "-c", "user.email=verify@example.invalid", "-c", "core.autocrlf=false", ...args]);
    git("init", "-q");
    for (const f of RAIL_LINK_FILES) writeFileSync(join(cwd, f), `${f} one\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    for (const f of RAIL_LINK_FILES) writeFileSync(join(cwd, f), `${f} one\n${f} two\n`);
    // outside the repo's file list: the transcript only names the working directory
    const transcript = join(cwd, ".git", "rail-link.jsonl");
    writeFileSync(
        transcript,
        JSON.stringify({ type: "user", cwd, message: { role: "user", content: "verify the rail file link" } }) + "\n"
    );
    return transcript;
}

export const agentRailFileLink = {
    name: "agent-rail-file-link",
    surface: "agent",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-rail-link-"));
        const ctx = { cwd, prevRail: await h.ev(`localStorage.getItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`) };
        try {
            const transcriptPath = writeRailLinkRepo(cwd);
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(
                TREE_RAIL_FIXTURE,
                JSON.stringify(
                    [
                        {
                            id: "fx-rail-link",
                            name: RAIL_LINK_AGENT,
                            project: "verify-rail-link",
                            task: "verify the rail file link",
                            state: "working",
                            agent: "claude",
                            model: "opus",
                            activeMs: 60_000,
                            blockId: "fx-blk-rail-link",
                            transcriptPath,
                        },
                    ],
                    null,
                    2
                )
            );
            ctx.wroteFixture = true;
            // the rail is off by default and persisted, and the fixture roster is read once at boot
            await h.ev(`localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, "true")`);
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            await h.goto("agent");
            ctx.railFiles = await h.ev(`(async () => {
                ${RAIL_LINK_LIB}
                const row = () => {
                    const tree = document.querySelector("[data-agent-tree]");
                    const name = tree && [...tree.querySelectorAll("div")].find(
                        (d) => d.textContent.trim() === ${JSON.stringify(RAIL_LINK_AGENT)} && d.children.length === 0
                    );
                    return name ? name.closest(".cursor-pointer") : null;
                };
                if (!(await until(row))) return { ok: false, why: "no agent row in the tree" };
                row().click();
                const names = ${JSON.stringify(RAIL_LINK_FILES)};
                const ok = await until(() => names.every((n) => railFile(n)));
                return { ok, why: (${RAIL_LINK_RAIL}?.innerText || "").replace(/\\s+/g, " ").trim().slice(-300) };
            })()`);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const [first, , third] = RAIL_LINK_FILES;
        rec(
            "0. the focused agent's rail lists its three modified files",
            ctx.arrangeError == null && ctx.railFiles?.ok === true,
            ctx.arrangeError ?? JSON.stringify(ctx.railFiles)
        );
        await h.shot("cdp-shots/agent-rail-file-link-rail.png");

        const landed = await h.ev(`(async () => {
            ${RAIL_LINK_LIB}
            const link = railFile(${JSON.stringify(third)});
            link?.click();
            const ok = !!link && (await until(() => selectedRows().length > 0));
            // the surface settles on the first file before a late claim could move it, so read after a beat
            await new Promise((r) => setTimeout(r, 1500));
            return { ok, clicked: !!link, selected: selectedRows(), rows: document.querySelectorAll("[data-changed-file-row]").length };
        })()`);
        await h.shot("cdp-shots/agent-rail-file-link-diff.png");
        rec(
            "1. clicking the third file opens the Diff surface on that file, not the first",
            landed.ok === true && landed.rows === RAIL_LINK_FILES.length && landed.selected.join() === third,
            JSON.stringify(landed)
        );

        await h.ev(`(async () => {
            ${RAIL_LINK_LIB}
            diffRow(${JSON.stringify(first)})?.click();
            await until(() => selectedRows().join() === ${JSON.stringify(first)});
        })()`);
        await h.goto("agent");
        await h.ev("new Promise((r) => setTimeout(r, 600))");
        await h.goto("files");
        const kept = await h.ev(`(async () => {
            ${RAIL_LINK_LIB}
            await until(() => selectedRows().length > 0);
            await new Promise((r) => setTimeout(r, 1500));
            return { selected: selectedRows() };
        })()`);
        rec(
            "2. the link is claimed once: coming back keeps the row picked on the surface",
            kept.selected.join() === first,
            JSON.stringify(kept)
        );
        return steps;
    },
    async teardown(h, ctx) {
        await teardownFixtureRun(h, ctx, "agent-rail-file-link", {
            what: "restore the rail's visibility",
            fn: () =>
                h.ev(
                    ctx.prevRail == null
                        ? `localStorage.removeItem(${JSON.stringify(RAIL_VISIBLE_KEY)})`
                        : `localStorage.setItem(${JSON.stringify(RAIL_VISIBLE_KEY)}, ${JSON.stringify(ctx.prevRail)})`
                ),
        });
    },
};
// --- canvas mode swaps with the terminal, which stays mounted ----------------------------------------
// final-verify boots a fresh store with no agents, so the scenario opens its own plain terminal tab the way
// launchAgent does (CreateTab, then the terminal meta) and reveals a temp canvas as that terminal's. CreateTab is
// a wavesrv service call, which the page cannot reach cross-origin, so Node makes it with the page's auth key.
// wavesrv serves the fixture board, so the pane shows it; the swap is under test, not the board.
const CANVAS_BOARD = "Main.dc.html";
const CANVAS_SWAP = `document.querySelector('[role="group"][aria-label="Show terminal or canvas"]')`;
const CANVAS_TREE_TAG = `[...document.querySelectorAll("[data-agent-tree] button[aria-pressed]")].find((b) => (b.textContent || "").trim().startsWith("canvas"))`;
// the poller ticks every 3s (CANVAS_POLL_MS), so one tick always lands inside this
const CANVAS_REMOVED_WAIT_MS = 5000;
const CANVAS_ROSTER_WAIT_MS = 10000;
const CANVAS_KEYS = { c: { key: "c", code: "KeyC", keyCode: 67 }, x: { key: "x", code: "KeyX", keyCode: 88 } };

const clickCanvasSwap = (h, label) =>
    h.ev(`(() => {
        const b = [...(${CANVAS_SWAP}?.querySelectorAll("button") ?? [])]
            .find((x) => (x.textContent || "").trim() === ${JSON.stringify(label)});
        if (!b) return false;
        b.click();
        return true;
    })()`);

export const canvasSwap = {
    name: "canvas-swap",
    surface: "agent",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-canvas-"));
        const project = join(cwd, ".superpowers", "design", CANVAS_TOPIC, "project");
        mkdirSync(project, { recursive: true });
        writeFileSync(
            join(project, "canvas.json"),
            JSON.stringify({ boards: { [CANVAS_BOARD]: { w: 1440 } }, order: [CANVAS_BOARD] })
        );
        writeFileSync(join(project, CANVAS_BOARD), "<!doctype html><title>verify canvas</title><p>verify canvas</p>");
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await openCanvasTerminal(h, ctx);
        } catch (e) {
            ctx.launchError = String(e?.message ?? e);
            return ctx;
        }
        await h.goto("agent");
        ctx.inRoster = await polishWaitFor(
            h,
            `!!document.querySelector('[data-agent-terminal="${ctx.tabId}"]')`,
            CANVAS_ROSTER_WAIT_MS
        );
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.launchError != null) {
            return [skipStep("canvas swap", `could not verify: the terminal launch failed: ${ctx.launchError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const TERM = `document.querySelector('[data-agent-terminal="${ctx.tabId}"]')`;
        rec("0. the launched terminal is in the roster", ctx.inRoster === true, `tab=${ctx.tabId}`);
        if (!ctx.inRoster) return steps;

        // tagged before any swap: a remount would drop the attribute with the node
        const tagged = await h.ev(`(() => {
            const t = ${TERM};
            t.setAttribute("data-verify-mark", "canvas-swap");
            const x = t.querySelector(".xterm");
            if (x) x.setAttribute("data-verify-mark", "canvas-swap");
            return { xterm: !!x };
        })()`);

        let revealError = null;
        try {
            await h.rpc(
                "uireveal",
                { address: `canvas:${CANVAS_TOPIC}`, callerblockid: ctx.blockId, callercwd: ctx.cwd },
                UI_ROUTE
            );
        } catch (e) {
            revealError = String(e?.message ?? e);
        }
        // an agent's reveal only attaches; the user opens the canvas from the row's tag
        const attached = await polishWaitFor(h, `!!${CANVAS_TREE_TAG}`, 3000);
        const paneAfterReveal = await h.ev(`!!${CANVAS_PANE}`);
        rec(
            "1. uireveal canvas:<topic> from the terminal attaches the canvas without switching to it",
            revealError == null && attached && !paneAfterReveal,
            `tag=${attached} pane=${paneAfterReveal} error=${revealError}`
        );
        await h.ev(`${CANVAS_TREE_TAG}?.click()`);
        const paneUp = await polishWaitFor(h, `!!${CANVAS_PANE}`, 3000);
        const swap = await h.ev(`(() => {
            const g = ${CANVAS_SWAP};
            return g ? [...g.querySelectorAll("button")].map((b) => (b.textContent || "").trim()) : null;
        })()`);
        const treeKept = await h.ev(`!!document.querySelector("[data-agent-tree]")`);
        rec("1b. the row's canvas tag shows the canvas pane in the terminal's place", paneUp, `pane=${paneUp}`);
        rec("2. canvas mode keeps the agent tree", treeKept === true, `treeKept=${treeKept}`);
        rec(
            "3. the header swaps between Terminal and Canvas",
            JSON.stringify(swap) === JSON.stringify(["Terminal", "Canvas"]),
            `buttons=${JSON.stringify(swap)}`
        );
        await h.shot("cdp-shots/canvas-swap-canvas.png");

        // a real click puts the page in focus, which CDP key events need to reach it at all
        const box = await h.ev(`(() => {
            const r = ${CANVAS_PANE}?.querySelector("span")?.getBoundingClientRect();
            return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
        })()`);
        if (box) {
            for (const type of ["mousePressed", "mouseReleased"]) {
                await h.cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
            }
        }
        // x is bound nowhere, so the probe seeing it proves key events arrive: a c that then does nothing is a
        // real failure, not an undelivered key
        await h.ev(`(() => {
            window.__canvasSeen = [];
            window.__canvasProbe = (e) => window.__canvasSeen.push(e.key);
            window.addEventListener("keydown", window.__canvasProbe, true);
            return true;
        })()`);
        await pressCanvasKey(h, CANVAS_KEYS.x);
        const delivered = await h.ev(`window.__canvasSeen.includes("x")`);
        await h.ev(`window.removeEventListener("keydown", window.__canvasProbe, true)`);

        const toTerminal = delivered ? await pressCanvasKey(h, CANVAS_KEYS.c) : await clickCanvasSwap(h, "Terminal");
        await polishNap(300);
        const back = await h.ev(`(() => {
            const t = ${TERM};
            const x = t?.querySelector(".xterm");
            return {
                pane: !!${CANVAS_PANE},
                visible: !!t && !t.classList.contains("hidden"),
                sameNode: t?.getAttribute("data-verify-mark") === "canvas-swap",
                sameXterm: x == null ? null : x.getAttribute("data-verify-mark") === "canvas-swap",
            };
        })()`);
        const keyed = delivered ? "c" : "the Terminal button (CDP keys did not reach the page)";
        rec(
            `4. ${keyed} returns to the terminal`,
            toTerminal !== false && !back.pane && back.visible,
            JSON.stringify({ delivered, ...back })
        );
        rec(
            "5. the terminal was hidden, not remounted",
            back.sameNode && (tagged.xterm ? back.sameXterm === true : true),
            JSON.stringify({ taggedXterm: tagged.xterm, sameNode: back.sameNode, sameXterm: back.sameXterm })
        );
        const tag = await h.ev(`!!${CANVAS_TREE_TAG}`);
        rec("6. the agent tree tags the terminal's row canvas", tag === true, `tag=${tag}`);
        if (!delivered) {
            steps.push(skipStep("4b. the c key itself", "CDP key events never reached the page; drove the header instead"));
        }

        // back in the terminal the xterm holds focus and would take the c; leave it the way Esc does
        await h.ev(`(() => {
            document.activeElement?.blur?.();
            document.querySelector("[data-cockpit-surface-wrap]")?.focus();
            return true;
        })()`);
        if (delivered) await pressCanvasKey(h, CANVAS_KEYS.c);
        else await clickCanvasSwap(h, "Canvas");
        const again = await polishWaitFor(h, `!!${CANVAS_PANE}`, 2000);
        rec(`7. ${delivered ? "c" : "the Canvas button"} brings the canvas back`, again, `pane=${again}`);

        rmSync(join(ctx.cwd, ".superpowers", "design", CANVAS_TOPIC), { recursive: true, force: true });
        const removed = await polishWaitFor(
            h,
            `(${CANVAS_PANE}?.textContent || "").includes(${JSON.stringify(`${CANVAS_TOPIC} was removed`)})`,
            CANVAS_REMOVED_WAIT_MS
        );
        rec("8. deleting the canvas folder shows the removed state", removed, `removed=${removed}`);
        await h.shot("cdp-shots/canvas-swap-removed.png");
        return steps;
    },
    // best-effort, so one failed step does not strand the rest
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`canvas-swap teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("leave the canvas", () =>
            h.ev(`(() => {
                const b = [...(${CANVAS_PANE}?.querySelectorAll("button") ?? [])]
                    .find((x) => (x.textContent || "").trim() === "Back to terminal");
                if (b) b.click();
                return true;
            })()`)
        );
        if (ctx.tabId) {
            await step("close the terminal tab", () =>
                waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false])
            );
        }
        await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};

// --- canvas mark: a box drawn on the board opens the review's note card under it, Esc drops the mark, and Enter
// sends it at once: a feedback picture without the card, one line handed to the agent, and back to the terminal --
const CANVAS_MARK_NOTE = `document.querySelector("[data-canvas-mark-note]")`;
const CANVAS_MARK_BOX = `document.querySelector("[data-canvas-mark]")`;
const CANVAS_MARK_TEXT = "make it wider";
const CANVAS_MARK_SEND_WAIT_MS = 8000;
const CANVAS_MARK_ENTER = { key: "Enter", code: "Enter", keyCode: 13 };
const CANVAS_MARK_ESC = { key: "Escape", code: "Escape", keyCode: 27 };

const pressMarkKey = async (h, { key, code, keyCode }) => {
    const text = key === "Enter" ? "\r" : undefined;
    await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, text, windowsVirtualKeyCode: keyCode });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    await polishNap(400);
};

// a real drag over the board, in window coordinates, from 15%/15% to 45%/40% of its visible rect
async function dragMarkBox(h) {
    const r = await h.ev(`(() => {
        const b = document.querySelector("[data-canvas-board]")?.getBoundingClientRect();
        return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
    })()`);
    if (r == null) return false;
    const at = (fx, fy) => ({ x: Math.round(r.x + r.w * fx), y: Math.round(r.y + r.h * fy) });
    const [a, b] = [at(0.15, 0.15), at(0.45, 0.4)];
    await h.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...a, button: "left", buttons: 1, clickCount: 1 });
    for (const t of [0.33, 0.66, 1]) {
        const p = { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) };
        await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...p, button: "left", buttons: 1 });
    }
    await h.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...b, button: "left", buttons: 0, clickCount: 1 });
    await polishNap(300);
    return true;
}

export const canvasMark = {
    name: "canvas-mark",
    surface: "agent",
    arrange: canvasSwap.arrange,
    async assert(h, ctx) {
        if (ctx.launchError != null) {
            return [skipStep("canvas mark", `could not verify: the terminal launch failed: ${ctx.launchError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec("0. the launched terminal is in the roster", ctx.inRoster === true, `tab=${ctx.tabId}`);
        if (!ctx.inRoster) return steps;

        await h.rpc(
            "uireveal",
            { address: `canvas:${CANVAS_TOPIC}`, callerblockid: ctx.blockId, callercwd: ctx.cwd },
            UI_ROUTE
        );
        await polishWaitFor(h, `!!${CANVAS_TREE_TAG}`, 3000);
        await h.ev(`${CANVAS_TREE_TAG}?.click()`);
        const board = await polishWaitFor(h, `!!document.querySelector("[data-canvas-board] iframe")`, 5000);
        await h.ev(`[...(${CANVAS_PANE}?.querySelectorAll("button") ?? [])]
            .find((b) => (b.textContent || "").trim() === "Mark")?.click()`);
        const hint = await polishWaitFor(
            h,
            `(${CANVAS_PANE}?.textContent || "").includes("Drag a box around what you want changed")`,
            2000
        );
        rec("1. Mark puts the board in mark mode", board && hint, `board=${board} hint=${hint}`);

        // Esc in the card drops the mark and leaves mark mode on
        await dragMarkBox(h);
        const first = await polishWaitFor(h, `!!${CANVAS_MARK_NOTE}`, 2000);
        await pressMarkKey(h, CANVAS_MARK_ESC);
        const dropped = await h.ev(`({ note: !!${CANVAS_MARK_NOTE}, box: !!${CANVAS_MARK_BOX},
            hint: (${CANVAS_PANE}?.textContent || "").includes("Drag a box around") })`);
        rec(
            "2. Esc in the note card drops the mark and keeps marking",
            first && !dropped.note && !dropped.box && dropped.hint,
            JSON.stringify({ first, ...dropped })
        );

        await dragMarkBox(h);
        await polishWaitFor(h, `!!${CANVAS_MARK_NOTE}`, 2000);
        const card = await h.ev(`(() => {
            const n = ${CANVAS_MARK_NOTE}?.getBoundingClientRect();
            const m = ${CANVAS_MARK_BOX}?.getBoundingClientRect();
            const input = ${CANVAS_MARK_NOTE}?.querySelector("input");
            const send = [...(${CANVAS_MARK_NOTE}?.querySelectorAll("button") ?? [])].map((b) => (b.textContent || "").trim());
            return n && m ? {
                below: Math.round(n.top) >= Math.round(m.bottom),
                nearLeft: Math.abs(n.left - m.left) < 2,
                focused: document.activeElement === input,
                buttons: send,
            } : null;
        })()`);
        rec(
            "3. a drawn box opens the note card under it, its input focused, with Cancel Esc and Send Enter",
            card != null && card.below && card.nearLeft && card.focused &&
                card.buttons.some((t) => t.startsWith("Cancel")) && card.buttons.some((t) => t.startsWith("Send")),
            JSON.stringify(card)
        );
        await h.shot("cdp-shots/canvas-mark-note.png");

        await h.cdp("Input.insertText", { text: CANVAS_MARK_TEXT });
        await polishNap(200);
        // what the send hands the agent is read off its rpc calls: the prompt, and anything typed into the pty
        await h.ev(`(() => {
            const c = window.TabRpcClient;
            window.__markSent = [];
            window.__markRpc = c.wshRpcCall;
            c.wshRpcCall = function (cmd, data, opts) {
                if (cmd === "agentprompt") window.__markSent.push({ cmd, block: data.blockid, text: data.text });
                if (cmd === "controllerinput") window.__markSent.push({ cmd, block: data.blockid, text: atob(data.inputdata64) });
                return window.__markRpc.call(this, cmd, data, opts);
            };
            return true;
        })()`);
        await pressMarkKey(h, CANVAS_MARK_ENTER);
        const back = await polishWaitFor(h, `!${CANVAS_PANE}`, CANVAS_MARK_SEND_WAIT_MS);
        const feedback = join(ctx.cwd, ".superpowers", "design", CANVAS_TOPIC, "feedback", "001.png");
        const saved = existsSync(feedback);
        if (saved) {
            writeFileSync("cdp-shots/canvas-mark-feedback.png", readFileSync(feedback));
        }
        const error = await h.ev(`${CANVAS_MARK_NOTE}?.textContent ?? null`);
        rec(
            "4. Enter sends at once: the picture is saved and the agent is back on its terminal",
            back && saved,
            JSON.stringify({ back, saved, card: error })
        );
        const sent = await h.ev(`(() => {
            window.TabRpcClient.wshRpcCall = window.__markRpc;
            return window.__markSent;
        })()`);
        const want = `look at .superpowers/design/${CANVAS_TOPIC}/feedback/001.png — mark on ${CANVAS_BOARD}: ${CANVAS_MARK_TEXT}`;
        // the terminal getting focus back reports it (ESC [I) through controllerinput, which is not the send
        const calls = (sent ?? []).filter((t) => !/^\x1b\[[IO]$/.test(t.text));
        rec(
            "5. one line naming the picture and the note goes to the agent as a prompt, not typed into its composer",
            calls.length === 1 && calls[0].cmd === "agentprompt" && calls[0].block === ctx.blockId && calls[0].text === want,
            JSON.stringify(sent)
        );
        await h.shot("cdp-shots/canvas-mark-sent.png");
        return steps;
    },
    teardown: canvasSwap.teardown,
};

// --- agent terminal names: two background terminals with one name read apart, and a header with no facts has no
// stray dash line -------------------------------------------------------------------------------------------
const TERM_NAMES_LABEL = "verify-terms";
const TERM_NAMES_WAIT_MS = 10000;

export const agentTerminalNames = {
    name: "agent-terminal-names",
    surface: "agent",
    async arrange(h) {
        const ctx = { tabIds: [] };
        try {
            const bootTab = String(await h.ev("window.TabRpcClient.routeId")).replace(/^tab:/, "");
            const wslist = await h.rpc("workspacelist", null);
            const ws = wslist.find((w) => (w.workspacedata?.tabids ?? []).includes(bootTab)) ?? wslist[0];
            ctx.workspaceId = ws.workspacedata.oid;
            for (let i = 0; i < 2; i++) {
                const tabId = await waveService(h, "workspace", "CreateTab", [ctx.workspaceId, TERM_NAMES_LABEL, false]);
                ctx.tabIds.push(tabId);
                const tab = await waveService(h, "object", "GetObject", [`tab:${tabId}`]);
                const blockId = tab?.blockids?.[0];
                if (!blockId) throw new Error("the new tab has no block");
                await h.rpc("setmeta", {
                    oref: `block:${blockId}`,
                    meta: { view: "term", controller: "shell", "cmd:cwd": "~" },
                });
            }
        } catch (e) {
            ctx.launchError = String(e?.message ?? e);
            return ctx;
        }
        await h.goto("agent");
        ctx.listed = await polishWaitFor(
            h,
            ctx.tabIds.map((id) => `!!document.querySelector('[data-tree-terminal="${id}"]')`).join(" && "),
            TERM_NAMES_WAIT_MS
        );
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.launchError != null) {
            return [skipStep("terminal names", `could not verify: the terminal launch failed: ${ctx.launchError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec("0. both terminals are in the tree", ctx.listed === true, `tabs=${ctx.tabIds.join(",")}`);
        if (!ctx.listed) return steps;

        const names = await h.ev(
            `${JSON.stringify(ctx.tabIds)}.map((id) => document.querySelector('[data-tree-terminal="' + id + '"]')?.textContent.trim() ?? null)`
        );
        rec(
            "1. same-named terminals read apart: the second is numbered",
            names[0] === TERM_NAMES_LABEL && names[1] === `${TERM_NAMES_LABEL} 2`,
            JSON.stringify(names)
        );

        await h.ev(`document.querySelector('[data-tree-terminal="${ctx.tabIds[1]}"]')?.click()`);
        const head = await polishWaitFor(
            h,
            `(document.querySelector("[data-agent-header]")?.textContent ?? "").includes(${JSON.stringify(`${TERM_NAMES_LABEL} 2`)})`,
            TERM_NAMES_WAIT_MS
        );
        const header = await h.ev(`document.querySelector("[data-agent-header]")?.textContent ?? ""`);
        rec("2. the header names the focused terminal with its number", head === true, header.slice(0, 80));
        // a terminal with no project, initiative or run has no facts for the header's second line
        rec("3. no stray dash in the header", !header.includes("—"), header.slice(0, 80));
        await polishNap(300); // the rows fade their selection over 140ms
        await h.shot("cdp-shots/agent-terminal-names.png");
        return steps;
    },
    async teardown(h, ctx) {
        for (const tabId of ctx.tabIds) {
            try {
                await waveService(h, "workspace", "CloseTab", [ctx.workspaceId, tabId, false]);
            } catch (e) {
                console.error(`agent-terminal-names teardown: closing ${tabId} failed: ${e?.message ?? e}`);
            }
        }
        await h.goto("cockpit");
    },
};

// --- canvas board tabs: each board on its own tab, and All lays them side by side -------------------------
// Unlike canvas-swap, the boards are under test: wavesrv serves them from the fixture's design folder.
const CANVAS_TABS_TOPIC = "verify-canvas-tabs";
const CANVAS_TABS = `document.querySelector('[role="tablist"][aria-label="Boards"]')`;

const canvasTabFrames = (h) =>
    h.ev(`(() => ({
        tabs: [...(${CANVAS_TABS}?.querySelectorAll('[role="tab"]') ?? [])].map((b) => (b.textContent || "").trim()),
        frames: [...document.querySelectorAll("[data-canvas-frame]")].map((f) => f.getAttribute("data-canvas-frame")),
    }))()`);

const clickCanvasTab = async (h, label) => {
    await h.ev(`[...(${CANVAS_TABS}?.querySelectorAll('[role="tab"]') ?? [])].find((b) => (b.textContent || "").trim() === ${JSON.stringify(label)})?.click()`);
    await polishNap(400);
    return canvasTabFrames(h);
};

export const canvasTabsScenario = {
    name: "canvas-tabs",
    surface: "agent",
    async arrange(h) {
        const cwd = mkdtempSync(join(tmpdir(), "verify-canvas-tabs-"));
        const project = join(cwd, ".superpowers", "design", CANVAS_TABS_TOPIC, "project");
        mkdirSync(project, { recursive: true });
        writeFileSync(
            join(project, "canvas.json"),
            JSON.stringify({
                boards: {
                    "Main.dc.html": { x: 0, y: 0, w: 640, h: 480, title: "A" },
                    "Cards.dc.html": { x: 720, y: 0, w: 640, h: 480, title: "B" },
                },
                order: ["Main.dc.html", "Cards.dc.html"],
            })
        );
        for (const name of ["Main", "Cards"]) {
            writeFileSync(join(project, `${name}.dc.html`), `<!doctype html><title>${name}</title><p>${name} board</p>`);
        }
        const ctx = { cwd };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await openCanvasTerminal(h, ctx);
        } catch (e) {
            ctx.launchError = String(e?.message ?? e);
            return ctx;
        }
        await h.goto("agent");
        ctx.inRoster = await polishWaitFor(
            h,
            `!!document.querySelector('[data-agent-terminal="${ctx.tabId}"]')`,
            CANVAS_ROSTER_WAIT_MS
        );
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.launchError != null) {
            return [skipStep("canvas tabs", `could not verify: ${ctx.launchError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec("0. the launched terminal is in the roster", ctx.inRoster === true, `tab=${ctx.tabId}`);
        if (!ctx.inRoster) return steps;

        await h.rpc(
            "uireveal",
            { address: `canvas:${CANVAS_TABS_TOPIC}`, callerblockid: ctx.blockId, callercwd: ctx.cwd },
            UI_ROUTE
        );
        await polishWaitFor(h, `!!${CANVAS_TREE_TAG}`, 3000);
        await h.ev(`${CANVAS_TREE_TAG}?.click()`);
        const loaded = await polishWaitFor(
            h,
            `(${CANVAS_TABS}?.querySelectorAll('[role="tab"]').length ?? 0) === 3`,
            CANVAS_TABS_WAIT_MS
        );
        const first = await canvasTabFrames(h);
        rec(
            "1. the header offers All and one tab per board, and opens on the first board alone",
            loaded && JSON.stringify(first.tabs) === JSON.stringify(["All", "Main", "Cards"]) &&
                JSON.stringify(first.frames) === JSON.stringify(["Main.dc.html"]),
            JSON.stringify({ loaded, ...first })
        );
        const all = await clickCanvasTab(h, "All");
        await h.shot("cdp-shots/canvas-tabs-all.png");
        rec(
            "2. All lays every board out side by side",
            JSON.stringify(all.frames) === JSON.stringify(["Main.dc.html", "Cards.dc.html"]),
            JSON.stringify(all)
        );
        const cards = await clickCanvasTab(h, "Cards");
        await h.shot("cdp-shots/canvas-tabs-cards.png");
        rec(
            "3. a board's tab shows that board alone",
            JSON.stringify(cards.frames) === JSON.stringify(["Cards.dc.html"]),
            JSON.stringify(cards)
        );
        return steps;
    },
    // best-effort, so one failed step does not strand the rest
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`canvas-tabs teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("leave the canvas", () => clickCanvasSwap(h, "Terminal"));
        if (ctx.tabId) {
            await step("close the terminal tab", () =>
                waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false])
            );
        }
        await step("remove the temp dir", () => rmSync(ctx.cwd, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};

// The Agent surface stays mounted, so its focus effects never re-run on a switch back: arriving left focus on
// <body> and typing reached the agent only after a click on its terminal.
const agentTerminalFocused = `(() => {
    const t = [...document.querySelectorAll('.xterm-helper-textarea')].find((x) => x.checkVisibility());
    if (!t) return { terminal: false, focused: false, active: document.activeElement?.tagName };
    return { terminal: true, focused: document.activeElement === t, active: document.activeElement?.tagName };
})()`;

export const agentTerminalOnArrival = {
    name: "agent-terminal-on-arrival",
    surface: "agent",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await h.goto("agent");
        if (!(await h.ev(agentTerminalFocused)).terminal) {
            return [skipStep("the Agent surface shows a live terminal", "no agent terminal: launch one agent first")];
        }

        await h.goto("cockpit");
        await h.goto("agent");
        const viaNav = await h.ev(agentTerminalFocused);
        steps.push({
            step: "Cockpit -> nav click Agent: the terminal has focus",
            ok: viaNav.focused === true,
            detail: `active=${viaNav.active}`,
        });

        await h.goto("cockpit");
        const opened = await openPalette(h);
        await h.ev(setInputExpr(PALETTE_INPUT, "agent"));
        await polishNap(300);
        // "New agent…" outranks the go-to row, so step down to the row that is the surface itself
        const goRow = await h.ev(
            `[...(${PALETTE}?.querySelectorAll('button[data-idx]') ?? [])].findIndex((b) => /^Agent\\s*ga$/.test((b.textContent || '').replace(/\\s+/g, '')))`
        );
        for (let i = 0; i < goRow; i++) {
            await h.ev(paletteKey("ArrowDown"));
        }
        const row = await h.ev(`(${PALETTE_STATE})?.selected ?? null`);
        await h.ev(paletteKey("Enter"));
        await polishWaitFor(h, `(${agentTerminalFocused}).terminal`, 3000);
        await polishNap(300);
        const viaPalette = await h.ev(agentTerminalFocused);
        steps.push({
            step: "Cockpit -> Ctrl+P 'agent' -> Enter: the terminal has focus",
            ok: opened === true && viaPalette.focused === true,
            detail: `row=${row} active=${viaPalette.active}`,
        });
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};

// The Resource Manager (footer readout + popover). Data comes only from window.__resmonFixture (resmonstore.ts),
// modelled on the canvas (.superpowers/design/resource-manager): a pinned snapshot is never overwritten by the
// live poll, and an armed outcome answers the next confirm without touching a process.
const RESMON_VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const RESMON_MIB = 1024 * 1024;
// the snapshot's totals: the canvas's 60.6% and 7.4 GiB
const RESMON_TOTAL_CPU = 60.6;
const RESMON_TOTAL_MEM = 7945689498;
const RESMON_FOOTER = `document.querySelector('[data-hints-footer]')`;
const RESMON_COCKPIT_HINTS = `document.querySelector('[data-cockpit-hints]')`;
const RESMON_POPOVER = `document.querySelector('[data-resmon-popover]')`;
// a run's workers and plan commands share one view, keyed by its run id
const RESMON_GROUP_ORDER = ["arc", "job:14820", "run:run-a", "run:run-b", "job:7716"];
// the popover grows in with a scale reveal; measure after it settles
const RESMON_REVEAL_MS = 500;
const RESMON_CURSOR_MAX_PRESSES = 40;
const resmonNap = (ms) => new Promise((r) => setTimeout(r, ms));

function resmonRows(now, rows) {
    return rows.map(([pid, depth, name, args, cpu, mb, extra]) => ({
        pid,
        depth,
        name,
        command: args ? `${name} ${args}` : name,
        createts: now - (extra?.ageMin ?? 5) * 60_000,
        cpu,
        mem: Math.round(mb * RESMON_MIB),
        mempct: 0,
        numthreads: 1,
        ...(extra?.tag ? { tag: extra.tag } : {}),
        ...(extra?.role ? { role: extra.role } : {}),
    }));
}

function resmonGroup(key, ownerkind, label, runtime, killable, rows, run) {
    return {
        key,
        ownerkind,
        ownerid: key,
        label,
        ...(run ? { runid: run.id, role: run.role } : {}),
        ...(runtime ? { runtime } : {}),
        killable,
        cpu: Math.round(rows.reduce((n, r) => n + r.cpu, 0) * 10) / 10,
        mem: rows.reduce((n, r) => n + r.mem, 0),
        rows,
    };
}

function resmonArcGroup(now) {
    const webview = (role) => ({ role, ageMin: 340 });
    return resmonGroup("arc", "arc", "Arc", "", false, resmonRows(now, [
        [2476, 0, "wave-tauri.exe", "", 0.1, 38, webview("Host")],
        [23360, 1, "msedgewebview2.exe", "", 0.4, 141, webview("WebView browser")],
        [20028, 2, "msedgewebview2.exe", "--type=renderer", 3.1, 337, webview("Renderer")],
        [24188, 2, "msedgewebview2.exe", "--type=gpu-process", 1.9, 298, webview("GPU")],
        [25364, 2, "msedgewebview2.exe", "--type=renderer", 0.2, 74, { role: "Renderer", ageMin: 62 }],
        [27348, 2, "msedgewebview2.exe", "--type=utility --utility-sub-type=network.mojom.NetworkService", 0.1, 43, webview("Network service")],
        [4040, 2, "msedgewebview2.exe", "--type=utility --utility-sub-type=storage.mojom.StorageService", 0.0, 20, webview("Storage service")],
        [1788, 2, "msedgewebview2.exe", "--type=crashpad-handler", 0.0, 13, webview("Crash handler")],
        [27152, 1, "wavesrv.x64.exe", "", 0.9, 219, webview("Backend")],
    ]));
}

function resmonFixture(now = Date.now()) {
    return {
        supported: true,
        ready: true,
        ts: now,
        cpu: RESMON_TOTAL_CPU,
        mem: RESMON_TOTAL_MEM,
        totalmem: 32 * 1024 * RESMON_MIB,
        busycpu: false,
        busymem: false,
        groups: [
            resmonArcGroup(now),
            resmonGroup("job:14820", "agenttab", "waveterm", "claude", true, resmonRows(now, [
                [14820, 0, "claude.exe", "--resume", 1.2, 486, { tag: "agent", ageMin: 42 }],
                [14832, 1, "conhost.exe", "", 0.0, 9, { tag: "console", ageMin: 42 }],
                [18240, 1, "bash.exe", "-c go test ./pkg/orchestrate/... -run TestLiveness", 0.0, 6, { ageMin: 2 }],
                [18244, 2, "go.exe", "test ./pkg/orchestrate/...", 0.6, 152, { ageMin: 2 }],
                [18311, 3, "orchestrate.test.exe", "-test.run TestLiveness", 28.9, 1904, { ageMin: 2 }],
                [9932, 1, "cmd.exe", "/c npm run dev", 0.0, 4, { ageMin: 38 }],
                [9958, 2, "node.exe", "vite --port 5174", 1.1, 846, { ageMin: 38 }],
            ])),
            resmonGroup("job:13060", "runworker", "cache-miss notice", "pi", true, resmonRows(now, [
                [13060, 0, "cmd.exe", "/c pi.cmd", 0.0, 4, { tag: "launcher", ageMin: 16 }],
                [13072, 1, "conhost.exe", "", 0.0, 8, { tag: "console", ageMin: 16 }],
                [13104, 1, "node.exe", "pi", 0.9, 274, { tag: "agent", ageMin: 16 }],
                [21876, 2, "bash.exe", "-c npx vitest run frontend/app/view/agents", 0.0, 6, { ageMin: 1 }],
                [21890, 3, "node.exe", "vitest run frontend/app/view/agents", 13.7, 802, { ageMin: 1 }],
            ]), { id: "run-a", role: "Task 2" }),
            // the run's lead, started first: its core is the launcher, claude, and the arc mod's wsh agentctl
            resmonGroup("job:17544", "runworker", "cache-miss notice", "claude", true, resmonRows(now, [
                [17544, 0, "pwsh.exe", '-c "claude --dangerously-skip-permissions"', 0.0, 93, { tag: "launcher", ageMin: 41 }],
                [1908, 1, "claude.exe", "--dangerously-skip-permissions", 0.1, 378, { tag: "agent", ageMin: 41 }],
                [25284, 2, "wsh.exe", "agentctl", 0.0, 15, { tag: "control", ageMin: 41 }],
                [29268, 3, "conhost.exe", "0x4", 0.0, 7, { tag: "console", ageMin: 41 }],
            ]), { id: "run-a", role: "Lead" }),
            resmonGroup("job:22410", "runcmd", "cleanup round", "", false, resmonRows(now, [
                [22410, 0, "bash.exe", "-c node scripts/verify.mjs ./pkg/orchestrate ./pkg/jarvis", 0.0, 6, { tag: "shell", ageMin: 4 }],
                [22418, 1, "node.exe", "scripts/verify.mjs", 0.3, 58, { ageMin: 4 }],
                [22502, 2, "go.exe", "test ./pkg/jarvis", 0.4, 140, { ageMin: 3 }],
                [22590, 3, "jarvis.test.exe", "-test.count=1", 6.7, 1200, { ageMin: 3 }],
            ]), { id: "run-b", role: "Verify" }),
            resmonGroup("job:7716", "agenttab", "obsidian-notes", "claude", true, resmonRows(now, [
                [7716, 0, "claude.exe", "", 0.1, 303, { tag: "agent", ageMin: 192 }],
                [7724, 1, "conhost.exe", "", 0.0, 9, { tag: "console", ageMin: 192 }],
            ])),
        ],
    };
}

const resmonSet = (h, snap) => h.ev(`window.__resmonFixture.set(${JSON.stringify(snap)})`);
const resmonArm = (h, outcome) => h.ev(`window.__resmonFixture.killOutcome(${JSON.stringify(outcome)})`);
const resmonClick = (expr) => `(() => { const el = ${expr}; if (!el) return false; el.click(); return true; })()`;
const resmonReadout = (scope) => `${scope}?.querySelector('[data-resmon-readout]')`;
// the readout's words as a reader sees them: the flex gaps between its spans carry no text
const resmonReadoutText = (scope) => `(() => {
    const r = ${resmonReadout(scope)};
    return r ? [...r.children].filter((c) => c.tagName === 'SPAN').map((c) => c.textContent.trim()).join(' ') : null;
})()`;
const resmonGroupButton = (key, text) =>
    `[...document.querySelectorAll('[data-resmon-popover] [data-resmon-group="${key}"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const resmonConfirmButton = (text) =>
    `[...document.querySelectorAll('[data-resmon-popover] [data-resmon-confirm] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const resmonRowKill = (pid) => `document.querySelector('[data-resmon-popover] [data-resmon-row="${pid}"] button')`;
const resmonChevron = (key) =>
    `document.querySelector('[data-resmon-popover] [data-resmon-group="${key}"] button[aria-expanded]')`;

const RESMON_KEYS = {
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    g: { key: "g", code: "KeyG", windowsVirtualKeyCode: 71, text: "g" },
    m: { key: "m", code: "KeyM", windowsVirtualKeyCode: 77, text: "m" },
    x: { key: "x", code: "KeyX", windowsVirtualKeyCode: 88, text: "x" },
    X: { key: "X", code: "KeyX", windowsVirtualKeyCode: 88, text: "X", shift: true },
};
const RESMON_SHIFT_MODIFIER = 8;

// Input.dispatchKeyEvent often never reaches a WebView without OS focus: probe once, then send every key the same
// way, falling back to a KeyboardEvent on window, where the keybinding dispatcher listens
async function resmonKeyPath(h) {
    await h.ev(`(() => {
        window.__resmonKeyProbe = false;
        const f = (e) => { if (e.key === 'F20') { window.__resmonKeyProbe = true; window.removeEventListener('keydown', f, true); } };
        window.addEventListener('keydown', f, true);
    })()`);
    await h.cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "F20", code: "F20", windowsVirtualKeyCode: 131 });
    await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "F20", code: "F20", windowsVirtualKeyCode: 131 });
    await resmonNap(150);
    return (await h.ev("window.__resmonKeyProbe === true")) ? "cdp" : "window";
}

async function resmonKey(h, ctx, name) {
    const { shift, text, ...k } = RESMON_KEYS[name];
    if (ctx.keyPath === "cdp") {
        const modifiers = shift ? RESMON_SHIFT_MODIFIER : 0;
        await h.cdp("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...k, text, modifiers });
        await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k, modifiers });
    } else {
        await h.ev(
            `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k.key)}, code: ${JSON.stringify(k.code)}, shiftKey: ${!!shift}, bubbles: true, cancelable: true }))`
        );
    }
    await resmonNap(200);
}

// keys must not land in a field: the Agent surface's terminal would take them
const resmonBlur = (h) => h.ev(`document.activeElement?.blur?.()`);

const RESMON_POPOVER_STATE = `(() => {
    const p = ${RESMON_POPOVER};
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const where = (el) =>
        el.getAttribute('data-resmon-row') ??
        (el.hasAttribute('data-resmon-member') ? 'm:' + el.getAttribute('data-resmon-member') : null) ??
        el.closest('[data-resmon-group]')?.getAttribute('data-resmon-group');
    const cursor = p.querySelector('[data-resmon-cursor]');
    const confirm = p.querySelector('[data-resmon-confirm]');
    return {
        width: Math.round(r.width),
        right: Math.round(window.innerWidth - r.right),
        bottom: r.bottom,
        groups: [...p.querySelectorAll('[data-resmon-group]')].map((g) => ({
            key: g.getAttribute('data-resmon-group'),
            header: g.querySelector('button[aria-expanded]')?.textContent.trim() ?? '',
            rows: g.querySelectorAll('[data-resmon-row]').length,
            kills: g.querySelectorAll('[data-resmon-row] button[aria-label^="Kill"]').length,
            buttons: g.querySelectorAll('button').length,
            members: [...g.querySelectorAll('[data-resmon-member]')].map((m) => ({
                role: m.querySelector('span.font-semibold')?.textContent.trim() ?? '',
                folded: m.querySelector('[data-resmon-folded]')?.textContent.trim() ?? '',
                foldedTitle: m.querySelector('[data-resmon-folded]')?.getAttribute('title') ?? '',
                killChildren: [...m.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Kill children'),
                readOnly: m.textContent.includes('read-only'),
                icon: m.querySelector('img')?.getAttribute('alt') ?? (m.querySelector('svg') ? 'svg' : ''),
            })),
        })),
        order: [...p.querySelectorAll('[data-resmon-group] > div:first-child, [data-resmon-member], [data-resmon-row]')].map(where),
        cursor: cursor ? where(cursor) : null,
        confirm: confirm ? (confirm.querySelector('span')?.textContent ?? '') : null,
        status: [...p.querySelectorAll('[role="status"]')].map((n) => n.textContent.trim()),
        alert: [...p.querySelectorAll('[role="alert"]')].map((n) => n.textContent.trim()),
        text: p.textContent,
    };
})()`;
const resmonPopover = (h) => h.ev(RESMON_POPOVER_STATE);

// walks the cursor with the arrows onto the row with that pid, or the header of the group with that key
async function resmonCursorTo(h, ctx, target) {
    for (let i = 0; i < RESMON_CURSOR_MAX_PRESSES; i++) {
        const s = await resmonPopover(h);
        if (s == null) return false;
        const at = s.cursor == null ? -1 : s.order.indexOf(s.cursor);
        const want = s.order.indexOf(String(target));
        if (want < 0) return false;
        if (at === want) return true;
        await resmonKey(h, ctx, want > at ? "ArrowDown" : "ArrowUp");
    }
    return false;
}

async function resmonArrange(h) {
    await h.cdp("Emulation.setDeviceMetricsOverride", RESMON_VIEWPORT);
    await h.goto("agent");
    const ready = await polishWaitFor(h, `!!window.__resmonFixture`, 10000);
    const keyPath = await resmonKeyPath(h);
    if (ready) {
        await resmonSet(h, resmonFixture());
        await resmonNap(300);
    }
    return { ready, keyPath };
}

// The Cockpit draws its hints bar, and so its readout, only over a roster: an empty store shows the empty state
// alone. The fixture roster is read once at boot, and the reload drops the pinned snapshot, so it is set again.
async function resmonSeedRoster(h, ctx) {
    if (existsSync(TREE_RAIL_FIXTURE)) return;
    mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
    writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(treeRailRoster(undefined, Date.now()), null, 2));
    ctx.wroteFixture = true;
    await h.ev("location.reload()");
    await polishWaitFor(h, `!!document.querySelector("nav button") && !!window.__resmonFixture`, 30000);
    await resmonSet(h, resmonFixture());
}

async function resmonTeardown(h, ctx) {
    await h.ev(`window.__resmonFixture?.clear()`).catch(() => {});
    if (ctx?.wroteFixture) {
        rmSync(TREE_RAIL_FIXTURE, { force: true });
        await h.ev("location.reload()");
        await polishWaitFor(h, `!!document.querySelector("nav button")`, 30000);
    }
    await h.goto("cockpit");
}

const RESMON_NO_HOOK = [{ step: "the dev fixture hook is on window", ok: false, detail: "no window.__resmonFixture" }];

export const resmonFooter = {
    name: "resmon-footer",
    surface: "agent",
    arrange: resmonArrange,
    async assert(h, ctx) {
        if (!ctx.ready) return RESMON_NO_HOOK;
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shot = (n) => h.shot(`cdp-shots/resmon-footer-${n}.png`);

        await resmonBlur(h);
        const rest = await h.ev(`(() => ({
            last: !!${RESMON_FOOTER}?.lastElementChild?.matches('[data-resmon-readout]'),
            text: ${resmonReadoutText(RESMON_FOOTER)},
        }))()`);
        await shot("1-rest");
        rec("1. Agent at rest: the readout ends the footer and reads Arc 61% CPU · 7.4 GB",
            rest.last && rest.text === "Arc 61% CPU · 7.4 GB", JSON.stringify(rest));

        await resmonKey(h, ctx, "g");
        const leader = await h.ev(`(() => {
            const f = ${RESMON_FOOTER};
            const spans = [...(f?.querySelectorAll('span') ?? [])].map((s) => s.textContent.trim());
            return { readout: !!${resmonReadout(RESMON_FOOTER)}, m: spans.includes('mResource Manager'), leader: spans.includes('g →') };
        })()`);
        await shot("2-leader");
        rec("2. g: the leader posture keeps the readout and lists m Resource Manager",
            leader.readout && leader.m && leader.leader, JSON.stringify(leader));

        await resmonKey(h, ctx, "m");
        await resmonNap(RESMON_REVEAL_MS);
        const opened = await h.ev(`!!${RESMON_POPOVER}`);
        await shot("3-gm-open");
        rec("3. m: the popover opens", opened, `popover=${opened}`);

        await resmonKey(h, ctx, "Escape");
        await resmonNap(RESMON_REVEAL_MS);
        const closed = await h.ev(`!${RESMON_POPOVER}`);
        await shot("4-esc-closed");
        rec("4. Esc: the popover closes", closed, `closed=${closed}`);

        const dim = await h.ev(`new Promise((resolve) => {
            const input = document.createElement('input');
            input.setAttribute('data-resmon-probe', '');
            document.body.appendChild(input);
            input.focus();
            setTimeout(() => {
                const chips = ${RESMON_FOOTER}?.querySelector('[data-footer-chips]');
                const readout = ${resmonReadout(RESMON_FOOTER)};
                resolve({ chips: chips ? getComputedStyle(chips).opacity : null, readout: readout ? getComputedStyle(readout).opacity : null });
            }, 300);
        })`);
        await shot("5-editable");
        await h.ev(`document.querySelector('[data-resmon-probe]')?.remove()`);
        rec("5. focus in a field: the chips dim to 0.6, the readout stays at 1",
            dim.chips === "0.6" && dim.readout === "1", JSON.stringify(dim));

        if (!existsSync(TREE_RAIL_FIXTURE)) {
            await h.goto("cockpit");
            await polishWaitFor(h, `!!${RESMON_COCKPIT_HINTS}`, 10000);
            const bare = await h.ev(`(() => {
                const bar = ${RESMON_COCKPIT_HINTS};
                return {
                    readout: !!${resmonReadout(RESMON_COCKPIT_HINTS)},
                    help: [...(bar?.querySelectorAll('button') ?? [])].some((b) => b.textContent.trim() === '?'),
                };
            })()`);
            await shot("5b-cockpit-empty");
            rec("5b. Cockpit with no roster: the hints bar shows the readout alone, no triage hints or ?",
                bare.readout && !bare.help, JSON.stringify(bare));
        }

        await resmonSeedRoster(h, ctx);
        await h.goto("cockpit");
        await polishWaitFor(h, `!!${RESMON_COCKPIT_HINTS}`, 10000);
        const cockpit = await h.ev(`(() => {
            const r = ${resmonReadout(RESMON_COCKPIT_HINTS)};
            return { readout: !!r, afterHelp: r?.previousElementSibling?.textContent.trim() === '?', footer: !!${RESMON_FOOTER} };
        })()`);
        await shot("6-cockpit");
        rec("6. Cockpit: the readout sits in the cockpit hints bar, after ?",
            cockpit.readout && cockpit.afterHelp && !cockpit.footer, JSON.stringify(cockpit));

        await resmonBlur(h);
        await resmonKey(h, ctx, "g");
        const cockpitLeader = await h.ev(`(() => ({
            leader: [...(${RESMON_FOOTER}?.querySelectorAll('span') ?? [])].some((s) => s.textContent.trim() === 'g →'),
            readouts: document.querySelectorAll('[data-resmon-readout]').length,
            inBar: !!${resmonReadout(RESMON_COCKPIT_HINTS)},
        }))()`);
        await shot("6a-cockpit-leader");
        rec("6a. Cockpit under the g leader: one readout, in the hints bar, and the footer's own yields",
            cockpitLeader.leader && cockpitLeader.readouts === 1 && cockpitLeader.inBar, JSON.stringify(cockpitLeader));
        await resmonKey(h, ctx, "Escape");

        await h.ev(resmonClick(resmonReadout(RESMON_COCKPIT_HINTS)));
        await resmonNap(RESMON_REVEAL_MS);
        const above = await h.ev(`(() => {
            const p = ${RESMON_POPOVER};
            const bar = ${RESMON_COCKPIT_HINTS};
            if (!p || !bar) return { open: !!p, bar: !!bar };
            return { open: true, bottom: p.getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top };
        })()`);
        await shot("6b-cockpit-open");
        rec("6b. Cockpit: clicking that readout opens the popover above the hints bar",
            above.open && above.bottom <= above.barTop, JSON.stringify(above));
        await resmonBlur(h);
        await resmonKey(h, ctx, "Escape");
        await resmonNap(RESMON_REVEAL_MS);

        await h.goto("agent");
        await resmonBlur(h);
        const busy = [
            ["7", { busycpu: true }, "high CPU"],
            ["8", { busymem: true }, "high memory"],
            ["9", { busycpu: true, busymem: true }, "high CPU and memory"],
        ];
        for (const [n, flags, words] of busy) {
            await resmonSet(h, { ...resmonFixture(), ...flags });
            await resmonNap(200);
            const text = await h.ev(resmonReadoutText(RESMON_FOOTER));
            await shot(`${n}-busy`);
            rec(`${n}. ${Object.keys(flags).join(" + ")}: the readout shows ${words}`,
                text === `Arc 61% CPU · 7.4 GB ${words}`, text);
        }

        await resmonSet(h, null);
        await resmonNap(200);
        const pending = await h.ev(resmonReadoutText(RESMON_FOOTER));
        await shot("10-pending");
        rec("10. pinned null: the readout shows Arc –", pending === "Arc –", pending);

        await resmonSet(h, { ...resmonFixture(), supported: false });
        await resmonNap(200);
        const footerGone = await h.ev(`!!${RESMON_FOOTER} && !${resmonReadout(RESMON_FOOTER)}`);
        await shot("11a-unsupported-agent");
        await h.goto("cockpit");
        await polishWaitFor(h, `!!${RESMON_COCKPIT_HINTS}`, 10000);
        const barGone = await h.ev(`!!${RESMON_COCKPIT_HINTS} && !${resmonReadout(RESMON_COCKPIT_HINTS)}`);
        await shot("11b-unsupported-cockpit");
        rec("11. supported: false: no readout in the footer or the cockpit hints bar",
            footerGone && barGone, `footer=${footerGone} cockpit=${barGone}`);
        return steps;
    },
    teardown: resmonTeardown,
};

// The one Resource Manager check that touches no fixture: a real runaway process in a real shell block, found by the
// backend's own sampler and killed from the popover. Node reads the pid's liveness from the OS, the only witness that
// does not go through the code under test.
const RESMON_LIVE_WAIT_MS = 30000;
const RESMON_LIVE_POLL_MS = 500;
const RESMON_LIVE_CMD = `node -e "for(;;){}"`;
// sent apart from the command: pwsh reads a burst ending in Enter as a paste and does not run it
const RESMON_LIVE_ENTER = String.fromCharCode(13);

async function resmonLiveRunaway(h, blockId) {
    const snap = await h.rpc("resmonsnapshot", {});
    const group = (snap?.groups ?? []).find((g) => g.ownerid === blockId);
    const row = (group?.rows ?? []).filter((r) => /^node/i.test(r.name ?? "")).sort((a, b) => b.cpu - a.cpu)[0];
    return row == null ? null : { group: group.key, pid: row.pid, cpu: row.cpu };
}

const pidAlive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

export const resmonLive = {
    name: "resmon-live",
    surface: "agent",
    async arrange(h) {
        await h.cdp("Emulation.setDeviceMetricsOverride", RESMON_VIEWPORT);
        const ctx = {};
        try {
            await openCanvasTerminal(h, ctx);
        } catch (e) {
            ctx.launchError = String(e?.message ?? e);
            return ctx;
        }
        await h.goto("agent");
        ctx.keyPath = await resmonKeyPath(h);
        return ctx;
    },
    async assert(h, ctx) {
        if (ctx.launchError != null) {
            return [skipStep("live kill", `could not verify: the terminal launch failed: ${ctx.launchError}`)];
        }
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shot = (n) => h.shot(`cdp-shots/resmon-live-${n}.png`);

        await resmonNap(RESMON_LIVE_WAIT_MS / 6);
        const type = (text) =>
            h.rpc("controllerinput", { blockid: ctx.blockId, inputdata64: Buffer.from(text).toString("base64") });
        await type(RESMON_LIVE_CMD);
        await resmonNap(RESMON_LIVE_POLL_MS);
        await type(RESMON_LIVE_ENTER);
        const deadline = Date.now() + RESMON_LIVE_WAIT_MS;
        let found = null;
        while (found == null && Date.now() < deadline) {
            await resmonNap(RESMON_LIVE_POLL_MS);
            found = await resmonLiveRunaway(h, ctx.blockId);
        }
        const seen = found ?? (await h.rpc("resmonsnapshot", {}))?.groups?.map((g) => ({
            key: g.key,
            ownerid: g.ownerid,
            rows: g.rows.map((r) => `${r.pid}:${r.name}`),
        }));
        rec("1. the sampler lists the runaway node under the shell block's group", found != null, JSON.stringify({ block: ctx.blockId, seen }));
        if (found == null) {
            await shot("0-not-found");
            return steps;
        }
        ctx.pid = found.pid;
        rec("2. the process is alive before the kill", pidAlive(found.pid), `pid=${found.pid}`);

        await resmonBlur(h);
        await h.ev(resmonClick(resmonReadout(RESMON_FOOTER)));
        // a group starts collapsed: its rows render only once it is expanded
        await polishWaitFor(h, `!!${resmonChevron(found.group)}`, 10000);
        await h.ev(`(() => {
            const c = ${resmonChevron(found.group)};
            if (c?.getAttribute("aria-expanded") === "false") c.click();
        })()`);
        await polishWaitFor(h, `!!document.querySelector('[data-resmon-row="${found.pid}"]')`, 10000);
        await shot("1-listed");
        // the shell's member line and its Kill children button, on the surface ramp rather than a white overlay
        const chips = await paintEval(h, `
            const line = document.querySelector('[data-resmon-popover] [data-resmon-member="${found.group}"]');
            const tags = [...(line?.querySelectorAll("button, [data-resmon-folded]") ?? [])];
            return tags.map((t) => ({ tag: t.textContent.trim(), bg: getComputedStyle(t).backgroundColor, raw: rawOverlay(getComputedStyle(t).backgroundColor) }));
        `);
        const floor = await floorStep(h, `2c. no visible text in the resource popover is under ${MIN_FONT_PX}px`, `document.querySelector("[data-resmon-popover]")`);
        rec("2b. the shell's member line has no raw white or black overlay background", chips.length > 0 && chips.every((c) => !c.raw), JSON.stringify(chips));
        steps.push(floor);
        const clicked = await h.ev(
            resmonClick(`document.querySelector('[data-resmon-row="${found.pid}"] button[aria-label^="Kill"]')`)
        );
        await resmonNap(300);
        const asked = await h.ev(`!!document.querySelector('[data-resmon-confirm]')`);
        await shot("2-confirm");
        rec("3. the row's x opens a confirm", clicked && asked, `clicked=${clicked} confirm=${asked}`);
        if (!asked) return steps;

        await h.ev(resmonClick(`document.querySelector('[data-resmon-confirm] button')`));
        await polishWaitFor(h, `!document.querySelector('[data-resmon-row="${found.pid}"]')`, 10000);
        await resmonNap(RESMON_LIVE_POLL_MS);
        const gone = !pidAlive(found.pid);
        await shot("3-killed");
        rec("4. confirming kills the process: the OS no longer has the pid", gone, `pid=${found.pid} alive=${!gone}`);
        const after = await h.ev(`!document.querySelector('[data-resmon-row="${found.pid}"]')`);
        rec("5. the popover no longer lists the row", after, `rowGone=${after}`);
        return steps;
    },
    async teardown(h, ctx) {
        await resmonKey(h, ctx, "Escape").catch(() => {});
        if (ctx.pid != null && pidAlive(ctx.pid)) {
            try {
                process.kill(ctx.pid);
            } catch {}
        }
        if (ctx.tabId) {
            await waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false]).catch((e) =>
                console.error(`resmon-live teardown: close the terminal tab failed: ${e?.message ?? e}`)
            );
        }
        await h.goto("cockpit");
    },
};

export const resmonMain = {
    name: "resmon-main",
    surface: "agent",
    arrange: resmonArrange,
    async assert(h, ctx) {
        if (!ctx.ready) return RESMON_NO_HOOK;
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shot = (n) => h.shot(`cdp-shots/resmon-main-${n}.png`);
        const arcRows = async () => (await resmonPopover(h))?.groups.find((g) => g.key === "arc")?.rows;

        await h.ev(resmonClick(resmonReadout(RESMON_FOOTER)));
        await resmonNap(RESMON_REVEAL_MS);
        const s1 = await resmonPopover(h);
        const readoutTop = await h.ev(`${resmonReadout(RESMON_FOOTER)}?.getBoundingClientRect().top`);
        await shot("1-open");
        const ok1 =
            s1 != null &&
            s1.width === 700 &&
            Math.abs(s1.right - 12) <= 1 &&
            s1.bottom <= readoutTop - 5 &&
            JSON.stringify(s1.groups.map((g) => g.key)) === JSON.stringify(RESMON_GROUP_ORDER) &&
            s1.groups.every((g) => g.rows === 0 && g.members.length === 0) &&
            s1.text.includes("2 runs · 2 agent tabs · 31 processes") &&
            /cache-miss notice\s*Run · 2 agents · 9 processes/.test(s1.groups[2].header) &&
            /cleanup round\s*Run · 1 command · 4 processes/.test(s1.groups[3].header);
        rec("1. click the readout: 700px, bottom-right; Arc first, then by CPU, every view collapsed; one view per run, not per worker",
            ok1, JSON.stringify({ width: s1?.width, right: s1?.right, bottom: s1?.bottom, readoutTop, groups: s1?.groups }));

        const hot = resmonFixture();
        hot.groups.find((g) => g.key === "job:7716").cpu = 99;
        await resmonSet(h, hot);
        await resmonNap(200);
        const held = (await resmonPopover(h))?.groups.map((g) => g.key);
        await shot("1a-held-order");
        rec("1a. a refresh that ranks the last view first leaves the open popover's order alone",
            JSON.stringify(held) === JSON.stringify(RESMON_GROUP_ORDER), JSON.stringify(held));
        await resmonSet(h, resmonFixture());

        for (const k of RESMON_GROUP_ORDER.slice(1)) {
            await h.ev(resmonClick(resmonChevron(k)));
        }
        await resmonNap(200);
        const s1b = await resmonPopover(h);
        await shot("1b-runs-open");
        const by = (k) => s1b?.groups.find((g) => g.key === k) ?? { members: [] };
        const [lead, task2] = by("run:run-a").members;
        const [verifyCmd] = by("run:run-b").members;
        const [tab] = by("job:14820").members;
        const ok1b =
            by("run:run-a").members.map((m) => m.role).join(",") === "Lead,Task 2" &&
            lead.folded === "+3" && /wsh\.exe \(control\)/.test(lead.foldedTitle) && !lead.killChildren &&
            lead.icon === "Claude Code logo" &&
            task2.folded === "+2" && task2.killChildren && task2.icon === "Pi logo" &&
            by("run:run-a").rows === 2 && by("run:run-a").kills === 2 &&
            verifyCmd.role === "Verify" && verifyCmd.readOnly && !verifyCmd.killChildren && verifyCmd.icon === "svg" &&
            by("run:run-b").rows === 3 && by("run:run-b").kills === 0 &&
            tab.role === "Agent" && tab.folded === "+1" && tab.killChildren &&
            by("job:14820").rows === 5 && by("job:14820").kills === 5 &&
            by("job:7716").rows === 0 && !by("job:7716").members[0]?.killChildren;
        rec("1b. opened: a run lists its lead and workers by role, each one line with its core folded (+N) and the processes it started under it; Verify is read-only",
            ok1b, JSON.stringify(s1b?.groups.slice(1)));

        await h.ev(resmonClick(resmonChevron("arc")));
        await resmonNap(200);
        const expanded = await arcRows();
        await shot("2a-arc-expanded");
        await h.ev(resmonClick(resmonChevron("arc")));
        await resmonNap(200);
        const collapsed = await arcRows();
        await shot("2b-arc-collapsed");
        rec("2. Arc's chevron expands it, a second click collapses it", expanded === 9 && collapsed === 0,
            `expanded=${expanded} collapsed=${collapsed}`);

        await resmonKey(h, ctx, "ArrowDown");
        const c3 = (await resmonPopover(h))?.cursor;
        await resmonKey(h, ctx, "Enter");
        const opened3 = await arcRows();
        await shot("3-cursor-enter");
        rec("3. ↓ puts the cursor on Arc's header, ⏎ expands it", c3 === "arc" && opened3 === 9,
            `cursor=${c3} arcRows=${opened3}`);

        await h.ev(resmonClick(resmonRowKill(18311)));
        await resmonNap(200);
        const c4 = (await resmonPopover(h))?.confirm;
        await shot("4-row-confirm");
        rec("4. × on orchestrate.test.exe asks to kill it alone",
            c4 === "Kill orchestrate.test.exe (18311)? It has no child processes.", c4);

        await resmonBlur(h);
        await resmonKey(h, ctx, "Escape");
        const s5 = await resmonPopover(h);
        await shot("5-esc-cancel");
        rec("5. Esc removes the confirm and leaves the popover open", s5 != null && s5.confirm == null,
            `open=${s5 != null} confirm=${s5?.confirm}`);

        const reached = await resmonCursorTo(h, ctx, 18244);
        await resmonKey(h, ctx, "x");
        const c6 = (await resmonPopover(h))?.confirm;
        await resmonArm(h, { outcome: "killed", killed: 2 });
        await resmonKey(h, ctx, "Enter");
        await resmonNap(200);
        const s6 = await resmonPopover(h);
        await shot("6-killed");
        rec("6. x on go.exe asks for it and its child; ⏎ kills and notes it",
            reached && c6 === "Kill go.exe (18244) and its 1 child process?" &&
                s6?.status.includes("Killed go.exe (18244) and 1 child process."),
            JSON.stringify({ reached, confirm: c6, status: s6?.status }));

        await resmonKey(h, ctx, "Escape");
        await resmonNap(RESMON_REVEAL_MS);
        const gone7 = await h.ev(`!${RESMON_POPOVER}`);
        await shot("7-esc-close");
        rec("7. Esc closes the popover", gone7, `closed=${gone7}`);

        await h.ev(resmonClick(resmonReadout(RESMON_FOOTER)));
        await resmonNap(RESMON_REVEAL_MS);
        const reopened = await h.ev(`!!${RESMON_POPOVER}`);
        // a real pointer press on the Agent surface, clear of the popover and the footer
        const press = { x: 400, y: 300, button: "left", clickCount: 1 };
        await h.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...press });
        await h.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...press });
        await resmonNap(RESMON_REVEAL_MS);
        const gone8 = await h.ev(`!${RESMON_POPOVER}`);
        await shot("8-outside-click");
        rec("8. a click outside the popover and the readout closes it", reopened && gone8,
            `reopened=${reopened} closed=${gone8}`);
        return steps;
    },
    teardown: resmonTeardown,
};

export const resmonStates = {
    name: "resmon-states",
    surface: "agent",
    arrange: resmonArrange,
    async assert(h, ctx) {
        if (!ctx.ready) return RESMON_NO_HOOK;
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const shot = (n) => h.shot(`cdp-shots/resmon-states-${n}.png`);

        await resmonSet(h, null);
        await h.ev(`window.__resmonFixture.open()`);
        await resmonNap(RESMON_REVEAL_MS);
        const s1 = await resmonPopover(h);
        await shot("1-loading");
        rec("1. pinned null: the loading body",
            s1?.status.includes("Reading agent processes…") && s1.groups.length === 0, JSON.stringify(s1?.status));

        await resmonSet(h, { ...resmonFixture(), groups: [resmonArcGroup(Date.now())] });
        await resmonNap(200);
        const s2 = await resmonPopover(h);
        await shot("2-empty");
        rec("2. Arc only: the empty body",
            s2?.groups.length === 1 && s2.text.includes("No agent processes") &&
                s2.text.includes("Agent tabs, run workers and run commands show here while they run."),
            JSON.stringify(s2?.groups));

        await resmonSet(h, resmonFixture());
        await resmonNap(200);
        await resmonBlur(h);
        const onHeader = await resmonCursorTo(h, ctx, "job:14820");
        await resmonKey(h, ctx, "X");
        const c3 = (await resmonPopover(h))?.confirm;
        const want3 = "Kill 5 processes under waveterm? claude.exe and its console keep running.";
        await shot("3a-children-confirm");
        await h.ev(resmonClick(resmonConfirmButton("Cancel")));
        await resmonNap(200);
        const cancelled = (await resmonPopover(h))?.confirm == null;
        await shot("3b-cancelled");
        rec("3. ⇧X on waveterm's header asks to kill its 5 children; Cancel closes it",
            onHeader && c3 === want3 && cancelled, JSON.stringify({ onHeader, confirm: c3, cancelled }));

        await h.ev(resmonClick(resmonGroupButton("job:14820", "Kill children")));
        await resmonNap(200);
        const c4 = (await resmonPopover(h))?.confirm;
        await resmonArm(h, { outcome: "killed", killed: 5 });
        const clicked4 = await h.ev(resmonClick(resmonConfirmButton("Kill 5")));
        await resmonNap(300);
        const s4 = await resmonPopover(h);
        await shot("4-children-killed");
        rec("4. Kill children opens the same confirm; Kill 5 notes Killed 5 processes.",
            c4 === want3 && clicked4 && s4?.status.includes("Killed 5 processes."),
            JSON.stringify({ confirm: c4, clicked: clicked4, status: s4?.status }));

        // Task 2's rows sit in the run's view, which starts collapsed
        await h.ev(resmonClick(resmonChevron("run:run-a")));
        await resmonNap(200);
        await resmonArm(h, { outcome: "gone", killed: 0 });
        await h.ev(resmonClick(resmonRowKill(21890)));
        await resmonNap(200);
        const clicked5 = await h.ev(resmonClick(resmonConfirmButton("Kill")));
        await resmonNap(300);
        const s5 = await resmonPopover(h);
        await shot("5-gone");
        rec("5. gone: node.exe (21890) had already exited.",
            clicked5 && s5?.status.includes("node.exe (21890) had already exited."), JSON.stringify(s5?.status));

        // the × above left the cursor on node.exe (21890), so x asks for it again
        const alerts = [
            ["6-refused", { outcome: "refused", killed: 0 },
                (a) => a === "Not killed: pid 21890 no longer belongs to this run worker. The list refreshes in 2s.",
                "6. refused: the alert says the pid left this run worker"],
            ["7-protected", { outcome: "protected", killed: 0 },
                (a) => a.startsWith("Not killed: node.exe (21890) is the agent's own process."),
                "7. protected: the alert names the agent's own process"],
            ["8-failed", { outcome: "failed", killed: 0, error: "Access is denied." },
                (a) => /^Could not kill .+: Access is denied\. It is still running\.$/.test(a),
                "8. failed: the alert carries the OS error and says it is still running"],
        ];
        for (const [n, outcome, check, step] of alerts) {
            await resmonBlur(h);
            await resmonArm(h, outcome);
            await resmonKey(h, ctx, "x");
            const confirm = (await resmonPopover(h))?.confirm;
            await resmonKey(h, ctx, "Enter");
            await resmonNap(300);
            const alert = (await resmonPopover(h))?.alert ?? [];
            await shot(n);
            rec(step, confirm != null && alert.length === 1 && check(alert[0]), JSON.stringify({ confirm, alert }));
        }
        return steps;
    },
    teardown: resmonTeardown,
};

export const agentLaunchHero = {
    name: "agent-launch-hero",
    surface: "agent",
    async arrange() {
        return {};
    },
    async assert(h) {
        await lookOpen(h, "agent");
        const s = await lookEval(h, `
            const title = () => [...document.querySelectorAll("div")].find((d) => d.children.length === 0 && flat(d) === "No terminal running");
            await until(() => title() != null, 4000);
            // the recent sessions load after mount
            await until(() => /Recent sessions/.test(flat(document.body)), 3000);
            const list = [...document.querySelectorAll("span")].find((x) => flat(x) === "Recent sessions")?.closest(".rounded-lg");
            return {
                hero: title() != null,
                cta: button(document, /^New agent/) != null,
                sessions: list ? list.querySelectorAll("button").length : 0,
            };
        `);
        if (!s.hero) {
            return [skipStep("the Agent surface with nothing focused shows the launch hero", "an agent is focused in this profile - run it on a fresh store (final-verify.mjs)")];
        }
        await h.shot(lookShot("agent-launch-hero"));
        const heroFloor = await lookEval(h, `
            const title = [...document.querySelectorAll("div")].find((d) => d.children.length === 0 && flat(d) === "No terminal running");
            return floorWalk([title?.closest("div.h-full.w-full") ?? null]);
        `);
        // the CTA's label says what it opens
        const opened = await lookEval(h, `
            button(document, /^New agent/)?.click();
            return until(() => [...document.querySelectorAll('[role="dialog"] h2')].some((x) => flat(x) === "New agent"), 3000);
        `);
        const modalFloor = await lookEval(h, `await nap(300); return floorWalk([dialog() ?? document.querySelector('[role="dialog"]')]);`);
        // the modal rides newAgentOpenAtom, not modalsModel: its own close button shuts it
        await lookEval(h, `document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click();`);
        return [
            {
                step: "the Agent surface with nothing focused shows No terminal running, its New agent CTA and the recent sessions to resume",
                ok: s.cta,
                detail: JSON.stringify(s),
            },
            { step: "New agent opens the New agent modal", ok: opened === true, detail: `opened=${opened}` },
            { step: `no visible text in the launch hero is under ${MIN_FONT_PX}px`, ok: floorOk(heroFloor), detail: floorDetail(heroFloor) },
            { step: `no visible text in the New agent modal is under ${MIN_FONT_PX}px`, ok: floorOk(modalFloor), detail: floorDetail(modalFloor) },
        ];
    },
    async teardown() {},
};

// a shell terminal of the page's own workspace, focused on the Agent surface
const LOOK_TERM_LABEL = "look term";
const LOOK_TERM_URL = "https://example.com/arc/look-term-link";
const LOOK_TERM_WAIT_MS = 15_000;

export const termLinkTooltip = {
    name: "term-link-tooltip",
    surface: "agent",
    async arrange(h) {
        const ctx = {};
        try {
            const bootTab = String(await h.ev("window.TabRpcClient.routeId")).replace(/^tab:/, "");
            const wslist = await h.rpc("workspacelist", null);
            const ws = wslist.find((w) => (w.workspacedata?.tabids ?? []).includes(bootTab)) ?? wslist[0];
            ctx.workspaceId = ws.workspacedata.oid;
            ctx.tabId = await waveService(h, "workspace", "CreateTab", [ctx.workspaceId, LOOK_TERM_LABEL, false]);
            const tab = await waveService(h, "object", "GetObject", [`tab:${ctx.tabId}`]);
            ctx.blockId = tab?.blockids?.[0];
            if (!ctx.blockId) throw new Error("the new tab has no block");
            await h.rpc("setmeta", { oref: `block:${ctx.blockId}`, meta: { view: "term", controller: "shell", "cmd:cwd": "~" } });
        } catch (e) {
            ctx.launchError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const step = "hovering a URL the terminal printed shows the open-link tooltip";
        if (ctx.launchError != null) return [skipStep(step, `could not verify: the terminal launch failed: ${ctx.launchError}`)];
        await lookOpen(h, "agent");
        const row = `document.querySelector('[data-tree-terminal="${ctx.tabId}"]')`;
        await polishWaitFor(h, `!!${row}`, LOOK_TERM_WAIT_MS);
        await h.ev(`${row}?.click()`);
        const screenVisible = `[...document.querySelectorAll(".xterm-screen")].find((x) => x.checkVisibility())`;
        const ready = await polishWaitFor(h, `!!${screenVisible}`, LOOK_TERM_WAIT_MS);
        // the shell's banner and first prompt land before the cls, so the URL prints at the top
        await polishNap(2500);
        const typed = `cls; echo ${LOOK_TERM_URL}\r`;
        await h.rpc("controllerinput", { blockid: ctx.blockId, inputdata64: Buffer.from(typed).toString("base64") });
        await polishNap(2000);
        const rect = await h.ev(`(() => { const r = ${screenVisible}?.getBoundingClientRect(); return r ? { left: r.left, top: r.top } : null; })()`);
        // the URL's row is found by the pointer the link layer sets over it: the prompt's row holds it too, past
        // where the pointer runs, so the first pointer row is the echo's
        let at = null;
        for (let dy = 4; rect && dy < 240 && at == null; dy += 4) {
            const p = { x: Math.round(rect.left + 60), y: Math.round(rect.top + dy) };
            await lookHover(h, p.x, p.y);
            await polishNap(60);
            if (await h.ev(`${screenVisible}?.classList.contains("xterm-cursor-pointer") ?? false`)) at = p;
        }
        const shown = at != null && (await polishWaitFor(h, `/click to open link/.test(document.body.innerText)`, 2000));
        const look = shown === true ? await h.ev(LOOK_TOOLTIP_STYLE) : null;
        await h.shot(lookShot("term-link-tooltip"));
        const modKey = process.platform === "darwin" ? "Cmd" : "Ctrl";
        return [
            { step, ok: ready && shown === true, detail: JSON.stringify({ ready, rect, at, shown }) },
            { step: `the tooltip names this platform's modifier (${modKey}-click)`, ok: look?.text === `${modKey}-click to open link`, detail: JSON.stringify(look) },
            { step: "it wears the shared tooltip look", ok: tooltipLookOk(look), detail: JSON.stringify(look) },
        ];
    },
    async teardown(h, ctx) {
        await lookHover(h, 1, 1);
        if (ctx.tabId) {
            try {
                await waveService(h, "workspace", "CloseTab", [ctx.workspaceId, ctx.tabId, false]);
            } catch (e) {
                console.error(`term-link-tooltip teardown: closing ${ctx.tabId} failed: ${e?.message ?? e}`);
            }
        }
        await h.goto("cockpit");
    },
};

// AgentComposer on the mixed fixture roster: the parked idle list's row composer (janitor), and a working card's
// composer expanded from its slim row (waveterm)
const LOOK_COMPOSER_IDLE = "janitor";
const LOOK_COMPOSER_CARD = "waveterm";
const lookComposer = (name) => `document.querySelector('textarea[placeholder="message ${name}…"]')`;

export const agentComposer = {
    name: "agent-composer",
    surface: "cockpit",
    async arrange(h) {
        mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
        writeFileSync(TREE_RAIL_FIXTURE, JSON.stringify(COCKPIT_FIXTURES.mixed(Date.now()), null, 2));
        // the fixture roster is read once at boot
        await h.reload();
        return { wroteFixture: true };
    },
    async assert(h) {
        const steps = [];
        await lookOpen(h, "cockpit");
        const idle = await lookEval(h, `
            const header = () => [...document.querySelectorAll("div.cursor-pointer")].find((el) => /^Idle\\s*\\d+$/i.test(flat(el)));
            await until(() => header() != null, 8000);
            header()?.click();
            const ok = await until(() => ${lookComposer(LOOK_COMPOSER_IDLE)} != null, 3000);
            ${lookComposer(LOOK_COMPOSER_IDLE)}?.scrollIntoView({ block: "center" });
            await nap(500);
            return { header: header() != null, ok };
        `);
        await h.shot(lookShot("agent-composer-idle"));
        steps.push({ step: "the opened Idle list gives each parked idle agent a message composer", ok: idle.ok, detail: JSON.stringify(idle) });
        // :focus never matches while the dev window is behind another one
        await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
        const card = await lookEval(h, `
            const slim = [...document.querySelectorAll("div.cursor-text")].find((el) => flat(el).startsWith("message ${LOOK_COMPOSER_CARD}…"));
            slim?.scrollIntoView({ block: "center" });
            slim?.click();
            const ta = () => ${lookComposer(LOOK_COMPOSER_CARD)};
            const ok = await until(() => ta() != null, 3000);
            if (ok) {
                const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
                set.call(ta(), "keep the old session cookie name for one release");
                ta().dispatchEvent(new Event("input", { bubbles: true }));
            }
            await nap(500);
            if (!ok) return { slim: slim != null, ok };
            ta().focus();
            await nap(100);
            const send = button(ta().parentElement, /^Send$/);
            // every clipping ancestor, the card's scroll region included, must show Send and the textarea whole
            const clips = [];
            for (let p = ta().parentElement; p; p = p.parentElement) {
                if (getComputedStyle(p).overflow !== "visible") clips.push(p);
            }
            const inside = (el) => clips.every((c) => el.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 0.5);
            const idleTa = ${lookComposer(LOOK_COMPOSER_IDLE)};
            return {
                slim: slim != null,
                ok,
                sendEnabled: send?.disabled === false,
                focusEdge: getComputedStyle(ta()).borderTopColor,
                restEdge: idleTa ? getComputedStyle(idleTa).borderTopColor : null,
                unclipped: inside(ta()) && send != null && inside(send),
                oneLine: ta().offsetHeight <= 34,
            };
        `);
        await h.shot(lookShot("agent-composer-card"));
        await h.cdp("Emulation.setFocusEmulationEnabled", { enabled: false });
        steps.push({
            step: "a working card's composer expands from its slim row and enables Send once it holds a message",
            ok: card.ok && card.sendEnabled === true,
            detail: JSON.stringify(card),
        });
        steps.push({
            step: "the focused composer shows a focus edge, stays one line tall for a one-line message, and its textarea and Send sit inside the card",
            ok: card.ok && card.restEdge != null && card.focusEdge !== card.restEdge && card.unclipped === true && card.oneLine === true,
            detail: JSON.stringify(card),
        });
        steps.push(await floorStep(h, `no visible text on the Cockpit, its Idle list open, is under ${MIN_FONT_PX}px`, COCKPIT));
        return steps;
    },
    async teardown(h, ctx) {
        if (ctx.wroteFixture) rmSync(TREE_RAIL_FIXTURE, { force: true });
        await h.reload();
        await h.goto("cockpit");
    },
};

// a finished quick run's worker beside a plain idle agent: the worker's tree row, card and header read as done
// (the done tick), while the idle agent keeps its grey dot
const QUICK_DONE_ID = "fx-quick-done";
const QUICK_DONE_NAME = "quick finisher";
const QUICK_IDLE_ID = "fx-quick-idle";
const QUICK_IDLE_NAME = "idle bystander";
const QUICK_DONE_TICK = "Done, its run finished";

export const quickRunDone = {
    name: "quick-run-done",
    surface: "agent",
    async arrange(h) {
        const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-quick-run-done-")) };
        try {
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: "verify-quick-run-done", projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: "verify quick-run-done: do nothing",
                runtime: "claude",
                mode: "quick",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            ctx.landPath = created.run.landpath;
            // the worker has completed the run: what `wsh jarvis complete` leaves on it
            const stored = await fstWriteRun(h, ctx.runId, (run) => ({ ...run, status: "done", completedts: Date.now() }));
            ctx.runStatus = stored?.status;
            const now = Date.now();
            const idle = (id, name, extra) => ({
                id,
                name,
                project: "waveterm",
                task: name,
                state: "idle",
                agent: "claude",
                model: "opus",
                idleSince: now - 60_000,
                blockId: `${id}-blk`,
                ...extra,
            });
            mkdirSync(new URL(".", TREE_RAIL_FIXTURE), { recursive: true });
            writeFileSync(
                TREE_RAIL_FIXTURE,
                JSON.stringify(
                    [idle(QUICK_DONE_ID, QUICK_DONE_NAME, { runId: ctx.runId }), idle(QUICK_IDLE_ID, QUICK_IDLE_NAME)],
                    null,
                    2
                )
            );
            ctx.wroteFixture = true;
            // the fixture roster is read once at boot
            await h.ev("location.reload()");
            await h.ev(`(async () => {
                for (let i = 0; i < 60 && !document.querySelector("nav button"); i++) {
                    await new Promise((r) => setTimeout(r, 500));
                }
            })()`);
            await h.goto("agent");
            // the worker's row turns its dot into the tick once its run loads; focus it for the header
            ctx.focused = await h.ev(`(async () => {
                for (let i = 0; i < 40; i++) {
                    const tick = document.querySelector('[data-agent-tree] [aria-label=${JSON.stringify(QUICK_DONE_TICK)}]');
                    if (tick) {
                        tick.closest(".cursor-pointer").click();
                        return true;
                    }
                    await new Promise((r) => setTimeout(r, 250));
                }
                return false;
            })()`);
            await new Promise((r) => setTimeout(r, 800));
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        rec(
            "0. a quick run stored as done, its worker in the roster and focused",
            ctx.arrangeError == null && ctx.runStatus === "done" && ctx.focused === true,
            ctx.arrangeError ?? JSON.stringify({ runId: ctx.runId, runStatus: ctx.runStatus, focused: ctx.focused })
        );
        const rows = await h.ev(`(() => {
            const tree = document.querySelector("[data-agent-tree]");
            const row = (name) => {
                const label = tree && [...tree.querySelectorAll("div")].find(
                    (d) => d.textContent.trim() === name && d.children.length === 0
                );
                const r = label && label.closest(".cursor-pointer");
                const mark = r && r.firstElementChild && r.firstElementChild.firstElementChild;
                if (!mark) return null;
                const svg = mark.querySelector("svg");
                return {
                    tick: svg ? svg.getAttribute("aria-label") : null,
                    dot: mark.tagName.toLowerCase() === "span" && !svg ? getComputedStyle(mark).backgroundColor : null,
                };
            };
            return { done: row(${JSON.stringify(QUICK_DONE_NAME)}), idle: row(${JSON.stringify(QUICK_IDLE_NAME)}) };
        })()`);
        rec(
            "1. the finished quick run's tree row shows the done tick",
            rows?.done?.tick === QUICK_DONE_TICK,
            JSON.stringify(rows)
        );
        rec(
            "2. the idle agent's tree row keeps its dot, no tick",
            rows?.idle != null && rows.idle.tick == null && rows.idle.dot != null,
            JSON.stringify(rows)
        );
        const header = await h.ev(`(() => {
            const hd = document.querySelector("[data-agent-header]");
            if (!hd) return null;
            return {
                tick: !!hd.querySelector('[aria-label=${JSON.stringify(QUICK_DONE_TICK)}]'),
                done: [...hd.querySelectorAll("span")].some((s) => s.children.length === 0 && s.textContent.trim() === "done"),
                idle: [...hd.querySelectorAll("span")].some((s) => s.children.length === 0 && s.textContent.trim() === "idle"),
            };
        })()`);
        rec(
            "3. the focused worker's header chip reads done with the tick, not idle",
            header != null && header.tick && header.done && !header.idle,
            JSON.stringify(header)
        );
        await h.shot("cdp-shots/quick-run-done.png");
        return steps;
    },
    async teardown(h, ctx) {
        // a done run cannot be cancelled, so teardown skips the cancel and only deletes the channel
        await teardownFixtureRun(h, { ...ctx, runId: undefined }, "quick-run-done");
    },
};
