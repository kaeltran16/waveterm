// pi-simplify commit gate core: pure logic, no pi coupling. The gate blocks `git commit` on
// complex diffs (beyond thresholds, generated paths excluded) unless a /simplify review stamp
// covers exactly the diff being committed. `--no-verify` overrides, mirroring git semantics.
// The default export is a no-op: pi auto-loads every file in the extensions directory, and this
// module is a dependency, not an extension.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_DIFF_LINES = 50;
export const MAX_DIFF_FILES = 4;

// distinctive first line of the /simplify follow-up prompt (pi-simplify's prompt-builder)
export const SIMPLIFY_PROMPT_MARKER = "Review the following recently changed files";

// generated/bulk paths that never count toward complexity
const EXCLUDED_SEGMENTS = ["dist", "node_modules"];
const GENERATED_BINDINGS = [
    "frontend/types/gotypes.d.ts",
    "frontend/app/store/wshclientapi.ts",
    "pkg/wshrpc/wshclient/wshclient.go",
];

const toPosix = (path: string): string => path.replace(/\\/g, "/");

// parseCommitCommand finds a `git commit` subcommand in a bash command line. Returns null when
// there is none, or { repoDir } when `git -C <dir> commit` targets a different repo. Fail-open:
// anything we cannot confidently parse is not treated as a commit. Only `git` tokens at the start
// or after a shell separator count — `echo git commit` is prose, not a commit.
export function parseCommitCommand(command: string): { repoDir?: string } | null {
    const tokens = command.split(/\s+/).filter(Boolean);
    const separators = new Set(["&&", "||", ";", "|", "&"]);
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] !== "git") continue;
        if (i > 0 && !separators.has(tokens[i - 1])) continue;
        let repoDir: string | undefined;
        let j = i + 1;
        for (; j < tokens.length; j++) {
            const t = tokens[j];
            if (t === "-C" || t === "-c") {
                j++; // consume the flag's value
                if (t === "-C" && j < tokens.length) repoDir = tokens[j];
            } else if (t.startsWith("-")) {
                // self-contained flag (--no-pager, --git-dir=x, ...)
            } else {
                break;
            }
        }
        if (tokens[j] === "commit") return repoDir ? { repoDir } : {};
    }
    return null;
}

// parseNumstat parses `git diff --numstat` output. Binary rows (-/-) count as files but zero
// lines; malformed rows are ignored. An optional filter drops rows before counting.
export function parseNumstat(stdout: string, filter?: (path: string) => boolean): { files: string[]; lines: number } {
    const files: string[] = [];
    let lines = 0;
    for (const row of stdout.split("\n")) {
        const parts = row.split("\t");
        if (parts.length < 3 || !parts[2]) continue;
        const [added, deleted, path] = parts;
        if (filter && !filter(path)) continue;
        files.push(path);
        if (added === "-" || deleted === "-") continue; // binary
        const a = Number(added);
        const d = Number(deleted);
        if (!Number.isFinite(a) || !Number.isFinite(d)) continue;
        lines += a + d;
    }
    return { files, lines };
}

// isExcludedPath: generated output, vendored deps, lockfiles, and regenerated bindings never
// make a diff "complex" on their own.
export function isExcludedPath(path: string): boolean {
    const p = toPosix(path);
    const segments = p.split("/");
    if (segments.some((s) => EXCLUDED_SEGMENTS.includes(s))) return true;
    const base = segments[segments.length - 1] ?? "";
    const lower = base.toLowerCase();
    if (/(^|[.-])lock([.-]|$)/.test(lower)) return true;
    if (base === "go.sum") return true;
    return GENERATED_BINDINGS.includes(p);
}

// diffComplexity: changed lines + files (counts) after excluding generated paths.
export function diffComplexity(numstat: string): { lines: number; files: number } {
    const { files, lines } = parseNumstat(numstat, (p) => !isExcludedPath(p));
    return { lines, files: files.length };
}

// isComplex: strictly beyond the thresholds (50 lines, 4 files).
export function isComplex(c: { lines: number; files: number }): boolean {
    return c.lines > MAX_DIFF_LINES || c.files > MAX_DIFF_FILES;
}

// computeDiffHash: sha256 of the normalized numstat — the exact review scope the stamp must cover.
export function computeDiffHash(numstat: string): string {
    return createHash("sha256").update(numstat.trim() + "\n").digest("hex");
}

// decideGate: pure gate decision. Block complex commits unless a stamp covers the exact diff,
// or the human passed the git-native --no-verify override.
export function decideGate(opts: {
    complexity: { lines: number; files: number };
    hasVerifyFlag: boolean;
    stampHash: string | null;
    diffHash: string;
}): { block: boolean; reason?: string } {
    if (!isComplex(opts.complexity)) return { block: false };
    if (opts.hasVerifyFlag) return { block: false };
    if (opts.stampHash && opts.stampHash === opts.diffHash) return { block: false };
    const { lines, files } = opts.complexity;
    return {
        block: true,
        reason:
            `complex change not reviewed: ${lines} lines / ${files} files. ` +
            "Run /simplify first so the changed lines get a simplification review, then retry the " +
            "commit. To skip the review explicitly, commit with --no-verify.",
    };
}

export function stampFilePath(gitDir: string): string {
    return `${gitDir.replace(/[\\/]+$/, "")}/simplify-stamp.json`;
}

// readStamp returns the stamped diff hash, or null when absent/corrupt (a corrupt stamp must
// block, not fail the session — the next /simplify rewrites it).
export function readStamp(file: string): string | null {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { diffHash?: unknown };
        return typeof parsed.diffHash === "string" ? parsed.diffHash : null;
    } catch {
        return null;
    }
}

export function writeStamp(file: string, diffHash: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ diffHash }, null, 2));
}

// isSimplifyReviewPrompt: the /simplify follow-up is the only message that carries this header.
export function isSimplifyReviewPrompt(text: string): boolean {
    return text.includes(SIMPLIFY_PROMPT_MARKER);
}

// lastUserMessageText: the context event fires before every LLM call; stamping only while the
// review prompt is the last user message keeps later turns (new changes after the review) from
// re-stamping an unreviewed diff.
export function lastUserMessageText(messages: unknown[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as { role?: string; content?: unknown };
        if (m?.role !== "user") continue;
        const content = m.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content
                .filter((p): p is { type: string; text?: string } => typeof p === "object" && p !== null && (p as { type?: string }).type === "text")
                .map((p) => p.text ?? "")
                .join("\n");
        }
        return null;
    }
    return null;
}

export default function wavetermSimplifyGateCore(): void {
    // no-op dependency module
}
