// Jira fixtures for the CDP scenarios (docs/superpowers/plans/2026-11-03-jira-integration.md, decision 18): a fake
// Jira Cloud served from this process on 127.0.0.1, which the dev app's real Go client (pkg/jira) talks to once
// connectFakeJira points jira:site at it, plus the seeding, motion-sampling and reduced-motion helpers the Jira
// scenarios share. The seeded issues are the Main board's four, with the Initiative board's description and
// acceptance criteria on PAY-318.
import { createServer } from "node:http";

export const JIRA_SECRET = "JIRA_API_TOKEN";
export const FAKE_JIRA_EMAIL = "verify@example.com";
export const FAKE_JIRA_TOKEN = "verify-fake-jira-token";
export const FAKE_JIRA_NAME = "Verify Fixture";
export const AC_FIELD = "customfield_10050";

const SITE_KEY = "jira:site";
const EMAIL_KEY = "jira:email";
const HOUR_MS = 3_600_000;
const NOT_AUTHENTICATED = "Client must be authenticated to access this resource.";
const NO_ISSUE = "Issue does not exist or you do not have permission to see it.";
const MOVE_REFUSED = "You do not have permission to transition this issue.";

// status name -> Jira status category key, and the transition id that moves an issue into it
const STATUSES = {
    "To Do": { category: "new", transition: "11" },
    "In Progress": { category: "indeterminate", transition: "21" },
    "In Review": { category: "indeterminate", transition: "31" },
    Done: { category: "done", transition: "41" },
};

const adfText = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const adfDoc = (...content) => ({ type: "doc", version: 1, content });
const adfBullets = (items) => ({ type: "bulletList", content: items.map((t) => ({ type: "listItem", content: [adfText(t)] })) });

export const PAY_318_DESCRIPTION =
    "When a partner endpoint answers 429 Too Many Requests we drop the delivery. Partners on the Growth plan rate-limit " +
    "at 20 req/s and lose events during settlement bursts, which shows up as missing payouts the next morning.";
export const PAY_318_CRITERIA = [
    "429 responses are retried with backoff and honour Retry-After",
    "A delivery gives up after 6 attempts and is marked failed",
    "Failed deliveries show on the partner dashboard",
];

function seedIssues(now) {
    const issue = (key, summary, type, status, agoHours, description = null, criteria = null) => ({
        key,
        summary,
        type,
        status,
        updated: new Date(now - agoHours * HOUR_MS).toISOString(),
        description: description == null ? null : adfDoc(adfText(description)),
        criteria: criteria == null ? null : adfDoc(adfBullets(criteria)),
    });
    return {
        "PAY-318": issue("PAY-318", "Retry webhook delivery when the partner returns 429", "Story", "To Do", 2, PAY_318_DESCRIPTION, PAY_318_CRITERIA),
        "PAY-311": issue("PAY-311", "Settlement report drops refunds issued after cutoff", "Bug", "In Progress", 24),
        "OPS-77": issue("OPS-77", "Rotate the staging database credentials into the secret store", "Task", "To Do", 72),
        "GROW-12": issue("GROW-12", "Export the onboarding funnel as a weekly CSV", "Story", "To Do", 5),
    };
}

function issueJson(issue) {
    return {
        id: issue.key,
        key: issue.key,
        fields: {
            summary: issue.summary,
            issuetype: { name: issue.type },
            status: { name: issue.status, statusCategory: { key: STATUSES[issue.status]?.category ?? "new" } },
            updated: issue.updated,
            description: issue.description,
            [AC_FIELD]: issue.criteria,
        },
    };
}

function transitionsFor(issue) {
    return Object.entries(STATUSES)
        .filter(([name]) => name !== issue.status)
        .map(([name, s]) => ({ id: s.transition, name, to: { name, statusCategory: { key: s.category } } }));
}

function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body == null ? "" : JSON.stringify(body));
}

const refuse = (res, status, message) => send(res, status, { errorMessages: [message], errors: {} });

function readBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            try {
                resolve(raw ? JSON.parse(raw) : null);
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

function authorized(req, state) {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Basic ")) return false;
    return Buffer.from(header.slice("Basic ".length), "base64").toString("utf8") === `${state.email}:${state.token}`;
}

async function route(req, res, state, baseUrl) {
    const url = new URL(req.url, baseUrl);
    const path = url.pathname;
    state.calls.push(`${req.method} ${path}`);
    if (state.refuse != null) return refuse(res, state.refuse.status, state.refuse.message);
    if (!authorized(req, state)) return refuse(res, 401, NOT_AUTHENTICATED);
    if (req.method === "GET" && path === "/rest/api/3/myself") {
        return send(res, 200, { accountId: "verify", displayName: state.displayName, emailAddress: state.email });
    }
    if (req.method === "GET" && path === "/rest/api/3/field") {
        return send(res, 200, [
            { id: "summary", name: "Summary", custom: false },
            { id: "description", name: "Description", custom: false },
            { id: AC_FIELD, name: "Acceptance Criteria", custom: true },
        ]);
    }
    if (req.method === "POST" && path === "/rest/api/3/search/jql") {
        await readBody(req);
        const open = Object.values(state.issues).filter((i) => STATUSES[i.status]?.category !== "done");
        return send(res, 200, { issues: open.map(issueJson), isLast: true });
    }
    const m = /^\/rest\/api\/3\/issue\/([^/]+)(\/transitions|\/comment)?$/.exec(path);
    if (m == null) return refuse(res, 404, `fake Jira does not serve ${req.method} ${path}`);
    const issue = state.issues[decodeURIComponent(m[1]).toUpperCase()];
    if (issue == null) return refuse(res, 404, NO_ISSUE);
    const sub = m[2] ?? "";
    if (req.method === "GET" && sub === "") return send(res, 200, issueJson(issue));
    if (req.method === "GET" && sub === "/transitions") return send(res, 200, { transitions: transitionsFor(issue) });
    if (req.method === "POST" && sub === "/transitions") {
        const id = String((await readBody(req))?.transition?.id ?? "");
        const fail = state.failTransition[id];
        if (fail) return refuse(res, 400, typeof fail === "string" ? fail : MOVE_REFUSED);
        const to = transitionsFor(issue).find((t) => t.id === id);
        if (to == null) return refuse(res, 400, `Transition id '${id}' is not valid for this issue.`);
        issue.status = to.name;
        return send(res, 204, null);
    }
    if (req.method === "POST" && sub === "/comment") {
        const body = (await readBody(req))?.body ?? null;
        const id = String(10000 + state.comments.length);
        state.comments.push({ key: issue.key, id, body });
        return send(res, 201, { id, self: `${baseUrl}/rest/api/3/issue/${issue.key}/comment/${id}`, body });
    }
    return refuse(res, 405, `fake Jira does not serve ${req.method} ${path}`);
}

// A fake Jira Cloud. state is live: a scenario edits it (issues, refuse, failTransition) between steps, and reads
// what the app did from calls and comments.
export async function startFakeJira(opts = {}) {
    const state = {
        email: opts.email ?? FAKE_JIRA_EMAIL,
        token: opts.token ?? FAKE_JIRA_TOKEN,
        displayName: opts.displayName ?? FAKE_JIRA_NAME,
        issues: seedIssues(opts.now ?? Date.now()),
        refuse: null, // { status, message }: every call answers with it
        failTransition: {}, // transition id -> true or Jira's message: that move answers 400
        comments: [],
        calls: [],
    };
    let baseUrl = "";
    const server = createServer((req, res) => {
        route(req, res, state, baseUrl).catch((e) => refuse(res, 500, `fake Jira failed: ${e?.message ?? e}`));
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        url: baseUrl,
        state,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function rememberJira(h) {
    const settings = (await h.rpc("getfullconfig", null))?.settings ?? {};
    const names = (await h.rpc("getsecretsnames", null)) ?? [];
    return { site: settings[SITE_KEY] ?? null, email: settings[EMAIL_KEY] ?? null, hadToken: names.includes(JIRA_SECRET) };
}

// The token's value never comes back over RPC (by design), so one that was there before cannot be put back: the
// restore removes it and says so, rather than leave the fixture's token behind.
async function restoreJira(h, prev) {
    await h.rpc("setconfig", { [SITE_KEY]: prev.site, [EMAIL_KEY]: prev.email });
    await h.rpc("setsecrets", { [JIRA_SECRET]: null });
    if (prev.hadToken) {
        console.error(`jira fixtures: ${JIRA_SECRET} was set before the scenario and cannot be read back; it is now removed`);
    }
}

// Points the dev app at the fake: jira:site, jira:email and the token. Returns the restore.
export async function connectFakeJira(h, fake) {
    const prev = await rememberJira(h);
    await h.rpc("setconfig", { [SITE_KEY]: fake.url, [EMAIL_KEY]: fake.state.email });
    await h.rpc("setsecrets", { [JIRA_SECRET]: fake.state.token });
    return () => restoreJira(h, prev);
}

// Clears all three, for the not-set-up states. Returns the restore.
export async function disconnectJira(h) {
    const prev = await rememberJira(h);
    await h.rpc("setconfig", { [SITE_KEY]: null, [EMAIL_KEY]: null });
    await h.rpc("setsecrets", { [JIRA_SECRET]: null });
    return () => restoreJira(h, prev);
}

// An initiative on a ticket, with its last-seen copy: chunks are labels or { label, status, note }. The show lands
// the copy the way an agent's `wsh jira show` would, so the fake must be connected first.
export async function seedTicketedInitiative(h, { title, project, key, chunks = [] }) {
    const seeds = chunks.map((c) => (typeof c === "string" ? { label: c } : c));
    const { effortoid } = await h.rpc("effortcreate", {
        title,
        project,
        ticket: key,
        chunks: seeds.map((c) => ({ label: c.label })),
    });
    const ops = seeds
        .filter((c) => c.status != null && c.status !== "pending")
        .map((c) => ({ op: "setChunkStatus", chunk: c.label, status: c.status, ...(c.note ? { note: c.note } : {}) }));
    if (ops.length > 0) {
        await h.rpc("effortmutate", { effortoid, author: "you", ops });
    }
    await h.rpc("jirashow", { key, via: "show" });
    return effortoid;
}

// Computed styles of the first element matching selector, sampled once per animation frame for ms while trigger (a
// page-side expression) runs. A frame where the element is missing has present: false.
export function motionSamples(h, { selector, props, ms, trigger }) {
    return h.ev(`new Promise((resolve) => {
        const props = ${JSON.stringify(props)};
        const frames = [];
        const t0 = performance.now();
        const tick = () => {
            const el = document.querySelector(${JSON.stringify(selector)});
            const frame = { t: Math.round(performance.now() - t0), present: el != null };
            if (el != null) {
                const cs = getComputedStyle(el);
                for (const p of props) frame[p] = cs.getPropertyValue(p);
            }
            frames.push(frame);
            if (performance.now() - t0 < ${Number(ms)}) requestAnimationFrame(tick);
            else resolve(frames);
        };
        requestAnimationFrame(tick);
        (async () => { ${trigger}; })().catch((e) => frames.push({ t: -1, error: String(e?.message ?? e) }));
    })`);
}

const REDUCED_MOTION_SETTLE_FRAMES = 2;
const REDUCED_MOTION_MAX_FRAMES = 120;

// Runs fn with prefers-reduced-motion: reduce emulated, and always clears the emulation.
export async function withReducedMotion(h, fn) {
    await h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    try {
        const applied = await h.ev(`new Promise((resolve) => {
            let seen = 0;
            let frames = 0;
            const poll = () => {
                if (matchMedia("(prefers-reduced-motion: reduce)").matches) seen++;
                if (seen >= ${REDUCED_MOTION_SETTLE_FRAMES}) resolve(true);
                else if (++frames >= ${REDUCED_MOTION_MAX_FRAMES}) resolve(false);
                else requestAnimationFrame(poll);
            };
            requestAnimationFrame(poll);
        })`);
        if (!applied) throw new Error("prefers-reduced-motion: reduce never matched in the page");
        return await fn();
    } finally {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] });
    }
}
