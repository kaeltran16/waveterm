// Diff surface scenario diff-agent-edits: a Claude agent's scope opens on "Agent's edits", the range rebuilt from its
// transcript (docs/superpowers/specs/2026-11-18-agent-edits-range-design.md). The fixture writes nothing under
// ~/.claude: its transcript lives in a temp dir and uses only cases that need no backup file (a created file, a file
// with no record, a foreign edit between two of the agent's edits), beside an unrelated edit the agent never made.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreRoster, setRoster, toolResult, toolUse, userText, assistantText, writeTranscript } from "./agent-page-fixtures.mjs";
import { fileRowSel, setViewport, sleep, textOf, until } from "./scenarios-files-scope.mjs";
import { git, reloadApp } from "./scenarios-shared.mjs";

const NAME = "diff-agent-edits";
const SEED = "seed the edits fixture";
const CREATED = "created.txt";
const APPROX = "edited.txt";
const OUTSIDE = "drifted.txt";
const UNRELATED = "unrelated.txt";
const AGENT_FILES = [CREATED, OUTSIDE, APPROX];
const EDITS_ID = "fx-diff-agent-edits";
const QUIET_ID = "fx-diff-agent-quiet";
const LOAD_MS = 20_000;
// the transcript's records sit a minute after the seed commit, so the session-start anchor is that commit whatever
// the clocks' rounding
const AHEAD_MS = 60_000;

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const SUMMARY = "[data-files-range-summary]";
const chipPressed = (kind) => `${q(`[data-range-chip=${JSON.stringify(kind)}]`)}?.getAttribute("aria-pressed") === "true"`;
const FILE_ROWS = `[...document.querySelectorAll("[data-changed-file-row]")].map((r) => r.getAttribute("data-changed-file-row")).sort()`;
const HISTORY_ROWS = `[...document.querySelectorAll("[data-history-row]")].map((r) => r.textContent.trim())`;
const flagOf = (path) => `${q(fileRowSel(path))}?.querySelector("[data-edit-flag]")?.getAttribute("data-edit-flag") ?? null`;

function seedRepo(root) {
    const dir = join(root, "repo");
    git(root, "init", "-q", "--initial-branch=main", dir);
    writeFileSync(join(dir, APPROX), "one\ntwo\nthree\n");
    writeFileSync(join(dir, OUTSIDE), "alpha\nbeta\ngamma\n");
    writeFileSync(join(dir, UNRELATED), "left alone\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", SEED);
    return dir;
}

// The agent Writes a new file (a file-history record with no backup: it did not exist), Edits a file with no record
// (approximate), Edits a file twice where the second old_string no longer matches (changed outside), and runs one
// Bash call. The working tree then holds those results, a foreign edit to the drifted file and an unrelated edit.
function seedEditsTranscript(root, dir) {
    const t0 = Date.now() + AHEAD_MS;
    let n = 0;
    const at = () => ({ cwd: dir, ts: new Date(t0 + n++ * 1000).toISOString() });
    const call = (id, name, input) => [toolUse(id, name, input, at()), toolResult(id, "ok", at())];
    const created = "made by the agent\n";
    const lines = [
        userText("Tidy the fixture files.", at()),
        JSON.stringify({ type: "file-history-delta", timestamp: at().ts, trackingPath: join(dir, CREATED), backup: { backupFileName: null, version: 1 } }),
        ...call("tu-write", "Write", { file_path: join(dir, CREATED), content: created }),
        ...call("tu-edit-approx", "Edit", { file_path: join(dir, APPROX), old_string: "two", new_string: "two, by the agent" }),
        ...call("tu-edit-drift-1", "Edit", { file_path: join(dir, OUTSIDE), old_string: "beta", new_string: "beta, by the agent" }),
        // someone else rewrote gamma in between, so this old_string is no longer in the file
        ...call("tu-edit-drift-2", "Edit", { file_path: join(dir, OUTSIDE), old_string: "GAMMA, by someone else", new_string: "gamma, by the agent" }),
        ...call("tu-bash", "Bash", { command: "npm test" }),
        assistantText("Done.", at()),
    ];
    writeFileSync(join(dir, CREATED), created);
    writeFileSync(join(dir, APPROX), "one\ntwo, by the agent\nthree\n");
    writeFileSync(join(dir, OUTSIDE), "alpha\nbeta, by the agent\nGAMMA, by someone else\n");
    writeFileSync(join(dir, UNRELATED), "left alone\nedited by the user\n");
    return writeTranscript(join(root, "transcripts"), "edits-session", lines);
}

// timestamped records, no Edit or Write call
function seedQuietTranscript(root, dir) {
    const ts = new Date(Date.now() + AHEAD_MS).toISOString();
    return writeTranscript(join(root, "transcripts"), "quiet-session", [
        userText("What does this repo do?", { cwd: dir, ts }),
        assistantText("It holds three text files.", { cwd: dir, ts }),
    ]);
}

const rosterAgent = (id, name, transcriptPath, extra = {}) => ({
    id,
    name,
    project: NAME,
    task: "agent edits fixture",
    state: "idle",
    model: "claude-opus-5-5",
    activeMs: 60_000,
    transcriptPath,
    ...extra,
});

async function pickAgent(h, id) {
    const sel = `[data-files-source-agent=${JSON.stringify(id)}]`;
    if (!(await until(h, `!!${q("[data-files-source-picker]")}`, LOAD_MS))) return false;
    if ((await h.ev(`${q("[data-files-source-picker]")}.getAttribute("aria-expanded")`)) !== "true") {
        await h.ev(`${q("[data-files-source-picker]")}.click()`);
    }
    if (!(await until(h, `!!${q(sel)}`, 5000))) return false;
    await h.ev(`${q(sel)}.click()`);
    return true;
}

export const diffAgentEdits = {
    name: NAME,
    surface: "files",
    async arrange(h) {
        const root = mkdtempSync(join(tmpdir(), "verify-diff-agent-edits-"));
        const ctx = { root };
        try {
            ctx.dir = seedRepo(root);
            ctx.editsTranscript = seedEditsTranscript(root, ctx.dir);
            ctx.quietTranscript = seedQuietTranscript(root, ctx.dir);
            // no `agent` field: absent means claude
            await setRoster(h, [
                rosterAgent(EDITS_ID, "agent-edits-writer", ctx.editsTranscript),
                rosterAgent(QUIET_ID, "agent-edits-quiet", ctx.quietTranscript, { agent: "claude" }),
            ]);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: JSON.stringify(detail) });
        if (ctx.arrangeError != null) {
            rec("arrange", false, ctx.arrangeError);
            return steps;
        }
        try {
            await setViewport(h);
            const picked = await pickAgent(h, EDITS_ID);
            const listed = picked && (await until(h, `${chipPressed("edits")} && ${FILE_ROWS}.length === ${AGENT_FILES.length}`, LOAD_MS));
            const chips = await h.ev(`[...document.querySelectorAll("[data-range-chip]")].map((c) => ({ kind: c.dataset.rangeChip, pressed: c.getAttribute("aria-pressed"), text: c.textContent.trim() }))`);
            const session = chips.find((c) => c.kind === "session");
            await h.shot("cdp-shots/diff-agent-edits-open.png");
            rec(
                "1. picking the agent opens Diff on the pressed Agent's edits chip, with Since session start also offered",
                listed && chips.find((c) => c.kind === "edits")?.pressed === "true" && session?.pressed === "false" && /since session start/i.test(session.text),
                { picked, listed, chips }
            );

            const rows = await h.ev(FILE_ROWS);
            await h.shot("cdp-shots/diff-agent-edits-list.png");
            rec(
                "2. the list holds the created, the approximate and the outside file, and not the unrelated edit",
                JSON.stringify(rows) === JSON.stringify([...AGENT_FILES].sort()),
                { rows }
            );

            const flags = { [CREATED]: await h.ev(flagOf(CREATED)), [APPROX]: await h.ev(flagOf(APPROX)), [OUTSIDE]: await h.ev(flagOf(OUTSIDE)) };
            await h.shot("cdp-shots/diff-agent-edits-flags.png");
            rec(
                "3. the approximate and the outside rows carry their data-edit-flag marks",
                flags[CREATED] == null && flags[APPROX] === "approximate" && flags[OUTSIDE] === "outside",
                flags
            );

            const summary = await textOf(h, SUMMARY);
            await h.shot("cdp-shots/diff-agent-edits-caption.png");
            rec(
                "4. the summary caption names 3 files and 1 Bash call",
                /^3 files by this agent\b/.test(summary) && /\b1 Bash call\b/.test(summary),
                { summary }
            );

            const editsHistory = await h.ev(HISTORY_ROWS);
            await h.shot("cdp-shots/diff-agent-edits-history.png");
            rec(
                "5. the history column on the edits chip shows only the scope's own row, no commit rows",
                editsHistory.length === 1 && editsHistory[0].includes("Agent's edits") && !editsHistory.some((r) => r.includes(SEED)),
                { editsHistory }
            );

            // B..H are rebuilt from the transcript, so the pane must not call them the working tree
            await h.ev(`${q("[data-history-row] button")}?.click()`);
            const PANE = `(${q("[data-commit-pane]")}?.textContent ?? "")`;
            const named = await until(h, `${chipPressed("edits")} && ${PANE}.includes("Agent's edits")`, LOAD_MS);
            const pane = await h.ev(PANE);
            await h.shot("cdp-shots/diff-agent-edits-pane.png");
            rec(
                "6. with the edits chip pressed and the scope's row selected, the commit pane reads Agent's edits, not Working tree",
                named && !pane.includes("Working tree"),
                { pane: pane.slice(0, 200) }
            );

            await h.ev(`${q('[data-range-chip="session"]')}?.click()`);
            const widened =
                (await until(h, `${chipPressed("session")} && ${FILE_ROWS}.includes(${JSON.stringify(UNRELATED)})`, LOAD_MS)) &&
                (await until(h, `${HISTORY_ROWS}.some((r) => r.includes(${JSON.stringify(SEED)}))`, LOAD_MS));
            const sessionRows = await h.ev(FILE_ROWS);
            const sessionHistory = await h.ev(HISTORY_ROWS);
            await h.shot("cdp-shots/diff-agent-edits-session.png");
            rec(
                "7. picking Since session start lists the unrelated edit too, and the history column shows commit rows again",
                widened && AGENT_FILES.every((p) => sessionRows.includes(p)),
                { sessionRows, sessionHistory }
            );

            const reply = await h.rpc("gitagentedits", { cwd: ctx.dir, transcriptpath: ctx.quietTranscript });
            const quietPicked = await pickAgent(h, QUIET_ID);
            const quiet =
                quietPicked &&
                !!reply?.reason &&
                (await until(h, `${chipPressed("edits")} && (${q(SUMMARY)}?.textContent ?? "").trim() === ${JSON.stringify(reply?.reason ?? "")}`, LOAD_MS));
            // the list stays empty past a poll's worth of settling, never falling back to the working tree
            await sleep(1000);
            const quietRows = await h.ev(FILE_ROWS);
            const quietSummary = await textOf(h, SUMMARY);
            await h.shot("cdp-shots/diff-agent-edits-nothing.png");
            rec(
                "8. the second agent opens on the pressed edits chip with an empty file list and the reply's reason in the caption",
                quiet && quietRows.length === 0 && !reply.base,
                { quietPicked, reply, quietRows, quietSummary }
            );
        } catch (e) {
            rec("scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        try {
            await restoreRoster(h);
        } catch (e) {
            console.error(`${NAME} teardown: restore the roster: ${e?.message ?? e}`);
        }
        await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        try {
            rmSync(ctx.root, { recursive: true, force: true });
        } catch (e) {
            console.error(`${NAME} teardown: remove ${ctx.root}: ${e?.message ?? e}`);
        }
        // fresh module state: Diff's scope would otherwise keep pointing at an agent no longer in the roster
        await reloadApp(h);
    },
};
