// Jarvis scenarios: the avatar, its faults and activity, the jarvis peek and motion.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SURFACE_LABEL } from "./attach.mjs";
import {
    MIN_FONT_PX,
    floorDetail,
    floorOk,
    lookEval,
    paintEval,
    polishWaitFor,
    reloadApp,
    restoreLocalStorage,
    usageRateLimits,
    waitForProjectInConfig,
} from "./scenarios-shared.mjs";

// --- jarvis avatar: the hologram in window chrome ----------------------------------------------
// The avatar is a <canvas>, so there are no attributes to read the way the old SVG creature allowed. It
// publishes its last built scene on window in DEV builds instead (petview.tsx), which is a STRONGER
// assertion than the SVG version permitted: the whole scene at once rather than one element's transform.
// A screenshot still goes to the contact sheet for eyeballing the glow.
export const jarvisAvatar = {
    name: "jarvis-avatar",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });

        const raw = await h.ev("JSON.stringify(window.__jarvisAvatarScene ?? null)");
        const scene = raw ? JSON.parse(raw) : null;
        if (scene == null) {
            rec("1. the avatar publishes a scene", false, "window.__jarvisAvatarScene is null — is the loop running?");
            return steps;
        }

        rec(
            "1. the render loop publishes a non-empty scene",
            scene.segments > 0 && scene.fills > 0,
            `segments=${scene.segments} fills=${scene.fills} renderer=${scene.renderer}`
        );
        // a literal here would silently opt the avatar out of every runtime theme
        rec(
            "2. the tone is a theme token, never a resolved colour",
            String(scene.toneVar).startsWith("--color-"),
            `toneVar=${scene.toneVar} markerVar=${scene.markerVar}`
        );
        rec("3. the form has a non-zero extent", scene.extent > 0, `extent=${scene.extent}`);

        // exactly one control owns each accessible name; two would make a by-label query ambiguous, and
        // h.goto navigates the rail by exactly this label
        const named = await h.ev(`[...document.querySelectorAll('[aria-label="Jarvis condition"]')].length`);
        const navNamed = await h.ev(`[...document.querySelectorAll('[aria-label="Hub"]')].length`);
        rec(
            "4. the avatar and the nav rail keep distinct accessible names",
            named === 1 && navNamed === 1,
            `"Jarvis condition"=${named} "Hub"=${navNamed}`
        );

        // Two canvases by design: one element can only ever yield contexts of a single kind, so the 2D
        // fallback needs its own. Exactly one is displayed at a time.
        const canvases = JSON.parse(
            await h.ev(`(() => {
                const w = document.querySelector('[aria-label="Jarvis condition"]');
                if (!w) return "[]";
                return JSON.stringify([...w.querySelectorAll('canvas')].map((c) => c.className));
            })()`)
        );
        rec(
            "5. both renderers have a canvas and exactly one is shown",
            canvases.length === 2 && canvases.filter((c) => c === "block").length === 1,
            JSON.stringify(canvases)
        );

        await h.shot("cdp-shots/jarvis-avatar.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit"); // leave the app where a human expects it
    },
};

// --- jarvis avatar faults: link lost > run held > tired, each face in turn ----------------------
// Link lost is held through the dev-only __waveLink hook, because a real ws drop reconnects at once and
// stopping wavesrv would stop the dev app with it. Attention is injected through __wavePetStore, and the 10s
// poll overwrites it, so each state's shot is taken promptly.
const JARVIS_FAULT_HELD = {
    key: "run-land-held:cdp-held",
    kind: "run-land-held",
    source: "retry budget",
    text: "retry budget can't land.",
    reason: "merge conflict in policy.go",
    action: "Open",
    waitingsince: 0,
    channelid: "",
    runid: "cdp-held",
    phaseidx: 0,
};
const JARVIS_FAULT_ESCALATION = {
    key: "esc:cdp-escalation",
    kind: "escalation",
    source: "first escalation",
    text: "Allow the migration to rewrite the schema?",
    action: "Decide",
    waitingsince: 0,
    channelid: "",
    runid: "cdp-escalation",
    phaseidx: 0,
};

export const jarvisAvatarFaults = {
    name: "jarvis-avatar-faults",
    surface: "cockpit",
    async arrange(h) {
        const ctx = { prevRate: await h.ev(`localStorage.getItem('wave:ratelimits')`) };
        // a saved snapshot past the ok band would make step 1 tired, so the run starts with none
        await h.ev(`localStorage.removeItem('wave:ratelimits')`);
        await reloadApp(h);
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const scene = async () => JSON.parse((await h.ev("JSON.stringify(window.__jarvisAvatarScene ?? null)")) ?? "null");
        // the scene is published by the frame loop, a render after the signal changes
        const until = (expression, posture) =>
            polishWaitFor(
                h,
                `window.__jarvisAvatarScene?.expression === ${JSON.stringify(expression)} && window.__jarvisAvatarScene?.posture === ${JSON.stringify(posture)}`,
                5000
            );
        // past MOOD_TAU_MS a few times over, so the shot is the settled face and not the crossfade
        const settle = () => h.ev("new Promise((r) => setTimeout(r, 1500))");
        const setAttention = (items) =>
            h.ev(`globalThis.__wavePetStore.setAttention(${JSON.stringify(items)}.map((i) => ({ ...i, waitingsince: Date.now() - 60000 })))`);
        const openPeek = async () => {
            await h.ev(`document.querySelector('[aria-label="Jarvis condition"]')?.click()`);
            return polishWaitFor(h, `!!document.querySelector('[data-pet-peek]')`, 3000);
        };
        const closePeek = async () => {
            await h.ev(`document.querySelector('[aria-label="Close Jarvis panel"]')?.click()`);
            await polishWaitFor(h, `!document.querySelector('[data-pet-peek]')`, 3000);
        };
        const leadLine = (kind) =>
            h.ev(`document.querySelector('[data-pet-condition=${JSON.stringify(kind)}]')?.textContent?.trim() ?? null`);
        const state = async (step, expression, posture, shot, extra = async () => ({ ok: true })) => {
            const reached = await until(expression, posture);
            await settle();
            const s = await scene();
            const more = await extra();
            await h.shot(`cdp-shots/jarvis-avatar-fault-${shot}.png`);
            rec(
                step,
                reached && s?.expression === expression && s?.posture === posture && more.ok,
                JSON.stringify({ expression: s?.expression, posture: s?.posture, toneVar: s?.toneVar, ...more })
            );
        };

        try {
            await h.goto("cockpit");
            ctx.prevLink = await h.ev("JSON.stringify(globalThis.__waveLink?.get() ?? null)");
            await h.ev(`globalThis.__waveLink.set({ connected: true, everConnected: true, lostAt: null })`);
            await setAttention([]);
            await state("1. with the link up and nothing waiting the avatar is at rest", "at-rest", "none", "at-rest");

            await h.ev(`localStorage.setItem('wave:ratelimits', ${JSON.stringify(JSON.stringify(usageRateLimits()))})`);
            await reloadApp(h);
            await h.goto("cockpit");
            ctx.prevLink = await h.ev("JSON.stringify(globalThis.__waveLink?.get() ?? null)");
            await setAttention([]);
            await state("2. a window past the ok band makes it tired", "tired", "none", "tired");

            await h.ev(`globalThis.__waveLink.set({ connected: false, everConnected: true, lostAt: Date.now() - 10000 })`);
            await state("3. a link down past the grace outranks tired, and the peek leads with it", "link-lost", "none", "link-lost", async () => {
                const opened = await openPeek();
                const line = await leadLine("link-lost");
                return { ok: opened && String(line).startsWith("I can't reach the backend"), opened, line };
            });
            await closePeek();

            await h.ev(`globalThis.__waveLink.set({ connected: true, everConnected: true, lostAt: null })`);
            await setAttention([JARVIS_FAULT_HELD]);
            await state("4. a held land outranks tired, and the peek names the run and the reason", "run-held", "none", "run-held", async () => {
                const opened = await openPeek();
                const line = await leadLine("run-held");
                return {
                    ok: opened && line === "retry budget can't land — merge conflict in policy.go.",
                    opened,
                    line,
                };
            });
            await closePeek();

            await setAttention([JARVIS_FAULT_HELD, JARVIS_FAULT_ESCALATION]);
            await state("5. a waiting escalation composes with the held land as posture", "run-held", "escalation", "run-held-escalation");
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`jarvis-avatar-faults teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("close the peek", () => h.ev(`document.querySelector('[aria-label="Close Jarvis panel"]')?.click()`));
        if (ctx?.prevLink != null && ctx.prevLink !== "null") {
            await step("restore the link", () => h.ev(`globalThis.__waveLink?.set(${ctx.prevLink})`));
        }
        await step("clear the injected attention", () => h.ev(`globalThis.__wavePetStore?.setAttention([])`));
        // the reload is what returns savedRateLimitsAtom to the restored snapshot
        await step("restore the rate limits", async () => {
            await h.ev(restoreLocalStorage("wave:ratelimits", ctx?.prevRate ?? null));
            await reloadApp(h);
        });
        await step("return to cockpit", () => h.goto("cockpit"));
    },
};

// --- jarvis avatar activity: the working count as tempo and inbound pulses, never presence -------
// The count is held through the dev-only __wavePetStore.setWorking, because starting six real agents to
// photograph a tempo is the trade setAttention already makes. motion's useReducedMotion reads the media
// query once per page load, so the reduced-motion row reloads under the emulation.
const JARVIS_ACTIVITY_ASK = {
    key: "ask:cdp-activity",
    kind: "ask",
    source: "worker 3",
    text: "Which branch should I rebase onto?",
    action: "Answer",
    waitingsince: 0,
    channelid: "",
    runid: "cdp-activity",
    phaseidx: 0,
};

export const jarvisAvatarActivity = {
    name: "jarvis-avatar-activity",
    surface: "cockpit",
    async arrange(h) {
        const ctx = { prevRate: await h.ev(`localStorage.getItem('wave:ratelimits')`) };
        // a saved snapshot past the ok band would make the avatar tired, and tired is never quiet
        await h.ev(`localStorage.removeItem('wave:ratelimits')`);
        await reloadApp(h);
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const nap = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const setWorking = (n) => h.ev(`globalThis.__wavePetStore.setWorking(${JSON.stringify(n)})`);
        const setAttention = (items) =>
            h.ev(`globalThis.__wavePetStore.setAttention(${JSON.stringify(items)}.map((i) => ({ ...i, waitingsince: Date.now() - 60000 })))`);
        const opacity = async () =>
            Number(await h.ev(`getComputedStyle(document.querySelector('[aria-label="Jarvis condition"]')).opacity`));
        // the scene is published by the frame loop, so the count lands a frame after setWorking
        const until = (working, posture) =>
            polishWaitFor(
                h,
                `window.__jarvisAvatarScene?.working === ${working} && window.__jarvisAvatarScene?.posture === ${JSON.stringify(posture)}`,
                5000
            );
        // pulses come and go by design, so a row reads several frames rather than one
        const sample = async () => {
            const seen = [];
            for (let i = 0; i < 10; i++) {
                seen.push(JSON.parse(await h.ev("JSON.stringify(window.__jarvisAvatarScene ?? null)")));
                await nap(150);
            }
            return seen;
        };
        const row = async (step, { name, working, posture, attention, check }) => {
            // the 10s attention poll can overwrite the injection before or during the samples, so a row whose
            // posture drifted is read again from a fresh injection
            let reached = false;
            let seen = [];
            let op = NaN;
            for (let attempt = 0; attempt < 3; attempt++) {
                await setAttention(attention);
                await setWorking(working);
                reached = await until(working, posture);
                // the opacity tween is 0.3s
                await nap(400);
                seen = await sample();
                op = await opacity();
                await h.shot(`cdp-shots/jarvis-avatar-activity-${name}-${working}.png`);
                if (reached && seen.every((s) => s?.posture === posture)) break;
            }
            const last = seen[seen.length - 1];
            const pulses = seen.map((s) => s?.pulses ?? -1);
            const verdict = check({ breathMs: last?.breathMs, pulses, opacity: op });
            rec(
                step,
                reached && seen.every((s) => s?.posture === posture) && verdict,
                JSON.stringify({ working: last?.working, breathMs: last?.breathMs, posture: last?.posture, pulses, opacity: op })
            );
        };
        const none = (p) => p.every((n) => n === 0);
        const some = (p) => p.some((n) => n > 0);

        try {
            await h.goto("cockpit");
            await h.ev(`globalThis.__wavePetStore.resetPeek()`);

            await row("1. at rest with nothing working: the 4.8s breath and no pulses", {
                name: "rest",
                working: 0,
                posture: "none",
                attention: [],
                check: (r) => r.breathMs === 4800 && none(r.pulses),
            });
            await row("2. two working: a quicker breath and pulses, still quiet at 40%", {
                name: "rest",
                working: 2,
                posture: "none",
                attention: [],
                check: (r) =>
                    r.breathMs >= 3300 && r.breathMs <= 3500 && some(r.pulses) && Math.abs(r.opacity - 0.4) < 0.05,
            });
            await row("3. six working: the 1.9s breath", {
                name: "rest",
                working: 6,
                posture: "none",
                attention: [],
                check: (r) => r.breathMs === 1900 && some(r.pulses) && Math.abs(r.opacity - 0.4) < 0.05,
            });

            for (const working of [0, 2, 6]) {
                await row(`4. a worker waiting, ${working} working: blocked-worker at full presence`, {
                    name: "waiting",
                    working,
                    posture: "blocked-worker",
                    attention: [JARVIS_ACTIVITY_ASK],
                    check: (r) => r.opacity > 0.95 && (working === 0 ? none(r.pulses) : some(r.pulses)),
                });
            }

            await h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
            ctx.mediaEmulated = true;
            await reloadApp(h);
            await h.goto("cockpit");
            await row("5. reduced motion at six working: no pulses at all", {
                name: "reduced",
                working: 6,
                posture: "none",
                attention: [],
                check: (r) => none(r.pulses),
            });
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`jarvis-avatar-activity teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("release the working count", () => h.ev(`globalThis.__wavePetStore?.setWorking(null)`));
        await step("clear the injected attention", () => h.ev(`globalThis.__wavePetStore?.setAttention([])`));
        if (ctx?.mediaEmulated) {
            await step("clear the media emulation", () => h.cdp("Emulation.setEmulatedMedia", { features: [] }));
        }
        // the reload returns savedRateLimitsAtom to the restored snapshot and motion to the real media query
        await step("restore the rate limits", async () => {
            await h.ev(restoreLocalStorage("wave:ratelimits", ctx?.prevRate ?? null));
            await reloadApp(h);
        });
        await step("return to cockpit", () => h.goto("cockpit"));
    },
};

const JARVIS_PEEK_PROJECT = "verify-jarvis-peek";
// DEV_ATTENTION_ITEMS_KEY in frontend/app/view/agents/attentionstore.ts
const JARVIS_PEEK_DEV_ITEMS_KEY = "wave:dev-attention-items";

// a registered project is the composer's destination (petpeek.tsx: projectListAtom's rows with a channel), and
// createproject makes its channel. The channel snapshot is boot-primed, so the frontend reloads to see it, and
// the reload closes the hub, so it is reopened from the creature the way step 1 opened it. The existing fixture
// helpers (arrangeFixtureRun, brief-peek's createchannel) make a channel with no registered project, which is
// not a destination.
async function arrangeJarvisPeekDest(h, ctx) {
    try {
        ctx.destDir = mkdtempSync(join(tmpdir(), "verify-jarvis-peek-"));
        await h.rpc("createproject", { name: JARVIS_PEEK_PROJECT, path: ctx.destDir });
        ctx.destProject = JARVIS_PEEK_PROJECT;
        await waitForProjectInConfig(h, JARVIS_PEEK_PROJECT);
        // not polishReload: it lands on the Jarvis surface, whose mount selects a channel
        try {
            await h.ev("location.reload()");
        } catch {
            /* the evaluate is cut off by the navigation it just started */
        }
        await polishWaitFor(h, "!!window.TabRpcClient && !!document.querySelector('nav button')", 30000);
        await h.goto("cockpit");
        await h.ev(`(() => {
            const store = globalThis.__wavePetStore;
            store?.resetPeek();
            store?.setAttention([]);
            document.querySelector('[aria-label="Jarvis condition"]')?.focus();
        })()`);
        for (const type of ["keyDown", "keyUp"]) {
            await h.cdp("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        }
        const composerEnabled = await polishWaitFor(
            h,
            `(() => { const i = document.querySelector('[data-pet-peek] [data-pet-errand-input]'); return i != null && !i.disabled; })()`,
            10000
        );
        const destLabel = await h.ev(
            `document.querySelector('[data-pet-peek] [data-pet-errand-dest]')?.selectedOptions?.[0]?.textContent?.trim() ?? null`
        );
        return { composerEnabled, destLabel };
    } catch (e) {
        return { composerEnabled: false, error: String(e?.message ?? e) };
    }
}

// deleteproject leaves the channel createproject made, so the channel at the project's path goes too
async function teardownJarvisPeekDest(h, ctx) {
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            console.error(`jarvis-peek teardown: ${what} failed: ${e?.message ?? e}`);
        }
    };
    if (ctx?.destProject) await step("delete the project", () => h.rpc("deleteproject", { name: ctx.destProject }));
    if (ctx?.destDir) {
        await step("delete the project's channel", async () => {
            const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
            const channels = (await h.rpc("getchannels", null))?.channels ?? [];
            for (const c of channels.filter((c) => norm(c.projectpath) === norm(ctx.destDir))) {
                await h.rpc("deletechannel", { channelid: c.oid });
            }
        });
        await step("remove the temp dir", () => rmSync(ctx.destDir, { recursive: true, force: true }));
    }
}

export const jarvisPeek = {
    name: "jarvis-peek",
    surface: "cockpit",
    async arrange(h) {
        // petSaidAtom is session-scoped. Reloading gives this scenario a deterministic empty feed while
        // the persisted watermark still prevents old backend facts from speaking again.
        // a fixed sleep raced a slow boot in Final: the reset then ran before the store existed
        await h.reload();
        await polishWaitFor(h, "typeof globalThis.__wavePetStore?.resetPeek === 'function'", 10000);
        const reset = await h.ev(`(() => {
            const store = globalThis.__wavePetStore;
            if (typeof store?.resetPeek !== 'function') return false;
            store.resetPeek();
            store.setAttention([]);
            return true;
        })()`);
        return { reset };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
            for (const type of ["keyDown", "keyUp"]) {
                await h.cdp("Input.dispatchKeyEvent", {
                    type,
                    key,
                    code,
                    windowsVirtualKeyCode,
                    modifiers,
                });
            }
            await settle(350);
        };

        const creatureFocused = await h.ev(`(() => {
            const creature = document.querySelector('[aria-label="Jarvis condition"]');
            if (!creature) return false;
            creature.focus();
            return document.activeElement === creature;
        })()`);
        await press("Enter", "Enter", 13);

        const structure = await h.ev(`(() => {
            const panel = document.querySelector('[data-pet-peek]');
            if (!panel) return null;
            const labelledBy = panel.getAttribute('aria-labelledby');
            const label = labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : null;
            const input = panel.querySelector('[data-pet-errand-input]');
            const dest = panel.querySelector('[data-pet-errand-dest]');
            const rect = panel.getBoundingClientRect();
            return {
                role: panel.getAttribute('role'),
                label,
                shape: panel.getAttribute('data-pet-peek-shape'),
                close: panel.querySelector('button[aria-label="Close Jarvis panel"]') != null,
                panelFocused: document.activeElement === panel,
                // the panel is header / queue / composer, in that DOM order. Conditions and the updates
                // drawer are conditional and absent in the reset state, which is the point of the redesign.
                header: panel.querySelector('[data-pet-peek-header]') != null,
                queue: panel.querySelector('[data-pet-queue]') != null,
                composer: panel.querySelector('[data-pet-composer]') != null,
                conditions: panel.querySelector('[data-pet-conditions]') != null,
                updatesDrawer: panel.querySelector('[data-pet-updates]') != null,
                rows: panel.querySelectorAll('[data-pet-row]').length,
                // absence must not be rendered: no tile reading "Nothing", no empty-updates card, no
                // health badge restating what the lines below already say (2026-09-04 brief §3, §6).
                text: (panel.innerText || '').trim(),
                height: Math.round(rect.height),
                destPresent: dest != null,
                destLabel: dest?.selectedOptions?.[0]?.textContent?.trim() ?? null,
                inputDisabled: input?.disabled ?? null,
                inputPlaceholder: input?.getAttribute('placeholder') ?? null,
            };
        })()`);
        rec(
            "1. keyboard open renders a labelled dialog of header/queue/composer and focuses its container",
            creatureFocused === true &&
                structure?.role === "dialog" &&
                structure?.label === "No runs or questions waiting" &&
                structure?.shape === "quiet" &&
                structure?.header === true &&
                structure?.queue === true &&
                structure?.composer === true &&
                structure?.close === true &&
                structure?.panelFocused === true,
            JSON.stringify({ creatureFocused, structure })
        );

        await press("Tab", "Tab", 9);
        const firstTab = await h.ev(`(() => ({
            label: document.activeElement?.getAttribute('aria-label') ?? null,
            inside: document.querySelector('[data-pet-peek]')?.contains(document.activeElement) ?? false,
        }))()`);
        await press("Tab", "Tab", 9, 8);
        const wrappedInside = await h.ev(
            `document.querySelector('[data-pet-peek]')?.contains(document.activeElement) ?? false`
        );
        rec(
            "2. Tab starts at Full view and reverse traversal stays inside the dialog",
            firstTab.inside === true && firstTab.label === "Open in Hub" && wrappedInside === true,
            JSON.stringify({ firstTab, wrappedInside })
        );
        // Each string below is one the old three-card panel rendered to report missing telemetry or repeat
        // a disabled composer state. The adaptive card states queue absence once in its title; these older
        // tile-level absence messages must not come back.
        const ABSENCE =
            /No updates yet|No reading|Usage unavailable|No action needed|No destination|No channel selected|Select a channel to ask Jarvis/;
        rec(
            "3. the quiet card states queue absence once, and the composer is live wherever there is a destination",
            ctx.reset === true &&
                structure?.updatesDrawer === false &&
                ABSENCE.test(structure?.text ?? "") === false &&
                structure?.text.includes("No runs or questions waiting") === true &&
                // the fix: dead only when there is genuinely nowhere to send. The composer used to read the
                // Jarvis surface's selection, which nothing sets at boot, so it was dead on every surface.
                structure?.inputDisabled === !structure?.destPresent &&
                // resting height, against the 693px the three-card panel cost. Only asserted with an empty
                // queue: rows are real content and are allowed to make the panel taller.
                (structure?.rows > 0 || (structure?.height > 0 && structure?.height < 320)),
            JSON.stringify(structure)
        );
        await h.shot("cdp-shots/jarvis-peek-empty.png");

        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 440,
            height: 420,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await settle(450);
        const narrow = await h.ev(`(() => {
            const panel = document.querySelector('[data-pet-peek]');
            const header = document.querySelector('[data-pet-peek-header]');
            const body = document.querySelector('[data-pet-peek-body]');
            if (!panel || !header || !body) return null;
            const rect = panel.getBoundingClientRect();
            const headerTop = Math.round(header.getBoundingClientRect().top);
            body.scrollTop = body.scrollHeight;
            const headerAfterScroll = Math.round(header.getBoundingClientRect().top);
            return {
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                top: Math.round(rect.top),
                bottom: Math.round(rect.bottom),
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                width: Math.round(rect.width),
                shape: panel.getAttribute('data-pet-peek-shape'),
                horizontalOverflow: panel.scrollWidth - panel.clientWidth,
                bodyScrollable: body.scrollHeight > body.clientHeight,
                headerStayed: headerTop === headerAfterScroll,
            };
        })()`);
        await h.shot("cdp-shots/jarvis-peek-narrow.png");

        const pickerOpened = await h.ev(`(() => {
            const picker = document.querySelector('[data-pet-peek] [data-testid="harness-picker"]');
            if (!picker) return false;
            picker.click();
            return true;
        })()`);
        await settle(350);
        const pickerVisibility = await h.ev(`(() => {
            const options = [...document.querySelectorAll('[data-testid^="harness-option-"]')];
            const viewport = { width: window.innerWidth, height: window.innerHeight };
            const visible = options.length > 0 && options.every((option) => {
                const rect = option.getBoundingClientRect();
                const x = Math.round(rect.left + rect.width / 2);
                const y = Math.round(rect.top + rect.height / 2);
                const hit = document.elementFromPoint(x, y);
                return rect.left >= 0 && rect.right <= viewport.width && rect.top >= 0 && rect.bottom <= viewport.height &&
                    (hit === option || option.contains(hit));
            });
            return {
                count: options.length,
                visible,
                rects: options.map((option) => {
                    const rect = option.getBoundingClientRect();
                    return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
                }),
            };
        })()`);
        await h.ev(`document.querySelector('[data-pet-peek] [data-testid="harness-picker"]')?.click()`);
        await settle(350);
        rec(
            // bodyScrollable is deliberately no longer required: the resting panel now FITS 440x420, which
            // is the redesign's first success criterion. headerStayed still proves the pin structurally —
            // the header sits outside the scroll container whether or not the queue currently overflows.
            "4. the narrow panel stays bounded with a pinned header, no horizontal overflow, and an unclipped harness picker",
            narrow != null &&
                narrow.left >= 8 &&
                narrow.right <= narrow.viewportWidth - 8 &&
                narrow.top >= 8 &&
                narrow.bottom <= narrow.viewportHeight - 8 &&
                narrow.width <= 420 &&
                narrow.shape === "quiet" &&
                narrow.horizontalOverflow <= 0 &&
                narrow.headerStayed === true &&
                pickerOpened === true &&
                pickerVisibility?.visible === true,
            JSON.stringify({ narrow, pickerOpened, pickerVisibility })
        );

        // the portaled harness menu is inside the dialog's aria scope, and a pick closes it with focus back inside
        // the dialog, so the popup's keys still reach it and one Escape closes it. Real mouse events, because element.click() moves no focus.
        const centerOf = (selector) =>
            h.ev(`(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`);
        const clickAt = async (pt) => {
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
            for (const type of ["mousePressed", "mouseReleased"]) {
                await h.cdp("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
            }
        };
        const PICKER = '[data-pet-peek] [data-testid="harness-picker"]';
        ctx.prevHarness = await h.ev(`document.querySelector(${JSON.stringify(PICKER)})?.dataset.harnessRuntime ?? null`);
        // the server takes runtime and model only as a pair, so teardown restores both
        const settings = (await h.rpc("getfullconfig", null))?.settings ?? {};
        ctx.prevRoute = settings["harness:preferredruntime"]
            ? { runtime: settings["harness:preferredruntime"], model: settings["harness:preferredmodel"] ?? "" }
            : null;
        const chip = await centerOf(PICKER);
        if (chip != null) await clickAt(chip);
        await settle(400);
        // the current selection when it can be picked, so the pick leaves the preference as it was
        const option = await h.ev(`(() => {
            const options = [...document.querySelectorAll('[data-testid^="harness-option-"]')].filter((o) => !o.disabled);
            const o = options.find((x) => x.getAttribute('aria-pressed') === 'true') ?? options[0];
            if (!o) return null;
            const r = o.getBoundingClientRect();
            return {
                runtime: o.dataset.testid.replace('harness-option-', ''),
                // the modal dialog hides everything outside its scope from assistive tech
                ariaHidden: o.closest('[aria-hidden="true"]') != null,
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
            };
        })()`);
        if (option != null) {
            ctx.harnessPicked = option.runtime;
            await clickAt(option);
        }
        await settle(450);
        const afterPick = await h.ev(`(() => {
            const active = document.activeElement;
            return {
                focusInDialog: document.querySelector('[data-pet-peek]')?.contains(active) ?? false,
                focused: active?.getAttribute('data-testid') ?? active?.tagName ?? null,
                menuExpanded: document.querySelector(${JSON.stringify(PICKER)})?.getAttribute('aria-expanded') ?? null,
            };
        })()`);
        await press("Escape", "Escape", 27);
        const closedByOneEscape = await h.ev(`document.querySelector('[data-pet-peek]') == null`);
        rec(
            "5. the harness menu is in the dialog's aria scope, a pick returns focus inside the dialog, and one Escape then closes the popup",
            chip != null &&
                option?.ariaHidden === false &&
                afterPick.focusInDialog === true &&
                closedByOneEscape === true,
            JSON.stringify({ chip, option, afterPick, closedByOneEscape })
        );

        // the Final's fresh profile has no project, so the composer is disabled and `/` cannot focus it. Step 3
        // covered that branch above; register one now so step 6 exercises a live composer.
        const dest = await arrangeJarvisPeekDest(h, ctx);
        const busyArranged = await h.ev(`(() => {
            const store = globalThis.__wavePetStore;
            const panel = document.querySelector('[data-pet-peek]');
            if (typeof store?.setAttention !== 'function' || !panel) return false;
            store.setAttention([
                { key: 'dag-blocked:cdp-1', kind: 'dag-blocked', source: 'first blocked', text: 'The group is blocked.', action: 'Review', waitingsince: Date.now() - 120000, channelid: '', runid: 'cdp-1', phaseidx: 0 },
                { key: 'ask:cdp-2', kind: 'ask', source: 'second ask', text: 'Waiting on your reply', action: 'Answer', waitingsince: Date.now() - 60000, channelid: '', runid: 'cdp-2', phaseidx: 0 },
            ]);
            return true;
        })()`);
        await settle(450);
        const busyBefore = await h.ev(`(() => {
            const panel = document.querySelector('[data-pet-peek]');
            panel?.focus();
            const rect = panel?.getBoundingClientRect();
            return {
                shape: panel?.getAttribute('data-pet-peek-shape') ?? null,
                width: rect == null ? null : Math.round(rect.width),
                cursor: panel?.querySelector('[data-pet-cursor="true"]')?.closest('[data-pet-row]')?.getAttribute('data-pet-row') ?? null,
                focused: document.activeElement === panel,
            };
        })()`);
        await h.shot("cdp-shots/jarvis-peek-busy.png");
        const busyFloor = await paintEval(h, `return floorWalk([document.querySelector("[data-pet-peek]")]);`);
        await press("ArrowDown", "ArrowDown", 40);
        const movedCursor = await h.ev(`document.querySelector('[data-pet-cursor="true"]')?.closest('[data-pet-row]')?.getAttribute('data-pet-row') ?? null`);
        await press("/", "Slash", 191);
        const composerFocused = await h.ev(`document.activeElement?.hasAttribute('data-pet-errand-input') ?? false`);
        rec(
            "6. attention keeps the card's width and keyboard navigation moves the cursor then focuses the composer",
            dest.composerEnabled === true &&
                busyArranged === true &&
                busyBefore?.shape === "busy" &&
                busyBefore?.width === narrow?.width &&
                busyBefore?.cursor === "dag-blocked:cdp-1" &&
                busyBefore?.focused === true &&
                movedCursor === "ask:cdp-2" &&
                composerFocused === true,
            JSON.stringify({ dest, busyArranged, busyBefore, movedCursor, composerFocused })
        );

        await press("Escape", "Escape", 27);
        const escapeDismissed = await h.ev(`(() => ({
            panelGone: document.querySelector('[data-pet-peek]') == null,
            focusReturned: document.activeElement?.getAttribute('aria-label') === 'Jarvis condition',
        }))()`);

        await press("Enter", "Enter", 13);
        const closeClicked = await h.ev(`(() => {
            const close = document.querySelector('button[aria-label="Close Jarvis panel"]');
            if (!close) return false;
            close.click();
            return true;
        })()`);
        await settle(350);
        const closeDismissed = await h.ev(`(() => ({
            panelGone: document.querySelector('[data-pet-peek]') == null,
            focusReturned: document.activeElement?.getAttribute('aria-label') === 'Jarvis condition',
        }))()`);

        await press("Enter", "Enter", 13);
        const backdropClicked = await h.ev(`(() => {
            const backdrop = document.querySelector('[data-pet-peek-backdrop]');
            if (!backdrop) return false;
            backdrop.click();
            return true;
        })()`);
        await settle(350);
        const backdropDismissed = await h.ev(`(() => ({
            panelGone: document.querySelector('[data-pet-peek]') == null,
            focusReturned: document.activeElement?.getAttribute('aria-label') === 'Jarvis condition',
        }))()`);
        rec(
            "7. Escape, close, and backdrop dismiss only the peek and return focus to the creature",
            escapeDismissed.panelGone === true &&
                escapeDismissed.focusReturned === true &&
                closeClicked === true &&
                closeDismissed.panelGone === true &&
                closeDismissed.focusReturned === true &&
                backdropClicked === true &&
                backdropDismissed.panelGone === true &&
                backdropDismissed.focusReturned === true,
            JSON.stringify({ escapeDismissed, closeClicked, closeDismissed, backdropClicked, backdropDismissed })
        );
        const stayed = (await h.activeSurfaceLabel()) === SURFACE_LABEL.cockpit;
        rec("8. dismissing the global peek stays on the current surface", stayed, String(stayed));
        rec(`9. no visible text in the busy peek is under ${MIN_FONT_PX}px`, floorOk(busyFloor), floorDetail(busyFloor));

        // 10-11 run at the harness width. The items ride the DEV localStorage seam (attentionstore.ts) because
        // setAttention is overwritten by the next 10s poll; teardown removes the key.
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await settle(450);
        const waitingItem = (kind, key, action, over) =>
            JSON.stringify({ key, kind, source: `cdp ${kind}`, text: "x", action, waitingsince: Date.now() - 90000, channelid: "", runid: `cdp-${kind}`, phaseidx: 0, ...over });
        const SCAN_KEY = "workflow-scan:cdp-scan";
        const UNVERIFIED_KEY = "run-unverified:cdp-unverified";
        await h.ev(`localStorage.setItem(${JSON.stringify(JARVIS_PEEK_DEV_ITEMS_KEY)}, JSON.stringify([
            ${waitingItem("workflow-scan", SCAN_KEY, "Decide", { oref: "workflowscan:cdp-scan", runid: "cdp-scan" })},
            ${waitingItem("run-unverified", UNVERIFIED_KEY, "Review", { channelid: "cdp-channel" })},
        ]))`);
        await h.ev(`document.querySelector('[aria-label="Jarvis condition"]')?.focus()`);
        await press("Enter", "Enter", 13);
        const rowSel = (key) => `[data-pet-peek] [data-pet-row="${key}"]`;
        const rowsShown = await polishWaitFor(
            h,
            `document.querySelector(${JSON.stringify(rowSel(SCAN_KEY))}) != null && document.querySelector(${JSON.stringify(rowSel(UNVERIFIED_KEY))}) != null`,
            15000
        );
        const kindRows = await h.ev(`(() => {
            const read = (sel) => {
                const meta = document.querySelector(sel)?.querySelector('.font-mono');
                return meta == null ? null : { text: (meta.textContent || '').trim(), dot: meta.querySelector('span')?.className ?? '' };
            };
            return {
                title: (document.querySelector('[data-pet-peek] h2')?.textContent || '').trim(),
                scan: read(${JSON.stringify(rowSel(SCAN_KEY))}),
                unverified: read(${JSON.stringify(rowSel(UNVERIFIED_KEY))}),
            };
        })()`);
        const toned = (row, tone) => row != null && row.dot.includes(tone) && !row.dot.includes("bg-edge-strong");
        await h.shot("cdp-shots/jarvis-peek-kinds.png");
        rec(
            "10. a workflow scan and an unverified run read by name with a toned dot, under a title that counts runs or questions",
            rowsShown === true &&
                kindRows.scan?.text.startsWith("Workflow scan · ") === true &&
                kindRows.unverified?.text.startsWith("Unverified · ") === true &&
                toned(kindRows.scan, "bg-accent") &&
                toned(kindRows.unverified, "bg-warning") &&
                /^\d+ runs or questions waiting$/.test(kindRows.title),
            JSON.stringify({ rowsShown, kindRows })
        );

        const decideClicked = await h.ev(`(() => {
            const b = document.querySelector('[data-pet-peek] [data-pet-act="${SCAN_KEY}:open"]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        const onUsage = await polishWaitFor(h, `document.querySelector('[data-workflow-lens]') != null`, 8000);
        // the peek leaves through an exit animation
        const peekGone = await polishWaitFor(h, `document.querySelector('[data-pet-peek]') == null`, 4000);
        const landed = await h.ev(`(() => ({
            peekGone: ${peekGone},
            runSheet: document.querySelector('[data-jarvis-brief-band]') != null,
        }))()`);
        const landedSurface = await h.activeSurfaceLabel();
        rec(
            "11. Decide on the workflow scan lands on Usage > Workflow, not a run sheet",
            decideClicked === true && onUsage === true && landedSurface === SURFACE_LABEL.usage && landed.peekGone && !landed.runSheet,
            JSON.stringify({ decideClicked, onUsage, landedSurface, landed })
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setDeviceMetricsOverride", {
            width: 1600,
            height: 950,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await h.ev(`(() => {
            localStorage.removeItem(${JSON.stringify(JARVIS_PEEK_DEV_ITEMS_KEY)});
            document.querySelector('button[aria-label="Close Jarvis panel"]')?.click();
            globalThis.__wavePetStore?.setAttention([]);
            return true;
        })()`);
        if (ctx.harnessPicked != null && ctx.prevRoute != null && ctx.harnessPicked !== ctx.prevHarness) {
            try {
                await h.rpc("setconfig", {
                    "harness:preferredruntime": ctx.prevRoute.runtime,
                    "harness:preferredmodel": ctx.prevRoute.model,
                });
            } catch (e) {
                console.error(`jarvis-peek teardown: restore the harness preference failed: ${e?.message ?? e}`);
            }
        }
        await teardownJarvisPeekDest(h, ctx);
        await h.goto("cockpit");
    },
};

export const jarvisMotion = {
    name: "jarvis-motion",
    surface: "jarvis",
    async arrange(h) {
        // step 1 opens a channel's sheet. Its own, because an isolated store (the Final's) holds a channel only
        // when an earlier scenario left one
        const ctx = {
            id: `loose-end:cdp-motion:${Date.now()}`,
            cwd: mkdtempSync(join(tmpdir(), "verify-jarvis-motion-")),
        };
        try {
            ctx.channelId = (await h.rpc("createchannel", { name: "verify-jarvis-motion", projectpath: ctx.cwd })).oid;
        } catch (e) {
            ctx.channelError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);

        // 1. ModalShell variant="sheet" is `absolute z-20`, not the dialog's `fixed z-[70]` — that is
        //    what keeps a detail sheet scoped to the Brief and the nav rail reachable underneath it.
        //    Driven through the router because no fixture state carries a queue `nav`, so no fixture
        //    row is a button that opens anything.
        const channel = ctx.channelId != null ? { oid: ctx.channelId } : null;
        if (channel == null) {
            rec(
                "1. the sheet mounts inside a Brief-scoped backdrop",
                false,
                `the arrange could not create a channel: ${ctx.channelError}`
            );
        } else {
            await h.ev(`(async () => {
                for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                    await new Promise((r) => setTimeout(r, 250));
                }
                return window.__openAddress?.(${JSON.stringify(`channel:${channel.oid}`)});
            })()`);
            await settle(1200);
            const scoped = await h.ev(`(() => {
                const sheet = document.querySelector('[data-jarvis-brief-sheet]');
                // the panel IS the [role="dialog"]; the backdrop is the element it sits in
                const backdrop = sheet?.closest('[role="dialog"]')?.parentElement ?? null;
                const rail = document.querySelector('nav button[aria-label="Cockpit"]');
                const r = rail?.getBoundingClientRect();
                const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
                return {
                    sheet: sheet != null,
                    position: backdrop ? getComputedStyle(backdrop).position : null,
                    // the claim itself rather than a proxy for it: a click on the rail still lands there
                    railReachable: rail != null && hit != null && rail.contains(hit),
                };
            })()`);
            rec(
                "1. the sheet mounts inside a Brief-scoped backdrop, nav rail still hit-testable",
                scoped.sheet === true && scoped.position === "absolute" && scoped.railReachable === true,
                JSON.stringify(scoped)
            );
            await h.shot("cdp-shots/jarvis-motion-sheet.png");
            await h.ev(
                `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Close detail sheet')?.click()`
            );
            await settle(500);
        }

        // 2. freshness against a visit cursor older than the rows. The `normal` fixture's cursor is
        //    seven days back and every initiative and session row it carries is one to three days old,
        //    so each of those regions must mark, and must mark no more rows than it has. The `normal`
        //    fixture carries no wire attention, so this runs on a copy of it with the `attention` fixture's
        //    three waiting items (all newer than the cursor) plus one that predates the cursor: the queue
        //    must mark the three and not the old one. The old item's text is the handle the step finds it by.
        const OLD_WAITING = "Stale gate that predates your last visit";
        const WAITING_FIXTURE = "jarvisMotionWaiting";
        await lookEval(
            h,
            `
            const { BRIEFING_FIXTURES } = await mod("app/view/jarvis/briefingfixtures.ts");
            const { briefingFixtureAtom } = await mod("app/view/jarvis/briefingstore.ts");
            const normal = BRIEFING_FIXTURES.normal;
            const old = {
                ...BRIEFING_FIXTURES.attention.attention[0],
                key: "run-land-held:r-stale",
                text: ${JSON.stringify(OLD_WAITING)},
                waitingsince: normal.load.snapshot.actualCursor - 24 * 60 * 60 * 1000,
            };
            BRIEFING_FIXTURES[${JSON.stringify(WAITING_FIXTURE)}] = {
                ...normal,
                attention: [...BRIEFING_FIXTURES.attention.attention, old],
            };
            (await mod("app/store/jotaiStore.ts")).globalStore.set(briefingFixtureAtom, ${JSON.stringify(WAITING_FIXTURE)});
        `
        );
        await settle(900);
        // the queue's rows draw only while its summary is open, and the open state outlives a scenario
        await h.ev(`document.querySelector('[data-jarvis-brief-attention-summary][aria-expanded="false"]')?.click()`);
        await settle(600);
        const TALLY = `(() => {
            const per = {};
            document.querySelectorAll('[data-jarvis-brief-row]').forEach((r) => {
                const k = r.dataset.jarvisBriefRow;
                per[k] = per[k] || { rows: 0, marked: 0 };
                per[k].rows += 1;
                if (r.classList.contains('fresh-mark')) per[k].marked += 1;
            });
            return per;
        })()`;
        const marked = await h.ev(TALLY);
        const region = (k) => marked[k] ?? { rows: 0, marked: 0 };
        // a queue row's mark by the wire item it came from: every item newer than the cursor marked, the older
        // one not. Blocked-chunk rows are not wire items, so they are left to the region tally.
        const waitingMarks = await lookEval(
            h,
            `
            const { BRIEFING_FIXTURES } = await mod("app/view/jarvis/briefingfixtures.ts");
            const fx = BRIEFING_FIXTURES[${JSON.stringify(WAITING_FIXTURE)}];
            const cursor = fx.load.snapshot.actualCursor;
            const rows = [...document.querySelectorAll('[data-jarvis-brief-row="queue"]')];
            return fx.attention.map((a) => {
                const row = rows.find((r) => (r.innerText || "").includes(a.text));
                return { newer: a.waitingsince >= cursor, found: row != null, marked: row?.classList.contains("fresh-mark") === true };
            });
        `
        );
        rec(
            "2. rows newer than the visit cursor carry the freshness mark, in the queue too, and the older queue row does not",
            region("initiative").marked > 0 &&
                region("session").marked > 0 &&
                waitingMarks.some((w) => w.newer) &&
                waitingMarks.some((w) => !w.newer) &&
                waitingMarks.every((w) => w.found && w.marked === w.newer),
            JSON.stringify({ ...marked, waitingMarks })
        );
        await h.shot("cdp-shots/jarvis-motion-fresh.png");

        // 3. the cap, per region. freshrows.ts suppresses the mark entirely above FRESH_MARK_CAP,
        //    because a week away that lights up every row is decoration rather than a reading aid.
        //    Asserted per region, not in total: the three marked regions each call freshKeys with
        //    their own list, so the cap is three separate budgets and a summed check would be wrong.
        const FRESH_MARK_CAP = 6;
        const capped =
            region("queue").rows > 0 && ["queue", "initiative", "session"].every((k) => region(k).marked <= FRESH_MARK_CAP);
        rec(
            `3. no region marks more than ${FRESH_MARK_CAP} rows, and the queue region has rows to cap`,
            capped,
            JSON.stringify({ cap: FRESH_MARK_CAP, ...marked })
        );

        // 4. the negative. The plan asked for a fixture whose rows all PREDATE the cursor; no fixture
        //    supplies one — every loaded state hangs its timestamps one to three days off `now` while
        //    the cursor sits seven days back. So the deterministic negative the design actually states
        //    stands in for it: the `behind` region is since-your-last-visit by construction, which is
        //    why it is excluded from the mark — marking it would mark every row, and the region's own
        //    label already says the thing the mark would be saying. `empty` is kept alongside it as
        //    the near-trivial case: no project rows, only the fixture's one working direct agent
        //    (briefingfixtures.ts, there since 7dcdfdd8e), started minutes ago and so fresh. Every mark
        //    must sit on a row the tally counts and every row there must carry one: no mark leaks.
        const behind = region("delta").marked + region("shipped").marked;
        rec(
            "4. the behind region carries no mark, though every row in it postdates the cursor",
            behind === 0 && region("delta").rows + region("shipped").rows > 0,
            JSON.stringify({ delta: region("delta"), shipped: region("shipped") })
        );

        await h.ev(`document.querySelector('[data-briefing-fixture="empty"]')?.click()`);
        await settle(700);
        await lookEval(
            h,
            `delete (await mod("app/view/jarvis/briefingfixtures.ts")).BRIEFING_FIXTURES[${JSON.stringify(WAITING_FIXTURE)}];`
        );
        const emptyMarks = await h.ev(`document.querySelectorAll('.fresh-mark').length`);
        const emptyTally = await h.ev(TALLY);
        const emptyRegions = Object.keys(emptyTally);
        const emptyMarked = emptyRegions.reduce((n, k) => n + emptyTally[k].marked, 0);
        rec(
            "5. the empty state marks its one live agent and nothing else",
            emptyRegions.length === 1 &&
                emptyRegions[0] === "session" &&
                emptyTally.session.rows === 1 &&
                emptyTally.session.marked === 1 &&
                emptyMarks === emptyMarked,
            JSON.stringify({ marks: emptyMarks, ...emptyTally })
        );

        // 6. the updates drawer. Task 14 moved the scroll container to an inner div: paneReveal
        //    animates the outer element's height and needs overflow-hidden there, which on the same
        //    element would fight overflow-y-auto and clip the scrollbar mid-tween. TWO injected pet
        //    events guarantee the drawer exists at all: the peek gives the newest update its own
        //    LatestUpdate row and the drawer holds only updates.slice(1), so one event fills the
        //    former and leaves the latter unmounted. One used to be enough because the pet had other
        //    update sources; those were memory-derived and went with the memvault removal.
        await h.ev(`(() => {
            document.querySelector('button[aria-label="Close Jarvis panel"]')?.click();
            return true;
        })()`);
        await settle(200);
        const pushed = await h.ev(`(() => {
            const mod = globalThis.__wavePetStore;
            if (mod == null) return "petstore test hook not exposed (dev build?)";
            for (const n of [1, 2]) {
                mod.pushPetEvent({
                    id: ${JSON.stringify(ctx.id)} + ":" + n,
                    at: Date.now() + n,
                    kind: "loose-end",
                    text: "CDP motion probe " + n + " - untouched for 21 days",
                    sources: [{ ref: "task:cdp-motion-" + n, title: "CDP motion probe " + n, sourceType: "dossier" }],
                });
            }
            // and the busy shape, which is the only one that renders the drawer: the quiet card keeps the
            // latest update alone. Cleared in teardown.
            if (typeof mod.setAttention !== "function") return "petstore setAttention hook not exposed";
            mod.setAttention([
                { key: "dag-blocked:cdp-motion", kind: "dag-blocked", source: "CDP motion block", text: "The group is blocked.", action: "Review", waitingsince: Date.now() - 120000, channelid: "", runid: "cdp-motion", phaseidx: 0 },
            ]);
            return true;
        })()`);
        await settle(400);
        await h.ev(`document.querySelector('[aria-label="Jarvis condition"]')?.click()`);
        await settle(300);
        const DRAWER = `(() => {
            const box = document.querySelector('[data-pet-updates]');
            const toggle = box?.querySelector('button[aria-expanded]');
            // the revealing element is the toggle's sibling; the scroller is its only child
            const pane = toggle?.nextElementSibling ?? null;
            const scroller = pane?.firstElementChild ?? null;
            return {
                expanded: toggle?.getAttribute('aria-expanded') ?? null,
                rows: scroller ? scroller.children.length : 0,
                paneOverflow: pane ? getComputedStyle(pane).overflow : null,
                scrollerOverflowY: scroller ? getComputedStyle(scroller).overflowY : null,
            };
        })()`;
        const shut = await h.ev(DRAWER);
        await h.ev(`(() => {
            const toggle = document.querySelector('[data-pet-updates] button[aria-expanded]');
            if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
            return true;
        })()`);
        await settle(500);
        const opened = await h.ev(DRAWER);
        rec(
            "6. the drawer toggles its updates list, height on the outside and the scroller within",
            pushed === true &&
                shut.expanded === "false" &&
                shut.rows === 0 &&
                opened.expanded === "true" &&
                opened.rows > 0 &&
                opened.paneOverflow === "hidden" &&
                opened.scrollerOverflowY === "auto",
            JSON.stringify({ pushed, shut, opened })
        );
        await h.shot("cdp-shots/jarvis-motion-drawer.png");

        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(`(() => {
            // the injected utterance advanced a PERSISTED watermark, so leaving it moved is a side
            // effect on the user's own creature rather than a test (jarvis-volunteer's rule)
            document.querySelector('button[aria-label="Close Jarvis panel"]')?.click();
            // the injected gate is what put the peek in its busy shape; left behind it would follow the
            // user out of the run as a waiting item that nothing can answer
            globalThis.__wavePetStore?.setAttention?.([]);
            try {
                globalThis.localStorage?.removeItem("wave:pet.watermark");
                globalThis.localStorage?.removeItem("jarvis.subject.last");
            } catch {}
            return true;
        })()`);
        if (ctx?.channelId) await h.rpc("deletechannel", { channelid: ctx.channelId });
        if (ctx?.cwd) rmSync(ctx.cwd, { recursive: true, force: true });
        await h.goto("cockpit");
    },
};
