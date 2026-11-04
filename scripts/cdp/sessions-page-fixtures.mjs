// Sessions fixtures that live in the page, so a scenario writes nothing into ~/.claude/projects.
// fixtureSession / fixtureRun / tailLines are pure (Node, tested beside this file). The install* and stub* helpers
// run in the page through h.ev: they replace RpcApi commands and hold wave objects in the WOS cache, and
// restoreSessions puts every one back.

import { randomUUID } from "node:crypto";

const FIXTURE_DIR = "C:\\arc-verify-sessions-fixture";

export function fixtureSession(overrides = {}) {
    const id = overrides.id ?? randomUUID();
    const now = Date.now();
    return {
        id,
        runtime: "claude",
        projectpath: "C:\\arc-verify-sessions-fixture\\project",
        projectname: "arc-verify-fixture",
        branch: "main",
        task: "Fixture session",
        model: "claude-opus-4-1",
        tokenstotal: 1200,
        lastactivets: now - 60_000,
        resumecommand: `claude --resume ${id}`,
        transcriptpath: `${FIXTURE_DIR}\\${id}.jsonl`,
        status: "done",
        startedts: now - 600_000,
        durationms: 540_000,
        events: [{ type: "started", ts: now - 600_000, text: "Fixture session" }],
        ...overrides,
    };
}

// a run and the dag its dagoref names, as the WOS cache holds them (otype/oid/version/meta are required)
export function fixtureRun({ status = "executing", dagStatus = "running", tasks = [] } = {}) {
    const now = Date.now();
    const runId = randomUUID();
    const dagId = randomUUID();
    const channelId = randomUUID();
    const run = {
        otype: "run",
        oid: runId,
        id: runId,
        version: 1,
        meta: {},
        channeloid: channelId,
        goal: "Fixture run",
        mode: "orchestrator",
        workspaceid: "",
        projectpath: "C:\\arc-verify-sessions-fixture\\project",
        status,
        phases: [],
        createdts: now - 600_000,
        dagoref: `dag:${dagId}`,
    };
    const dag = {
        otype: "dag",
        oid: dagId,
        id: dagId,
        version: 1,
        meta: {},
        runid: runId,
        channelid: channelId,
        title: "Fixture dag",
        parallelism: 1,
        status: dagStatus,
        failures: 0,
        createdts: now - 600_000,
        updatedts: now - 60_000,
        tasks: tasks.map((t) => ({ label: `Task ${t.id}`, deps: [], state: "pending", ...t })),
    };
    return { run, dag };
}

// GetAgentTranscript's lines: all of them for maxlines <= 0, else the last maxlines
export function tailLines(lines, maxlines) {
    return maxlines > 0 ? lines.slice(-maxlines) : lines;
}

// an app module, imported from the URL the app loaded it from so the import is the app's instance
const MOD = `
    const mod = async (path) => {
        const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
        const hit = names.filter((n) => n.endsWith("/" + path)).pop();
        const base = names.find((n) => n.endsWith("/app/store/jotaiStore.ts"));
        if (hit == null && base == null) throw new Error("no app module url for " + path);
        return import(hit ?? base.replace("app/store/jotaiStore.ts", path));
    };
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const store = await mod("app/view/agents/sessionsarchivestore.ts");
    const WOS = await mod("app/store/wos.ts");
    const { RpcApi } = await mod("app/store/wshclientapi.ts");
`;
const pageEval = (h, body) => h.ev(`(async () => { ${MOD} ${body} })()`);

export function installSessions(h, sessions) {
    return pageEval(
        h,
        `
        const sessions = ${JSON.stringify(sessions)};
        RpcApi.GetSessionsActivityCommand = async () => ({ sessions, incomplete: false });
        globalStore.set(store.sessionsArchiveAtom, sessions);
        globalStore.set(store.sessionsIncompleteAtom, false);
        globalStore.set(store.sessionsErrorAtom, false);
    `
    );
}

// holds each run and dag in the WOS cache; the fetch is dropped (pendingPromise never settles) and the held copy
// is put back after every push, since a live object is pushed again on each change
export function installRuns(h, list) {
    const objects = list.flatMap(({ run, dag }) => [run, dag]);
    return pageEval(
        h,
        `
        for (const obj of ${JSON.stringify(objects)}) {
            const oref = obj.otype + ":" + obj.oid;
            window.__sessionsFixtureHeld?.[oref]?.();
            const wov = WOS.getWaveObjectValue(oref);
            const held = { value: obj, loading: false, error: false };
            wov.pendingPromise = new Promise(() => {});
            globalStore.set(wov.dataAtom, held);
            (window.__sessionsFixtureHeld ??= {})[oref] = globalStore.sub(wov.dataAtom, () => {
                if (globalStore.get(wov.dataAtom) !== held) globalStore.set(wov.dataAtom, held);
            });
        }
    `
    );
}

// byPath: path -> { lines } or { error }; a path it does not hold reaches the real command
export function stubTranscripts(h, byPath) {
    return pageEval(
        h,
        `
        const tailLines = ${tailLines.toString()};
        window.__sessionsFixtureTranscripts = ${JSON.stringify(byPath)};
        window.__sessionsFixtureCalls = [];
        const real = RpcApi.GetAgentTranscriptCommand.bind(RpcApi);
        RpcApi.GetAgentTranscriptCommand = async (client, data, opts) => {
            const entry = window.__sessionsFixtureTranscripts[data.path];
            if (entry == null) return real(client, data, opts);
            window.__sessionsFixtureCalls.push({ path: data.path, maxlines: data.maxlines });
            if (entry.error != null) throw new Error(entry.error);
            return { lines: tailLines(entry.lines, data.maxlines ?? 0) };
        };
    `
    );
}

export function setTranscript(h, path, entry) {
    return h.ev(`(window.__sessionsFixtureTranscripts[${JSON.stringify(path)}] = ${JSON.stringify(entry)}, true)`);
}

export function restoreSessions(h) {
    return pageEval(
        h,
        `
        delete RpcApi.GetSessionsActivityCommand;
        delete RpcApi.GetAgentTranscriptCommand;
        delete window.__sessionsFixtureTranscripts;
        delete window.__sessionsFixtureCalls;
        for (const [oref, release] of Object.entries(window.__sessionsFixtureHeld ?? {})) {
            release();
            WOS.getWaveObjectValue(oref).pendingPromise = null;
            await WOS.reloadWaveObject(oref).catch(() => {});
        }
        delete window.__sessionsFixtureHeld;
        await store.loadSessionsArchive();
    `
    );
}
