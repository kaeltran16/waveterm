// Shared CDP transport for the verification harness — one pickTarget + websocket wrapper, instead of the
// copy per one-off driver this replaced. Requires the dev app running with the debug flag (dev-only in
// src-tauri/src/main.rs): --remote-debugging-port=9222.
// Node 21+ (global WebSocket + fetch; the repo runs Node 24).
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

// SurfaceKey -> nav-rail label, mirrored from frontend/app/view/agents/navrail.tsx ITEMS. goto clicks
// the nav button by label because globalStore/the agents model are NOT exposed on window (boot-core
// exposes only globalAtoms/globalWS/TabRpcClient) — the nav click is the proven, app-change-free way
// to switch surfaces. Note: the "files" surface is labelled "Diff".
export const SURFACE_LABEL = {
    cockpit: "Cockpit",
    jarvis: "Jarvis",
    agent: "Agent",
    sessions: "Sessions",
    files: "Diff",
    usage: "Usage",
    code: "Code",
    settings: "Settings",
    setup: "Setup",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a reloaded cockpit took ~2.6s to render its nav in run 5d24e7b8's Final, past the fixed 2.5s a teardown waited
const NAV_WAIT_MS = 30_000;
const NAV_POLL_MS = 250;
const NAV_RENDERED = `!!document.querySelector("nav button")`;

// polls expr until it is truthy, false past ms. An evaluate that throws counts as not yet: a reload destroys the
// execution context mid-boot.
export async function waitFor(ev, expr, ms, pollMs = NAV_POLL_MS) {
    for (const start = Date.now(); ; ) {
        if (await ev(expr).catch(() => false)) return true;
        if (Date.now() - start >= ms) return false;
        await sleep(pollMs);
    }
}

// A single CDP command must never hang the whole run: if the socket drops mid-command (dev app HMR
// teardown / exit), the reply never arrives and a bare `await` would block forever. Bound every
// command so a drop surfaces as an error. 30s is far above any real CDP round-trip.
const CMD_TIMEOUT_MS = 30_000;

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        let closed = false;
        const pending = new Map();
        const failAll = (err) => {
            for (const p of pending.values()) p.reject(err);
            pending.clear();
        };
        ws.addEventListener("open", () =>
            resolve({
                send: (method, params = {}) => {
                    if (closed) return Promise.reject(new Error(`CDP socket closed; cannot send ${method}`));
                    const msgId = ++id;
                    ws.send(JSON.stringify({ id: msgId, method, params }));
                    return new Promise((res, rej) => {
                        const timer = setTimeout(() => {
                            pending.delete(msgId);
                            rej(new Error(`CDP ${method} timed out after ${CMD_TIMEOUT_MS}ms`));
                        }, CMD_TIMEOUT_MS);
                        pending.set(msgId, {
                            method,
                            resolve: (v) => {
                                clearTimeout(timer);
                                res(v);
                            },
                            reject: (e) => {
                                clearTimeout(timer);
                                rej(e);
                            },
                        });
                    });
                },
                close: () => ws.close(),
            })
        );
        // error can fire before open (ws refused) or after (drop). reject() is a no-op once resolved;
        // failAll unblocks any in-flight commands so callers see an error instead of hanging.
        ws.addEventListener("error", (e) => {
            const err = new Error(`CDP socket error: ${e?.message ?? e?.error?.message ?? "connection failed"}`);
            reject(err);
            failAll(err);
        });
        ws.addEventListener("close", () => {
            closed = true;
            failAll(new Error("CDP socket closed (dev app went away — HMR teardown or exit?)"));
        });
        ws.addEventListener("message", (e) => {
            let msg;
            try {
                msg = JSON.parse(e.data);
            } catch {
                return; // ignore non-JSON frames rather than crashing the listener
            }
            const p = msg.id && pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(`CDP ${p.method} failed: ${msg.error.message ?? "error"}`));
            else p.resolve(msg.result);
        });
    });
}

// the attention popup is a second page target on the app's origin (frontend/app/view/agents/attentionpopup.ts POPUP_PAGE)
const POPUP_PAGE = "popup.html";

const pageUrl = (t) => (t.url ?? "").split(/[?#]/)[0];

// a window that has not navigated yet: the popup's cannot be told from the main one's until one of them has
const isBlank = (t) => !t.url || t.url === "about:blank";

// a starting app answers CDP with both windows still blank; a cold vite takes a while to serve the first page
const BLANK_WAIT_MS = 60_000;
const BLANK_POLL_MS = 500;

// the main page: never the popup's, which matches every pattern the cockpit's does, and a loaded page before a
// blank one, which may be the popup's
export function pickTarget(targets) {
    const pages = targets.filter((t) => t.type === "page" && !pageUrl(t).endsWith(POPUP_PAGE));
    return (
        pages.find((t) => /localhost:5174|wave|arc/i.test(t.url ?? "")) ?? pages.find((t) => !isBlank(t)) ?? pages[0]
    );
}

async function listTargets(port) {
    let res;
    try {
        res = await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
    } catch (e) {
        // ECONNREFUSED (dev app down / debug flag off) or timeout is the common failure. Turn undici's
        // opaque "fetch failed" into an actionable message instead of an unhandled-rejection stack.
        const why = e?.cause?.code ?? e?.code ?? e?.name ?? "unreachable";
        throw new Error(
            `cannot reach CDP on :${port} (${why}) — is the dev app running with the debug flag? ` +
                `(task dev; the flag is dev-only in src-tauri/src/main.rs)`
        );
    }
    return res.json();
}

// one page target's session. Its shots land in the list the caller passes, so every page of a run shares one.
async function openPage(target, shots) {
    const client = await connect(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    async function ev(expr) {
        const x = await client.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
        if (x.exceptionDetails) {
            throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text);
        }
        return x.result?.value;
    }

    return {
        url: target.url,
        ev,
        // raw CDP passthrough: Runtime.evaluate covers most driving, but Emulation (deterministic shot
        // size) and Input.dispatchKeyEvent (real key events, not synthetic DOM ones) have no wrapper.
        cdp: (method, params) => client.send(method, params),
        async shot(outPath) {
            const { data } = await client.send("Page.captureScreenshot", { format: "png" });
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, Buffer.from(data, "base64"));
            const png = basename(outPath);
            shots.push({ name: png.replace(/\.png$/, ""), png, path: outPath });
        },
        close: () => client.close(),
    };
}

export async function attach(port = 9222) {
    let target = pickTarget(await listTargets(port));
    for (const start = Date.now(); target && isBlank(target) && Date.now() - start < BLANK_WAIT_MS; ) {
        await sleep(BLANK_POLL_MS);
        target = pickTarget(await listTargets(port));
    }
    if (!target) {
        throw new Error(
            `no page target on :${port} — is the dev app running with the debug flag? ` +
                `(task dev; the flag is dev-only in src-tauri/src/main.rs)`
        );
    }
    const shots = [];
    const main = await openPage(target, shots);
    const { ev } = main;

    return {
        ...main,
        shots,
        // a second page of the app by a part of its url (the attention popup is "popup.html"): the same ev, cdp,
        // shot and close, with its shots in this run's list
        async page(urlPart) {
            const targets = await listTargets(port);
            const other = targets.find((t) => t.type === "page" && (t.url ?? "").includes(urlPart));
            if (!other) {
                const urls = targets.filter((t) => t.type === "page").map((t) => t.url);
                throw new Error(`no page target on :${port} with "${urlPart}" in its url (pages: ${urls.join(", ") || "none"})`);
            }
            return openPage(other, shots);
        },
        rpc: (command, data, opts) =>
            ev(
                `window.TabRpcClient.wshRpcCall(${JSON.stringify(command)}, ${JSON.stringify(data ?? null)}, ${JSON.stringify(opts ?? {})})`
            ),
        // reloads the page and resolves once the new one has booted: the old window's marker is gone with it, and
        // the nav has rendered. Polling the nav alone could read the old page before the reload commits.
        async reload() {
            await ev("window.__cdpReloading = true; location.reload()");
            const booted = await waitFor(ev, `!window.__cdpReloading && ${NAV_RENDERED}`, NAV_WAIT_MS);
            if (!booted) throw new Error(`the page did not render its nav within ${NAV_WAIT_MS / 1000}s of a reload`);
        },
        async goto(surface) {
            const label = SURFACE_LABEL[surface];
            if (!label) throw new Error(`unknown surface "${surface}"`);
            // a page still booting from a reload has no nav yet; a missing label on a rendered nav still fails at once
            await waitFor(ev, NAV_RENDERED, NAV_WAIT_MS);
            // aria-label first: the nav rail drops its visible labels below a narrow window
            // (view/agents/navrailwidth.ts), so matching on text alone cannot navigate a narrow app.
            const clicked = await ev(`(() => {
                const want = ${JSON.stringify(label)};
                const b = [...document.querySelectorAll('nav button')]
                    .find((x) => x.getAttribute('aria-label') === want || (x.textContent || '').trim() === want);
                if (!b) return false;
                b.click();
                return true;
            })()`);
            if (!clicked) throw new Error(`nav button "${label}" not found for surface "${surface}"`);
            await sleep(800); // settle before asserting/screenshotting
        },
        activeSurfaceLabel: () =>
            ev(`(() => {
                const b = [...document.querySelectorAll('nav button')]
                    .find((x) => (x.className || '').includes('text-accent-soft'));
                if (!b) return null;
                // same reason as goto: the visible label is absent on a narrow rail
                return b.getAttribute('aria-label') || (b.textContent || '').trim();
            })()`),
    };
}
