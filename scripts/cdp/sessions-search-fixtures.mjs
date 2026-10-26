// Fixtures for the sessions-search CDP scenarios: five Claude Code transcripts the session scan and search read,
// a run the lead and worker transcripts are linked to, and a builder check's run.
//
// This writes into the REAL ~/.claude/projects (the scan reads only there), under one directory of its own,
// C--arc-verify-sessions-search. Every scenario that uses it removes that directory, the temp cwd and the run in
// its teardown (removeSessionsSearchFixtures, then kit.teardownFixtureRun).
//
// word, checkWord and absent are nonces made per call, so a search for them finds only these fixtures; checkWord
// is only in the check transcript, and absent is in none.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_DIR = "C--arc-verify-sessions-search";
const MODEL = "claude-opus-5-5";
// a session's title is its first prompt cut to this many runes (maxTaskLen, pkg/agentsessions), so a word placed
// past it is in the prompt but not the title
const TITLE_RUNES = 120;
const STEP_MS = 60_000;

const nonce = (prefix) => prefix + randomBytes(5).toString("hex");

// mirrors trimTo in pkg/agentsessions
function titleOf(prompt) {
    const r = [...prompt.trim()];
    return r.length <= TITLE_RUNES ? prompt.trim() : r.slice(0, TITLE_RUNES - 1).join("").trim() + "…";
}

function transcript(id, cwd, startMs, turns) {
    let ts = startMs;
    const base = () => ({
        sessionId: id,
        cwd,
        entrypoint: "cli",
        uuid: randomUUID(),
        timestamp: new Date((ts += 1000)).toISOString(),
    });
    return (
        turns
            .map((t) => {
                if (t.user != null) {
                    return { ...base(), type: "user", message: { role: "user", content: t.user } };
                }
                if (t.result != null) {
                    const content = [{ type: "tool_result", tool_use_id: t.result, content: "ok", is_error: false }];
                    return { ...base(), type: "user", message: { role: "user", content } };
                }
                const content = t.bash
                    ? [{ type: "tool_use", id: t.id, name: "Bash", input: { command: t.bash } }]
                    : [{ type: "text", text: t.agent }];
                return { ...base(), type: "assistant", message: { role: "assistant", model: MODEL, content } };
            })
            .map((r) => JSON.stringify(r))
            .join("\n") + "\n"
    );
}

export function writeSessionsSearchFixtures() {
    const word = nonce("arcfind");
    const absent = nonce("arcnone");
    const checkWord = nonce("arccheck");
    const cwd = mkdtempSync(join(tmpdir(), "verify-sessions-search-"));
    const dir = join(homedir(), ".claude", "projects", PROJECT_DIR);
    mkdirSync(dir, { recursive: true });
    const now = Date.now();

    const soloPrompt =
        "Look into why the nightly export job keeps stopping halfway through the second batch on the reporting " +
        `server, and fix it. The log names ${word} as the stage it was in.`;
    const commitId = "toolu_" + randomBytes(8).toString("hex");
    const sessions = {
        // a brainstorm's builder check: its own word, so steps 1-4's counts leave it out
        check: [
            { user: "Check whether the export job can be built from the brainstorm's chosen approach." },
            { agent: `Yes: the ${checkWord} approach needs no new service.` },
        ],
        other: [
            { user: "Rename the settings page heading to match the nav label." },
            { agent: "Renamed the heading; the nav and the page now both read Settings." },
        ],
        worker: [
            { user: "Implement task t-1: make the export stage resumable." },
            { agent: `The ${word} stage now records its last batch.` },
            { agent: `Resuming starts ${word} from that batch.` },
        ],
        lead: [
            { user: "Plan the export fix as a run." },
            { agent: `The plan has one task, for the ${word} stage.` },
        ],
        solo: [
            { user: soloPrompt },
            { agent: `The ${word} stage times out on large batches, and the retry restarts ${word} from zero.` },
            { agent: "I made the retry resume from the last finished batch, so the stage ends in one pass." },
            { bash: `git commit -m "fix: resume ${word} from the last batch"`, id: commitId },
            { result: commitId },
            { agent: `Committed. The ${word} stage now resumes where it stopped.` },
        ],
    };
    // written oldest first, so the solo session is the newest
    const ids = {};
    Object.entries(sessions).forEach(([name, turns], i) => {
        const id = randomUUID();
        const startMs = now - (Object.keys(sessions).length - i) * STEP_MS;
        const path = join(dir, `${id}.jsonl`);
        writeFileSync(path, transcript(id, cwd, startMs, turns));
        const mtime = new Date(startMs + STEP_MS / 2);
        utimesSync(path, mtime, mtime);
        ids[name] = { id, path };
    });
    return {
        dir,
        cwd,
        word,
        absent,
        checkWord,
        solo: { id: ids.solo.id, title: titleOf(soloPrompt), transcript: ids.solo.path },
        other: { id: ids.other.id, title: titleOf(sessions.other[0].user) },
        lead: { id: ids.lead.id },
        worker: { id: ids.worker.id },
        check: { id: ids.check.id },
    };
}

const SEED_TASKS = [{ id: "t-1", label: "noop", description: "do nothing, stop immediately", deps: [], state: "" }];

// A run the lead and worker transcripts belong to, so linkSessionsToRuns places them as its lead and its t-1
// worker, and a builder check's run of its own for the check transcript. A dag can only be stored by dagsubmit, whose first tick dispatches t-1, so the run is cancelled at once;
// the worker's session is a deferred quick run pointed at the dag. Session ids are written after the cancels, so
// nothing the engine writes on cancel lands over them. Returns a ctx for kit.teardownFixtureRun, whose channel
// delete removes both runs and the dag.
export async function seedSessionsSearchRun(h, kit, fx) {
    const ctx = { cwd: mkdtempSync(join(tmpdir(), "verify-sessions-search-run-")) };
    try {
        const wslist = await h.rpc("workspacelist", null);
        const workspaceid = wslist[0].workspacedata.oid;
        const ch = await h.rpc("createchannel", { name: "verify-sessions-search", projectpath: ctx.cwd });
        ctx.channelId = ch.oid;
        const goal = "verify sessions-search: do nothing, make no file changes, stop immediately";
        const lead = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid,
            goal,
            runtime: "claude",
            mode: "orchestrator",
            deferstart: true,
        });
        ctx.runId = lead.run.id;
        const dag = await h.rpc("dagsubmit", {
            channelid: ctx.channelId,
            runid: ctx.runId,
            title: "verify sessions-search",
            parallelism: 1,
            tasks: SEED_TASKS,
        });
        ctx.dagId = dag.oid;
        await h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.runId });
        const worker = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid,
            goal,
            runtime: "claude",
            mode: "quick",
            deferstart: true,
        });
        ctx.workerRunId = worker.run.id;
        await h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.workerRunId });
        const check = await h.rpc("createrun", {
            channelid: ctx.channelId,
            workspaceid,
            goal,
            runtime: "claude",
            mode: "quick",
            deferstart: true,
        });
        ctx.checkRunId = check.run.id;
        await h.rpc("cancelrun", { channelid: ctx.channelId, runid: ctx.checkRunId });
        await kit.fstWriteRun(h, ctx.runId, (r) => ({ ...r, sessionid: fx.lead.id }));
        await kit.fstWriteRun(h, ctx.workerRunId, (r) => ({
            ...r,
            // the bare dag oid, as the engine stores it
            dagoref: ctx.dagId,
            taskid: "t-1",
            sessionid: fx.worker.id,
        }));
        // no dag: linkSessionsToRuns places a builder check on its own run, with its stage role
        await kit.fstWriteRun(h, ctx.checkRunId, (r) => ({ ...r, stagerole: "builder-check", sessionid: fx.check.id }));
    } catch (e) {
        ctx.arrangeError = String(e?.message ?? e);
    }
    return ctx;
}

export function removeSessionsSearchFixtures(fx) {
    if (!fx) return;
    rmSync(fx.dir, { recursive: true, force: true });
    rmSync(fx.cwd, { recursive: true, force: true });
}
