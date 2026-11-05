// Shared fixtures for the Agent-surface review scenarios, so a scenario writes nothing into ~/.claude/projects.
// The record builders and the two writers are pure Node (tested beside this file); agentPage, setRoster,
// focusAgent, makeTab and closeTabs run against the dev app through h.ev / h.rpc.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waveService } from "./scenarios-shared.mjs";

export const FIXTURE_DIR = "C:\\arc-verify-agent-fixture";
const DEFAULT_SESSION_ID = "arc-verify-agent-session";

// the app's own module instances, and the app's one AgentsViewModel
const LIB = `
    const mod = async (path) => {
        const names = performance.getEntriesByType("resource").map((e) => e.name.split("?")[0]);
        const hit = names.filter((n) => n.endsWith("/" + path)).pop();
        const base = names.find((n) => n.endsWith("/app/store/jotaiStore.ts"));
        if (hit == null && base == null) throw new Error("no app module url for " + path);
        return import(hit ?? base.replace("app/store/jotaiStore.ts", path));
    };
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const WOS = await mod("app/store/wos.ts");
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 5000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (await fn()) return true;
            await nap(50);
        }
        return false;
    };
    const flat = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
    // the nav rail, not the Agent tree: with no agent yet the Agent surface renders the launch hero and no tree
    const agentsModel = () => {
        const nav = document.querySelector("nav");
        const key = nav && Object.keys(nav).find((k) => k.startsWith("__reactFiber$"));
        for (let f = key ? nav[key] : null; f; f = f.return) {
            if (f.memoizedProps?.model?.pendingLaunchesAtom) return f.memoizedProps.model;
        }
        throw new Error("no AgentsViewModel above the nav rail");
    };
`;

export const agentPage = (h, body) => h.ev(`(async () => { ${LIB} ${body} })()`);

// the roster the page held before the first setRoster stays in the page, so a second scenario cannot overwrite it
export const setRoster = (h, roster) =>
    agentPage(
        h,
        `const D = await mod("app/view/agents/devmock.ts");
        if (!("__agentFixturePrev" in window)) window.__agentFixturePrev = globalStore.get(D.devMockAgentsAtom);
        globalStore.set(D.devMockAgentsAtom, ${JSON.stringify(roster)});
        return true;`
    );

export const restoreRoster = (h) =>
    agentPage(
        h,
        `const D = await mod("app/view/agents/devmock.ts");
        if ("__agentFixturePrev" in window) {
            globalStore.set(D.devMockAgentsAtom, window.__agentFixturePrev);
            delete window.__agentFixturePrev;
        }
        return true;`
    );

export const focusAgent = (h, id) =>
    agentPage(
        h,
        `const model = agentsModel();
        globalStore.set(model.focusIdAtom, ${JSON.stringify(id)});
        globalStore.set(model.surfaceAtom, "agent");
        return true;`
    );

// A real tab made as launchAgent makes it: CreateTab, the block's meta, the tab's session meta. No controller unless
// the caller's blockMeta names one, so nothing runs. CreateTab is a wavesrv service call, which the page cannot
// reach cross-origin, so Node makes it. pending: true also adds a pending launch, which keeps the row booting.
export async function makeTab(h, ctx, { label, blockMeta = { view: "term" }, tabMeta = {}, pending = false }) {
    if (ctx.workspaceId == null) {
        const bootTab = String(await h.ev("window.TabRpcClient.routeId")).replace(/^tab:/, "");
        const wslist = await h.rpc("workspacelist", null);
        const ws = wslist.find((w) => (w.workspacedata?.tabids ?? []).includes(bootTab)) ?? wslist[0];
        ctx.workspaceId = ws.workspacedata.oid;
    }
    ctx.tabIds ??= [];
    const tabId = await waveService(h, "workspace", "CreateTab", [ctx.workspaceId, label, false]);
    ctx.tabIds.push(tabId);
    const tab = await waveService(h, "object", "GetObject", [`tab:${tabId}`]);
    const blockId = tab?.blockids?.[0];
    if (!blockId) throw new Error(`the new tab ${label} has no block`);
    await h.rpc("setmeta", { oref: `block:${blockId}`, meta: blockMeta });
    await h.rpc("setmeta", {
        oref: `tab:${tabId}`,
        meta: { "session:agent": "claude", "session:project": label, ...tabMeta },
    });
    await agentPage(
        h,
        `await WOS.reloadWaveObject(WOS.makeORef("block", ${JSON.stringify(blockId)}));
        if (${pending}) {
            const model = agentsModel();
            const launch = { tabId: ${JSON.stringify(tabId)}, blockId: ${JSON.stringify(blockId)}, name: ${JSON.stringify(label)},
                project: ${JSON.stringify(label)}, ts: Date.now(), runtime: "claude" };
            globalStore.set(model.pendingLaunchesAtom, [...globalStore.get(model.pendingLaunchesAtom), launch]);
        }
        return true;`
    );
    return { tabId, blockId };
}

// best-effort, so one failed close does not strand the rest
export async function closeTabs(h, ctx) {
    const ids = ctx.tabIds ?? [];
    try {
        await agentPage(
            h,
            `const model = agentsModel();
            const ids = ${JSON.stringify(ids)};
            globalStore.set(model.pendingLaunchesAtom, globalStore.get(model.pendingLaunchesAtom).filter((p) => !ids.includes(p.tabId)));
            return true;`
        );
    } catch (e) {
        console.error(`closeTabs: drop the pending launches failed: ${e?.message ?? e}`);
    }
    for (const tabId of ids) {
        try {
            await waveService(h, "workspace", "CloseTab", [ctx.workspaceId, tabId, false]);
        } catch (e) {
            console.error(`closeTabs: close tab ${tabId} failed: ${e?.message ?? e}`);
        }
    }
    ctx.tabIds = [];
}

// Claude transcript records, one JSON line each. opts: cwd, sessionId, ts (an ISO string).
const record = (type, message, opts = {}, extra = {}) =>
    JSON.stringify({
        type,
        timestamp: opts.ts ?? new Date().toISOString(),
        cwd: opts.cwd ?? FIXTURE_DIR,
        sessionId: opts.sessionId ?? DEFAULT_SESSION_ID,
        message,
        ...extra,
    });

export const userText = (text, opts) => record("user", { role: "user", content: text }, opts);

export const assistantText = (text, opts) =>
    record("assistant", { role: "assistant", content: [{ type: "text", text }] }, opts);

export const toolUse = (id, name, input, opts) =>
    record("assistant", { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, opts);

export const toolResult = (id, text, { toolUseResult, isError, ...opts } = {}) =>
    record(
        "user",
        {
            role: "user",
            content: [
                { type: "tool_result", tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) },
            ],
        },
        opts,
        toolUseResult === undefined ? {} : { toolUseResult }
    );

// the user record Claude writes when a background task or subagent finishes
export const taskNotification = ({ taskId, toolUseId, status = "completed", summary = "", ...opts }) =>
    userText(
        [
            "<task-notification>",
            `<task-id>${taskId}</task-id>`,
            `<tool-use-id>${toolUseId}</tool-use-id>`,
            `<status>${status}</status>`,
            `<summary>${summary}</summary>`,
            "</task-notification>",
        ].join("\n"),
        opts
    );

export const interrupted = (opts) =>
    record("user", { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, opts);

export const usage = ({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0, model = "claude-opus-4-1", ...opts } = {}) =>
    record(
        "assistant",
        {
            role: "assistant",
            model,
            content: [],
            usage: {
                input_tokens: input,
                output_tokens: output,
                cache_read_input_tokens: cacheRead,
                cache_creation_input_tokens: cacheWrite,
            },
        },
        opts
    );

export function writeTranscript(dir, name, lines) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
}

// GetSubagentsCommand looks for a session's children under <session>/subagents/agent-<id>.jsonl
export function writeSubagent(dir, name, agentId, lines) {
    return writeTranscript(join(dir, name, "subagents"), `agent-${agentId}`, lines);
}
