// Renders the Jarvis Brief handoff design (docs/prototype/jarvis-brief-editing.dc.html, variant A) in
// each of its states, headlessly, into cdp-shots/design/<state>.png — the reference half of the
// side-by-side parity review. No dev app needed: it serves a patched copy of the design over node:http
// and shoots it with headless Chrome.
// Usage: node scripts/cdp/design-states.mjs [state...]   (CHROME=<path> overrides the browser)
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const DESIGN = "docs/prototype/jarvis-brief-editing.dc.html";
const SUPPORT = "docs/prototype/support.js";
const OUT_DIR = resolve("cdp-shots/design");
// async, not execFileSync: a blocked event loop would starve the in-process server chrome fetches from
const execFileAsync = promisify(execFile);

// Each state is a set of overrides appended to the design's initial state object: a later duplicate
// key wins, so the design's own defaults stay the baseline. "crx" is the id seed() gives N1 box upgrade.
const STATES = {
    default: "",
    waiting: 'openInit: null, waitingOpen: true,',
    sidebar: 'sel: { iid: "i1", cid: "crx" },',
    menu: 'menu: "crx",',
    stagemenu: 'menu: "stage:i1|Phase 2 · upgrade",',
    confirm: 'confirmDel: "i1",',
    runorch: 'openInit: null, runSel: "s2",',
    runask: 'openInit: null, runSel: "s3",',
    rundone: 'openInit: null, runSel: "s5",',
    runquickdone: 'openInit: null, runSel: "s4",',
    modalinit: 'modal: "initiative",',
    modalrun: 'modal: "run",',
    modalprofile: 'modal: "profile",',
    record: 'openInit: null, recSel: "dos-221",',
};

const STATE_ANCHOR = "recSel: null, recPicker: false, recPending: null,\n  };";
const SHELL_OPEN = /<dc-import name="Window Shell"[^>]*>/;
const SHELL_CLOSE = "</dc-import>";

function chromePath() {
    if (process.env.CHROME) return process.env.CHROME;
    const candidates = [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
    ];
    const found = candidates.find((p) => existsSync(p));
    if (!found) throw new Error("no Chrome found; set CHROME=<path to chrome or msedge>");
    return found;
}

// The shell is a separate design file that is not in the repo, so the wrapper becomes a plain div.
// Fail loudly if an anchor moved: a silently unpatched page would shoot the default state every time.
function patchedDesign(overrides) {
    let html = readFileSync(DESIGN, "utf8");
    if (!SHELL_OPEN.test(html) || !html.includes(SHELL_CLOSE)) throw new Error(`${DESIGN}: Window Shell wrapper not found`);
    if (!html.includes(STATE_ANCHOR)) throw new Error(`${DESIGN}: state anchor not found`);
    html = html.replace(SHELL_OPEN, '<div style="position:relative;height:100%">').replace(SHELL_CLOSE, "</div>");
    if (overrides) html = html.replace(STATE_ANCHOR, `recSel: null, recPicker: false, recPending: null,\n    ${overrides}\n  };`);
    return html;
}

function serve(dir) {
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    const server = createServer((req, res) => {
        const name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
        const file = join(dir, name);
        if (!name || name.includes("..") || !existsSync(file)) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { "content-type": types[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream" });
        res.end(readFileSync(file));
    });
    return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const unknown = only.filter((s) => !(s in STATES));
if (unknown.length) {
    console.error(`unknown state(s) ${unknown.join(", ")}. available: ${Object.keys(STATES).join(", ")}`);
    process.exit(2);
}
const chosen = only.length ? only : Object.keys(STATES);

const chrome = chromePath();
const dir = mkdtempSync(join(tmpdir(), "design-states-"));
copyFileSync(SUPPORT, join(dir, "support.js"));
for (const name of chosen) writeFileSync(join(dir, `${name}.html`), patchedDesign(STATES[name]));
mkdirSync(OUT_DIR, { recursive: true });

const server = await serve(dir);
const { port } = server.address();
let failed = 0;
try {
    // sequential on purpose: parallel headless runs share a profile and write identical PNGs
    for (const name of chosen) {
        const out = join(OUT_DIR, `${name}.png`);
        rmSync(out, { force: true });
        const profile = join(dir, `profile-${name}`);
        try {
            await execFileAsync(
                chrome,
                [
                    "--headless=new",
                    "--disable-gpu",
                    "--hide-scrollbars",
                    `--user-data-dir=${profile}`,
                    "--window-size=1440,900",
                    "--virtual-time-budget=9000",
                    `--screenshot=${out}`,
                    `http://127.0.0.1:${port}/${name}.html`,
                ],
                { timeout: 60_000 }
            );
        } catch {
            // chrome can exit nonzero after writing the shot; the file is the verdict
        }
        const ok = existsSync(out);
        if (!ok) failed++;
        console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(13)} ${ok ? out : "(no screenshot written)"}`);
    }
} finally {
    server.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
