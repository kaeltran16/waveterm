// Fixtures for the setup-memory CDP scenario. Everything lives under one mkdtemp root: the git repos the
// fixture projects are registered on, their Claude Code memory folders, and the repo doc a change moves a memory
// into. Nothing touches ~/.claude. The state files follow pkg/memhygiene's shape (types.go State,
// wshrpctypes_memhygiene.go) with real sha256s, and each applied change a step undoes has a backup in Apply's
// format (apply.go applyManifest), so the backend lists, applies and undoes them exactly like a checked project's.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

export const MEMORY_PROJECTS = {
    own: "verify-mem-own",
    splitA: "verify-mem-split-a",
    splitB: "verify-mem-split-b",
    splitC: "verify-mem-split-c",
    former: "verify-mem-former",
};

export const MEMORY_FAILED_ERROR = "Check interrupted by a restart";

// the shared folder is named for this repo's slug, so the tab names the repo as the memory's owner
export const MEMORY_SHARED_REPO = "monorepo";

// a did line shows while its batch is this recent: memorymodel.ts DID_WINDOW_MS, the check interval
export const MEMORY_DID_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const STATE_DIR = "memhygiene";
const BACKUP_DIR = "backups";
const MANIFEST = "manifest.json";
const INDEX = "MEMORY.md";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHECK_INTERVAL_MS = MEMORY_DID_WINDOW_MS;
const BACKUP_KEEP_MS = 30 * DAY_MS;
const FILE_NAME_MAX_STEM = 60;
const FILE_NAME_HASH_HEX = 8;
const NO_DELTA = { lines: 0, bytes: 0 };

// split-a's size: enough changes that its Apply runs long enough for the tab to show progress
const SPLIT_A_MOVES = 36;
const SPLIT_A_COPIES = 24;
// the split-failed step blocks the copy of this move (0-based, in apply order), so some are already here
const SPLIT_A_FAIL_AT = 9;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const pad = (n) => String(n).padStart(2, "0");

// mirrors pkg/memhygiene/store.go FileName
export function memoryFileName(project) {
    let stem = "";
    for (const ch of project) {
        stem += /^[A-Za-z0-9._-]$/.test(ch) ? ch : "_";
    }
    stem = stem.slice(0, FILE_NAME_MAX_STEM);
    return `${stem}-${sha256(Buffer.from(project, "utf8")).slice(0, FILE_NAME_HASH_HEX)}.json`;
}

export function memoryStatePath(dataDir, project) {
    return join(dataDir, STATE_DIR, memoryFileName(project));
}

export function memoryBackupDir(dataDir, applyId) {
    return join(dataDir, STATE_DIR, BACKUP_DIR, applyId);
}

// mirrors pkg/memhygiene/textfile.go HashFile: "" for a file that doesn't exist
export function sha256File(path) {
    return existsSync(path) ? sha256(readFileSync(path)) : "";
}

// mirrors pkg/memhygiene/textfile.go ChangeID
export function memoryChangeId(kind, files) {
    const h = createHash("sha256").update(kind);
    for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        h.update(Buffer.from([0]))
            .update(f.path)
            .update(Buffer.from([0]))
            .update(f.sha256);
    }
    return h.digest("hex");
}

// mirrors agentobserve.SlugifyCwd, which names Claude Code's per-project folders
export function slugifyPath(path) {
    return path.replace(/[^A-Za-z0-9]/g, "-");
}

// what pkg/memhygiene measures: every line, and every byte (BOM and CRs included)
export function indexStats(path) {
    if (!existsSync(path)) return { exists: false, lines: 0, bytes: 0 };
    const buf = readFileSync(path);
    const lines = buf.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return { exists: true, lines: lines.length, bytes: buf.length };
}

const textStats = (text) => {
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return { exists: true, lines: lines.length, bytes: Buffer.byteLength(text) };
};
const lineDelta = (line, sign) => ({ lines: sign, bytes: sign * (Buffer.byteLength(line) + 1) });
const signedBytes = (n) => `${n < 0 ? "−" : "+"}${Math.abs(n).toLocaleString("en-US")} B`;
const diffLines = (sign, text) => text.split("\n").map((t) => ({ sign, text: t }));
const indexText = (lines) => ["# Memory index", "", ...lines, ""].join("\n");
const indexLine = (title, file, hook) => `- [${title}](${file}) — ${hook}`;

// a batch id in applyNewID's form (YYYYMMDD-hhmmss-<hex>), fixed for a fixture time
function batchId(at, hex) {
    const d = new Date(at);
    const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    return `${date}-${time}-${hex}`;
}

function emptyOp() {
    return {
        folder: "",
        memories: [],
        old: "",
        new: "",
        indexremove: [],
        indexadd: "",
        indexfolder: "",
        writename: "",
        writebody: "",
        docpath: "",
        docsection: "",
        docpassage: "",
        tofolder: "",
        settingspath: "",
        settingsvalue: "",
        stripharvester: false,
    };
}

// a change with every field the backend stores. paths are hashed as they are on disk now ([path, true] = must
// not exist yet); an applied change passes files, the hashes its check saw before the apply.
function change(kind, { paths, files, op, ...rest }) {
    const refs = files ?? paths.map(([path, mustNotExist]) => ({ path, sha256: mustNotExist ? "" : sha256File(path) }));
    return {
        id: memoryChangeId(kind, refs),
        kind,
        group: "",
        title: "",
        note: "",
        applylabel: "",
        effect: "",
        files: refs,
        evidence: [],
        diffs: [],
        indexdelta: NO_DELTA,
        ownindexdelta: NO_DELTA,
        status: "open",
        conflictfile: "",
        decidedat: 0,
        backupuntil: 0,
        applyid: "",
        ...rest,
        op: { ...emptyOp(), ...op },
    };
}

const applied = (at, applyId) => ({ status: "applied", decidedat: at, backupuntil: at + BACKUP_KEEP_MS, applyid: applyId });

function project(name, path, fields) {
    return {
        project: name,
        path,
        checkedat: 0,
        nextcheckat: 0,
        checking: false,
        lasterror: "",
        memories: 0,
        sessions: 0,
        folder: "",
        sharedwith: [],
        ownfolder: "",
        formershared: "",
        switchedat: 0,
        index: { exists: false, lines: 0, bytes: 0 },
        changes: [],
        batches: [],
        ...fields,
    };
}

function batch(kind, at, hex, changes, fields = {}) {
    return {
        id: batchId(at, hex),
        kind,
        at,
        changeids: changes.map((c) => c.id),
        skipped: [],
        indexbefore: { exists: false, lines: 0, bytes: 0 },
        indexafter: { exists: false, lines: 0, bytes: 0 },
        ...fields,
    };
}

const memoryFile = (name, description, body) =>
    ["---", `name: ${name}`, `description: ${description}`, "---", "", ...body.split("\n"), ""].join("\n");

function gitInit(dir) {
    execFileSync("git", ["-C", dir, "init", "-q", "--initial-branch=main"], { stdio: "pipe" });
}

// buildMemoryFixture writes the repos, memory folders and docs under root and returns the projects to register,
// the state each starts from, the backups its applied routine changes undo from, and what the scenario's steps
// compare against. Built again in the same root, it first drops what an earlier build's applies left there.
export function buildMemoryFixture(root, now = Date.now()) {
    const written = [];
    const write = (path, text) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
        written.push(path);
        return path;
    };
    const repo = (path) => {
        mkdirSync(path, { recursive: true });
        gitInit(path);
        return path;
    };
    const claudeFolder = (path) => join(root, "claude", "projects", slugifyPath(path), "memory");
    const backups = [];
    // a backup as Apply writes it: each file's hash before and after, and the original's bytes under files/<i>
    const backup = (id, kind, title, at, files) => {
        backups.push({
            id,
            manifest: {
                applyid: id,
                kind,
                title,
                createdat: at,
                files: files.map((f, i) => ({
                    path: f.path,
                    pre: sha256(f.pre),
                    post: f.post == null ? "" : sha256(f.post),
                    backup: join("files", String(i)),
                    ...(f.index ? { index: f.index } : {}),
                })),
            },
            files: files.map((f, i) => ({ rel: join("files", String(i)), data: f.pre })),
        });
        return id;
    };

    const mono = join(root, MEMORY_SHARED_REPO);
    const ownRepo = join(root, "own-repo");
    const paths = {
        own: claudeFolder(ownRepo),
        shared: claudeFolder(mono),
        ownA: claudeFolder(join(mono, "split-a")),
        ownB: claudeFolder(join(mono, "split-b")),
        ownC: claudeFolder(join(mono, "split-c")),
        ownF: claudeFolder(join(mono, "former")),
    };
    paths.ownIndex = join(paths.own, INDEX);
    paths.sharedIndex = join(paths.shared, INDEX);
    paths.doc = join(mono, "former", "CLAUDE.md");
    // what an earlier build's applies left: copies, settings, memories written after it
    rmSync(join(root, "claude"), { recursive: true, force: true });
    for (const sub of ["split-a", "split-b", "split-c"]) rmSync(join(mono, sub, ".claude"), { recursive: true, force: true });

    // ---- the own project: a routine batch this week, with a skip, whose changes undo; one from before ----
    repo(ownRepo);
    const ownAt = now - 2 * HOUR_MS;
    const ownOldAt = now - 10 * DAY_MS;
    const trims = [1, 2, 3].map((n) => {
        const name = `build-note-${n}.md`;
        const pre = memoryFile(`Build note ${n}`, `build note ${n}`, `Build step ${n} runs first. Verified 2026-07-2${n} (commit 64bc18${n}f).`);
        const post = memoryFile(`Build note ${n}`, `build note ${n}`, `Build step ${n} runs first.`);
        return { name, title: `Drop a past verification note from build note ${n}`, pre, post, path: join(paths.own, name) };
    });
    const flaky = { name: "flaky-retry-test.md", path: join(paths.own, "flaky-retry-test.md") };
    flaky.pre = memoryFile("Flaky retry test", "one run failed", "The retry test failed once on 2026-07-12 and passed on rerun.");
    flaky.line = indexLine("Flaky retry test", flaky.name, "one run of the retry test failed on 07-12");
    const changedTrim = { name: "deploy-note.md", path: join(paths.own, "deploy-note.md") };
    changedTrim.text = memoryFile("Deploy note", "deploy", "Deploy from the release branch. Edited after the check.");
    const ownLines = trims.map((t, i) => indexLine(`Build note ${i + 1}`, t.name, `build step ${i + 1}`));
    ownLines.splice(1, 0, flaky.line);
    ownLines.push(indexLine("Deploy note", changedTrim.name, "deploy from the release branch"));
    const ownIndexBefore = indexText(ownLines);
    const ownIndexAfter = indexText(ownLines.filter((l) => l !== flaky.line));
    for (const t of trims) write(t.path, t.post);
    write(changedTrim.path, changedTrim.text);
    write(paths.ownIndex, ownIndexAfter);

    const trimChanges = trims.map((t, i) =>
        change("trim", {
            files: [{ path: t.path, sha256: sha256(t.pre) }],
            title: t.title,
            applylabel: "Apply trim",
            effect: `Body ${signedBytes(Buffer.byteLength(t.post) - Buffer.byteLength(t.pre))}`,
            op: { folder: paths.own, memories: [t.name], old: t.pre, new: t.post },
            ...applied(ownAt, backup(`verify-mem-own-trim-${i + 1}`, "trim", t.title, ownAt, [{ path: t.path, pre: t.pre, post: t.post }])),
        })
    );
    const flakyTitle = "A one-time test result, not a rule";
    const ownIndexLines = ownIndexBefore.split("\n").slice(0, -1);
    const flakyAt = ownIndexLines.indexOf(flaky.line);
    const deleteChange = change("delete", {
        files: [{ path: flaky.path, sha256: sha256(flaky.pre) }],
        title: flakyTitle,
        applylabel: "Delete memory",
        effect: `Index ${signedBytes(-(Buffer.byteLength(flaky.line) + 1))}`,
        indexdelta: lineDelta(flaky.line, -1),
        op: { folder: paths.own, memories: [flaky.name], indexremove: [flaky.line] },
        ...applied(
            ownAt,
            backup("verify-mem-own-delete", "delete", flakyTitle, ownAt, [
                { path: flaky.path, pre: flaky.pre, post: null },
                {
                    path: paths.ownIndex,
                    pre: ownIndexBefore,
                    post: ownIndexAfter,
                    index: { removed: [flaky.line], at: flakyAt, after: ownIndexLines[flakyAt - 1], before: ownIndexLines[flakyAt + 1] },
                },
            ])
        ),
    });
    // found changed on disk when Arc applied the routine: the next check's
    const conflictTrim = change("trim", {
        files: [{ path: changedTrim.path, sha256: sha256("the deploy note as the check read it") }],
        title: "Drop a dated note from the deploy note",
        applylabel: "Apply trim",
        op: { folder: paths.own, memories: [changedTrim.name] },
        status: "conflict",
        conflictfile: changedTrim.path,
        decidedat: ownAt,
    });
    const oldDelete = change("delete", {
        files: [{ path: join(paths.own, "stale-note.md"), sha256: sha256("a stale note deleted last week") }],
        title: "A stale note no session read",
        applylabel: "Delete memory",
        op: { folder: paths.own, memories: ["stale-note.md"] },
        ...applied(ownOldAt, "verify-mem-own-old"),
    });
    const ownRoutine = batch("routine", ownAt, "0a000001", [...trimChanges, deleteChange], {
        skipped: [{ changeid: conflictTrim.id, kind: "trim", title: conflictTrim.title, reason: "changed", error: "" }],
        indexbefore: textStats(ownIndexBefore),
        indexafter: indexStats(paths.ownIndex),
    });
    const ownOld = batch("routine", ownOldAt, "0a000002", [oldDelete]);

    // ---- the shared folder of one repo, and three subprojects that load it ----
    const memA = Array.from({ length: SPLIT_A_MOVES }, (_, i) => ({ name: `a-only-${pad(i + 1)}.md`, title: `split-a note ${pad(i + 1)}`, for: [MEMORY_PROJECTS.splitA] }));
    const memAB = Array.from({ length: SPLIT_A_COPIES }, (_, i) => ({ name: `ab-shared-${pad(i + 1)}.md`, title: `shared lint rule ${pad(i + 1)}`, for: [MEMORY_PROJECTS.splitA, MEMORY_PROJECTS.splitB] }));
    const memB = [1, 2].map((i) => ({ name: `b-only-${pad(i)}.md`, title: `split-b api note ${pad(i)}`, for: [MEMORY_PROJECTS.splitB] }));
    const stale = [1, 2, 3].map((i) => ({ name: `stale-${pad(i)}.md`, title: `former detector note ${pad(i)}`, for: [] }));
    const repoWide = [1, 2, 3, 4].map((i) => ({ name: `repo-wide-${pad(i)}.md`, title: `repo-wide rule ${pad(i)}`, for: [MEMORY_PROJECTS.splitA, MEMORY_PROJECTS.splitB] }));
    const sharedMems = [...memA, ...memAB, ...memB, ...stale, ...repoWide];
    for (const m of sharedMems) {
        m.path = join(paths.shared, m.name);
        m.line = indexLine(m.title, m.name, `${m.title} for ${m.for.join(", ") || "no project"}`);
        m.text = memoryFile(m.title, m.title, `${m.title}: what it says.`);
    }
    repo(mono);
    for (const sub of ["split-a", "split-b", "split-c", "former"]) write(join(mono, sub, "README.md"), `# ${sub}\n`);
    for (const m of sharedMems) write(m.path, m.text);
    write(paths.sharedIndex, indexText(sharedMems.map((m) => m.line)));
    mkdirSync(paths.ownA, { recursive: true });
    mkdirSync(paths.ownB, { recursive: true });
    const sort = Object.fromEntries(sharedMems.map((m) => [m.name, { sha256: sha256File(m.path), projects: m.for }]));

    const moveOrCopy = (kind, m, ownFolder, others) =>
        change(kind, {
            paths: [[m.path], [join(ownFolder, m.name), true]],
            group: "shared",
            title: m.title,
            note:
                kind === "copy-here"
                    ? "Once every project that needs it has a copy, a later check offers to delete it from the shared memory."
                    : "",
            applylabel: kind === "copy-here" ? "Copy here" : "Move here",
            effect: `File ${Buffer.byteLength(m.text).toLocaleString("en-US")} B`,
            indexdelta: kind === "move-here" ? lineDelta(m.line, -1) : NO_DELTA,
            ownindexdelta: lineDelta(m.line, 1),
            evidence: [
                kind === "copy-here"
                    ? { tone: "none", text: `Also applies to ${others.join(", ")}, so the shared copy stays`, code: "" }
                    : { tone: "none", text: `Applies only to ${m.for[0]}`, code: "" },
            ],
            diffs: [
                ...(kind === "move-here" ? [{ path: paths.sharedIndex, note: "−1 line", lines: diffLines("-", m.line) }] : []),
                { path: join(ownFolder, INDEX), note: "+1 line", lines: diffLines("+", m.line) },
            ],
            op: {
                folder: paths.shared,
                memories: [m.name],
                tofolder: ownFolder,
                indexfolder: ownFolder,
                indexadd: m.line,
                indexremove: kind === "move-here" ? [m.line] : [],
            },
        });
    const settingsChange = (name, ownFolder, settingsPath, files) =>
        change("settings", {
            ...(files ? { files } : { paths: [[settingsPath, true]] }),
            group: "switch",
            title: `Point Claude Code at ${name}’s memory`,
            note: `Sessions started in ${name} after this load its own memory. Running sessions keep the shared memory until they restart.`,
            applylabel: "Switch memory",
            effect: "1 setting",
            evidence: [{ tone: "none", text: "Every other setting in the file stays as it is", code: "" }],
            diffs: [{ path: settingsPath, note: "+1 key", lines: diffLines("+", `  "autoMemoryDirectory": ${JSON.stringify(ownFolder)},`) }],
            op: { settingspath: settingsPath, settingsvalue: ownFolder },
        });
    const sharing = (name, path, ownFolder, sharedwith, changes, sessions) =>
        project(name, path, {
            checkedat: now - HOUR_MS,
            nextcheckat: now - HOUR_MS + CHECK_INTERVAL_MS,
            memories: sharedMems.length,
            sessions,
            folder: paths.shared,
            sharedwith,
            ownfolder: ownFolder,
            index: indexStats(paths.sharedIndex),
            ownindex: indexStats(join(ownFolder, INDEX)),
            changes,
            sort,
        });

    const splitA = {
        moves: memA.map((m) => moveOrCopy("move-here", m, paths.ownA, [])),
        copies: memAB.map((m) => moveOrCopy("copy-here", m, paths.ownA, [MEMORY_PROJECTS.splitB])),
        settings: settingsChange(MEMORY_PROJECTS.splitA, paths.ownA, join(mono, "split-a", ".claude", "settings.local.json")),
        failAt: SPLIT_A_FAIL_AT,
    };
    const splitBChanges = [
        ...memB.map((m) => moveOrCopy("move-here", m, paths.ownB, [])),
        moveOrCopy("copy-here", memAB[0], paths.ownB, [MEMORY_PROJECTS.splitA]),
        settingsChange(MEMORY_PROJECTS.splitB, paths.ownB, join(mono, "split-b", ".claude", "settings.local.json")),
    ];

    // ---- split-c switched three days ago: a copy and a move came over; the cleanup since removed the copy's source ----
    const splitCAt = now - 3 * DAY_MS;
    const cleanupAt = now - 2 * DAY_MS;
    const copied = { name: "c-copied.md", title: "Detector rules split-c also needs" };
    const movedC = { name: "c-only.md", title: "split-c ships as a static bundle" };
    for (const m of [copied, movedC]) {
        m.text = memoryFile(m.title, m.title, `${m.title}: what it says.`);
        m.line = indexLine(m.title, m.name, m.title);
        write(join(paths.ownC, m.name), m.text);
    }
    write(join(paths.ownC, INDEX), indexText([copied.line, movedC.line]));
    const settingsC = join(mono, "split-c", ".claude", "settings.local.json");
    write(settingsC, `{\n  "autoMemoryDirectory": ${JSON.stringify(paths.ownC)}\n}\n`);
    const splitCChanges = [
        { kind: "copy-here", m: copied },
        { kind: "move-here", m: movedC },
    ].map(({ kind, m }, i) =>
        change(kind, {
            files: [
                { path: join(paths.shared, m.name), sha256: sha256(m.text) },
                { path: join(paths.ownC, m.name), sha256: "" },
            ],
            group: "shared",
            title: m.title,
            applylabel: kind === "copy-here" ? "Copy here" : "Move here",
            op: {
                folder: paths.shared,
                memories: [m.name],
                tofolder: paths.ownC,
                indexfolder: paths.ownC,
                indexadd: m.line,
                indexremove: kind === "move-here" ? [m.line] : [],
            },
            ...applied(splitCAt, `verify-mem-split-c-${i + 1}`),
        })
    );
    splitCChanges.push({
        ...settingsChange(MEMORY_PROJECTS.splitC, paths.ownC, settingsC, [{ path: settingsC, sha256: "" }]),
        ...applied(splitCAt, "verify-mem-split-c-settings"),
    });
    const splitCBatch = batch("split", splitCAt, "0c000001", splitCChanges);

    // ---- the former-shared project: open removals, two doc moves, a failed check, and its batches ----
    const formerPath = join(mono, "former");
    const formerAt = now - 4 * DAY_MS;
    const removal = (m, fields = {}) =>
        change("remove-shared", {
            ...(fields.files ? {} : { paths: [[m.path]] }),
            group: "shared",
            title: m.title,
            applylabel: "Remove from shared memory",
            effect: `File ${signedBytes(-Buffer.byteLength(m.text))}`,
            indexdelta: lineDelta(m.line, -1),
            evidence: [{ tone: "ok", text: `Every project it applies to now loads its own memory: ${MEMORY_PROJECTS.former}`, code: "" }],
            diffs: [{ path: paths.sharedIndex, note: "−1 line", lines: diffLines("-", m.line) }],
            op: { folder: paths.shared, memories: [m.name], indexremove: [m.line] },
            ...fields,
        });
    const removedCopy = removal(
        { ...copied, path: join(paths.shared, copied.name) },
        { files: [{ path: join(paths.shared, copied.name), sha256: sha256(copied.text) }], ...applied(cleanupAt, "verify-mem-former-cleanup") }
    );
    const cleanupBatch = batch("cleanup", cleanupAt, "0f000001", [removedCopy]);

    const docs = [
        { name: "configurable-numbers.md", title: "Configurable-numbers rule belongs in the repo doc", passage: "- **Configurable numbers:** thresholds come from config, never literals." },
        { name: "contract-migrations.md", title: "Contract test parses detector migrations: repo rule", passage: "- **Migrations:** the contract test parses every detector migration." },
    ];
    const formerTrims = [1, 2].map((n) => ({ name: `detector-note-${n}.md`, title: `Drop a dated line from detector note ${n}` }));
    const formerSkips = [3, 4].map((n) => ({ name: `detector-note-${n}.md`, title: `Drop a dated line from detector note ${n}` }));
    for (const d of docs) {
        d.path = join(paths.ownF, d.name);
        d.line = indexLine(d.title, d.name, d.title);
        write(d.path, memoryFile(d.title, d.title, d.passage));
    }
    for (const t of [...formerTrims, ...formerSkips]) {
        t.path = join(paths.ownF, t.name);
        t.line = indexLine(t.title, t.name, t.title);
        write(t.path, memoryFile(t.title, t.title, "Detector notes."));
    }
    const formerIndex = write(join(paths.ownF, INDEX), indexText([...docs, ...formerTrims, ...formerSkips].map((x) => x.line)));
    write(paths.doc, "# former\n\n## Rules\n\n- Run the focused tests first.\n\n## Build\n\n- `task dev` runs the app.\n");
    const docChanges = docs.map((d) =>
        change("move-to-doc", {
            paths: [[paths.doc], [d.path]],
            title: d.title,
            note: "Leaves CLAUDE.md changed in your working tree. Commit it with your next change.",
            applylabel: "Move to CLAUDE.md",
            effect: `Index ${signedBytes(-(Buffer.byteLength(d.line) + 1))}`,
            indexdelta: lineDelta(d.line, -1),
            evidence: [{ tone: "none", text: "CLAUDE.md already documents repo rules under ", code: "## Rules" }],
            diffs: [
                { path: paths.doc, note: "## Rules", lines: diffLines("+", d.passage) },
                { path: formerIndex, note: "−1 line", lines: diffLines("-", d.line) },
            ],
            op: { folder: paths.ownF, memories: [d.name], indexremove: [d.line], docpath: paths.doc, docsection: "## Rules", docpassage: d.passage },
        })
    );
    const formerTrimChanges = formerTrims.map((t) =>
        change("trim", {
            files: [{ path: t.path, sha256: sha256(`${t.title} before the trim`) }],
            title: t.title,
            applylabel: "Apply trim",
            op: { folder: paths.ownF, memories: [t.name] },
            ...applied(formerAt, `verify-mem-former-${t.name}`),
        })
    );
    const formerSkipChanges = formerSkips.map((t) =>
        change("trim", {
            files: [{ path: t.path, sha256: sha256(`${t.title} as the check read it`) }],
            title: t.title,
            applylabel: "Apply trim",
            op: { folder: paths.ownF, memories: [t.name] },
            status: "conflict",
            conflictfile: t.path,
            decidedat: formerAt,
        })
    );
    const formerRoutine = batch("routine", formerAt, "0f000002", formerTrimChanges, {
        skipped: formerSkipChanges.map((c) => ({ changeid: c.id, kind: c.kind, title: c.title, reason: "changed", error: "" })),
        indexbefore: indexStats(formerIndex),
        indexafter: indexStats(formerIndex),
    });
    const formerChecked = now - DAY_MS;

    const states = {
        [MEMORY_PROJECTS.own]: project(MEMORY_PROJECTS.own, ownRepo, {
            checkedat: ownAt,
            nextcheckat: ownAt + CHECK_INTERVAL_MS,
            memories: trims.length + 1,
            sessions: 42,
            folder: paths.own,
            index: indexStats(paths.ownIndex),
            changes: [...trimChanges, deleteChange, conflictTrim, oldDelete],
            batches: [ownRoutine, ownOld],
        }),
        [MEMORY_PROJECTS.splitA]: sharing(MEMORY_PROJECTS.splitA, join(mono, "split-a"), paths.ownA, [MEMORY_PROJECTS.splitB], [...splitA.moves, ...splitA.copies, splitA.settings], 17),
        [MEMORY_PROJECTS.splitB]: sharing(MEMORY_PROJECTS.splitB, join(mono, "split-b"), paths.ownB, [MEMORY_PROJECTS.splitA], splitBChanges, 9),
        [MEMORY_PROJECTS.splitC]: project(MEMORY_PROJECTS.splitC, join(mono, "split-c"), {
            checkedat: splitCAt - HOUR_MS,
            nextcheckat: splitCAt - HOUR_MS + CHECK_INTERVAL_MS,
            memories: 2,
            sessions: 6,
            folder: paths.ownC,
            formershared: paths.shared,
            switchedat: splitCAt,
            index: indexStats(join(paths.ownC, INDEX)),
            changes: splitCChanges,
            batches: [splitCBatch],
        }),
        [MEMORY_PROJECTS.former]: project(MEMORY_PROJECTS.former, formerPath, {
            checkedat: formerChecked,
            nextcheckat: formerChecked + CHECK_INTERVAL_MS,
            lasterror: MEMORY_FAILED_ERROR,
            memories: docs.length + formerTrims.length + formerSkips.length,
            sessions: 30,
            folder: paths.ownF,
            formershared: paths.shared,
            switchedat: now - 20 * DAY_MS,
            index: indexStats(formerIndex),
            changes: [...stale.map((m) => removal(m)), removedCopy, ...docChanges, ...formerTrimChanges, ...formerSkipChanges],
            batches: [cleanupBatch, formerRoutine],
        }),
    };

    return {
        root,
        written,
        projects: Object.values(states).map((s) => ({ name: s.project, path: s.path })),
        states,
        backups,
        batches: { ownRoutine: ownRoutine.id, ownOld: ownOld.id, splitC: splitCBatch.id, formerCleanup: cleanupBatch.id, formerRoutine: formerRoutine.id },
        splitA,
        docs: docChanges,
        trims: trims.map((t, i) => ({ ...t, change: trimChanges[i] })),
        paths: { ...paths, settingsC },
    };
}

// writeMemoryStates writes each state to <dataDir>/memhygiene/<FileName>.json and returns the paths.
export function writeMemoryStates(dataDir, states) {
    const out = [];
    for (const [name, state] of Object.entries(states)) {
        const path = memoryStatePath(dataDir, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(state, null, 2));
        out.push(path);
    }
    return out;
}

// writeMemoryBackups writes each backup's manifest and original files where Undo reads them.
export function writeMemoryBackups(dataDir, backups) {
    for (const b of backups) {
        const dir = memoryBackupDir(dataDir, b.id);
        rmSync(dir, { recursive: true, force: true });
        for (const f of b.files) {
            mkdirSync(dirname(join(dir, f.rel)), { recursive: true });
            writeFileSync(join(dir, f.rel), f.data);
        }
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, MANIFEST), JSON.stringify(b.manifest, null, 2));
    }
}

// memoryBackupsUnder is every backup whose files all lie under root: the fixture's own, and every apply the
// scenario made on it, never one of the user's.
export function memoryBackupsUnder(dataDir, root) {
    const dir = join(dataDir, STATE_DIR, BACKUP_DIR);
    if (!existsSync(dir)) return [];
    const under = (p) => {
        const rel = relative(root, p);
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    };
    return readdirSync(dir).filter((id) => {
        try {
            const files = JSON.parse(readFileSync(join(dir, id, MANIFEST), "utf8")).files ?? [];
            return files.length > 0 && files.every((f) => under(f.path));
        } catch {
            return false;
        }
    });
}

// settleMemoryStates returns the states with every undecided change kept and no failed check, so nothing waits.
export function settleMemoryStates(states, now = Date.now()) {
    const out = {};
    for (const [name, state] of Object.entries(states)) {
        out[name] = {
            ...state,
            checking: false,
            lasterror: "",
            changes: state.changes.map((c) =>
                c.status === "applied" || c.status === "kept" ? c : { ...c, status: "kept", conflictfile: "", decidedat: now }
            ),
        };
    }
    return out;
}
