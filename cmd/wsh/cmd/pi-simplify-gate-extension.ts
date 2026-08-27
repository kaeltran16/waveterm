// pi extension: pi-simplify commit gate. Blocks `git commit` on complex diffs (beyond
// MAX_DIFF_LINES/MAX_DIFF_FILES, generated paths excluded) unless a /simplify review stamp
// covers the exact diff being committed. `--no-verify` overrides, mirroring git semantics.
// Inert outside git repos; every git failure fails open (the gate never breaks a commit the
// way a broken pre-commit hook would).
//
// Evidence model: /simplify sends its review prompt as a follow-up user message. The context
// event fires before each LLM call, so while that prompt is the last user message we restamp
// the current diff — the commit then matches the stamp. A commit attempted in the same turn
// right after edits gets blocked once, and the retry re-stamps and passes.
//
// This is a Pi-only gate: pi-simplify is a Pi command, so Claude Code agents and manual
// commits are unaffected.
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import {
    computeDiffHash,
    decideGate,
    diffComplexity,
    isSimplifyReviewPrompt,
    lastUserMessageText,
    parseCommitCommand,
    readStamp,
    stampFilePath,
    writeStamp,
} from "./waveterm-simplify-gate-core";

const GIT_TIMEOUT_MS = 5000;

const git = (args: string[], cwd: string): string | null => {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch {
        return null; // not a repo, git missing, or git error — fail open
    }
};

const numstatForRepo = (dir: string): string | null => git(["diff", "--numstat", "HEAD"], dir);

const gitDirFor = (dir: string): string | null => {
    const out = git(["rev-parse", "--git-dir"], dir);
    if (out === null) return null;
    const gd = out.trim();
    return gd ? (isAbsolute(gd) ? gd : join(dir, gd)) : null;
};

export default function simplifyGate(pi: any): void {
    pi.on("tool_call", (event: any, ctx: any) => {
        try {
            if (event?.toolName !== "bash") return;
            const command: string = event.input?.command ?? "";
            const commit = parseCommitCommand(command);
            if (!commit) return;
            const cwd = ctx?.cwd ?? process.cwd();
            const base = commit.repoDir ? resolve(cwd, commit.repoDir) : cwd;
            const numstat = numstatForRepo(base);
            if (numstat === null) return; // not a repo — nothing to gate
            const gitDir = gitDirFor(base);
            const decision = decideGate({
                complexity: diffComplexity(numstat),
                hasVerifyFlag: command.includes("--no-verify"),
                stampHash: gitDir ? readStamp(stampFilePath(gitDir)) : null,
                diffHash: computeDiffHash(numstat),
            });
            if (decision.block) {
                return { block: true, reason: decision.reason };
            }
        } catch (e) {
            // a gate bug must never break a commit — fail open
            console.log(`simplify-gate: ${String(e)}`);
        }
    });

    pi.on("context", (event: any, ctx: any) => {
        try {
            const text = lastUserMessageText(event?.messages ?? []);
            if (!text || !isSimplifyReviewPrompt(text)) return;
            const cwd = ctx?.cwd ?? process.cwd();
            const numstat = numstatForRepo(cwd);
            if (numstat === null) return;
            const gitDir = gitDirFor(cwd);
            if (!gitDir) return;
            writeStamp(stampFilePath(gitDir), computeDiffHash(numstat));
        } catch (e) {
            // never break the session because stamping failed
            console.log(`simplify-gate: stamp failed: ${String(e)}`);
        }
    });
}
