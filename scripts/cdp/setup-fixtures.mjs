// Isolated CDP fixtures for the Setup surface scenarios. A scenario must never reach the real
// agentsync RPCs (write/apply/adopt touch the user's real harness files, vault and skills), so these
// helpers swap RpcApi's mock client for a deterministic in-page simulation of all six agentsync
// commands, delegate every other command to the original route, and put any source file a scenario
// opens under a temporary folder. Installation is all-or-nothing: a partial install rolls itself back.
//
// Interfaces for the scenario author (scripts/cdp/scenarios.mjs):
//   createSetupFixture(name, tempRoot)  -> fixture (plain data: datasets + files to write)
//   installSetupFixture(h, fixture)     -> handle; throws (after rolling back) if it cannot install
//   restoreSetupFixture(h, handle)      -> restores the prior mock and removes the fixture's files
//   arrangeSetupFixture / teardownSetupFixture wrap temp-root creation + the above for scenario
//   arrange/teardown; assertSetupFixtureInstalled(h) is the hard gate before any mutation click.
//   readSetupFixture(h) / controlSetupFixture(h, op, arg) / callSummary(snapshot) drive and inspect it.
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";

export const SETUP_SCENARIO_NAMES = ["setup-instructions", "setup-skills", "setup-import", "setup-narrow"];

const WINDOW_KEY = "__arcSetupFixture";

export class SetupFixtureError extends Error {
    constructor(message, errors) {
        super(message);
        this.name = "SetupFixtureError";
        this.errors = errors;
    }
}

const msg = (e) => String(e?.message ?? e);

// the primary error plus every failure of its cleanup, so neither is lost
function combine(primary, secondary, label) {
    if (secondary.length === 0) {
        return primary;
    }
    return new SetupFixtureError(`${msg(primary)}; ${label}: ${secondary.map(msg).join("; ")}`, [primary, ...secondary]);
}

// ---- the in-page simulation ----

// Serialized with toString() and evaluated in the dev app, so it must stay self-contained: no imports,
// no module-level references. Node tests run the same function directly. It speaks the agentsync wire
// (pkg/wshrpc/wshrpctypes_agentsync.go): the shapes below are what the real RPCs take and return.
export function createFixtureRuntime(fixture) {
    const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    const msg = (e) => String(e?.message ?? e);
    // mirrors wshrpc.AgentSyncKeepVault: the keep value that picks the vault copy of a vault skill
    const KEEP_VAULT = "vault";
    const s = {
        contents: copy(fixture.contents ?? {}),
        status: copy(fixture.status),
        skills: copy(fixture.skills),
        disk: copy(fixture.steering),
        adopt: copy(fixture.adopt),
        variants: copy(fixture.variants ?? {}),
        partialApply: null,
        partialAdopt: null,
        snapshotStore: false,
    };
    const faults = {};
    const delays = {};
    const log = [];
    const diskWrites = [];
    const controls = [];
    let seq = 0;
    let clock = s.disk.mtime || 0;
    let lastMutation = null;

    // UnixMilli like the real RPC, and strictly increasing so a conflict check by mtime still sees each write
    const tick = () => (clock = Math.max(clock + 1, Date.now()));
    const note = (entry) => log.push({ seq: ++seq, ...entry });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const unique = (list) => [...new Set(list)];
    const presentHarnesses = () => s.status.harnesses.filter((h) => h.present);
    // an empty shared doc leaves every harness blank, whatever its file holds
    const docBlank = () => s.disk.content.trim() === "";
    const markStale = () => presentHarnesses().forEach((h) => (h.steering = docBlank() ? "blank" : "stale"));

    // ---- steering ----

    const read = () => {
        note({ kind: "read", command: "agentsyncsteeringread", outcome: "ok" });
        return { path: s.disk.path, content: s.disk.content, mtime: s.disk.mtime };
    };

    // like agentsync.WriteSteering: basemtime 0 skips the check (Overwrite), a missing doc never conflicts
    const write = (d) => {
        const basemtime = d.basemtime ?? 0;
        const base = { kind: "write-attempt", data: { content: d.content, basemtime } };
        lastMutation = "save-failed";
        if (basemtime !== 0 && s.disk.mtime > 0 && basemtime !== s.disk.mtime) {
            note({ ...base, outcome: "conflict", accepted: false });
            return { mtime: s.disk.mtime, conflict: true };
        }
        s.disk = { ...s.disk, content: d.content, mtime: tick() };
        diskWrites.push({ content: d.content, mtime: s.disk.mtime, overwrite: basemtime === 0 });
        markStale();
        lastMutation = "save";
        note({ ...base, outcome: "accepted", accepted: true });
        return { mtime: s.disk.mtime, conflict: false };
    };

    // ---- apply ----

    const applyEntry = (d) => ({ kind: "apply", dryrun: d?.dryrun === true, afterSave: lastMutation === "save" });
    const adoptEntry = (d) => ({
        kind: d.apply === true ? "adopt-apply" : "adopt-review",
        keep: d.keep ?? {},
        skip: d.skip ?? [],
        apply: d.apply === true,
    });

    const apply = (d) => {
        const dry = d?.dryrun === true;
        const entry = applyEntry(d);
        const present = presentHarnesses();
        const actions = present.map((h) => ({ kind: "write-steering", runtime: h.runtime, path: h.path }));
        if (dry) {
            note({ ...entry, outcome: "ok" });
            return { actions };
        }
        lastMutation = "apply";
        const converge = (h) => {
            h.steering = docBlank() ? "blank" : "current";
        };
        if (s.partialApply) {
            const { after, message } = s.partialApply;
            s.partialApply = null;
            present.slice(0, after).forEach(converge);
            note({ ...entry, outcome: "partial", converged: Math.min(after, present.length) });
            throw new Error(message);
        }
        present.forEach(converge);
        // shipped bodies are reseeded into the vault on every apply; the user's .arc deltas are never touched
        for (const [n, body] of Object.entries(s.contents.shipped ?? {})) {
            s.contents.vault[n] = body;
        }
        for (const skill of s.skills.skills ?? []) {
            for (const [rt, state] of Object.entries(skill.states ?? {})) {
                if (state === "differs") {
                    skill.states[rt] = "synced";
                    s.contents.dests[`${skill.name}/${rt}`] = s.contents.vault[skill.name];
                }
            }
        }
        note({ ...entry, outcome: "ok", converged: present.length });
        return { actions };
    };

    // ---- adopt ----

    const unmanaged = () => s.skills.unmanaged ?? [];
    const recomputeUnresolved = () => {
        s.skills.unresolved = unique(unmanaged().filter((m) => m.bodydiff && !m.vault).map((m) => m.name));
    };

    // what each copy holds, so keys/files/bodydiff are derived against whichever copy seeds, not stored
    const treeOf = (c) => (s.adopt.trees ?? {})[`${c.name}/${c.runtime}`] ?? { fm: {}, body: "", files: {} };
    const compare = (seed, c) => {
        const { keys: _k, files: _f, bodydiff: _b, ...base } = c;
        if (c === seed || (c.name === seed.name && c.runtime === seed.runtime)) {
            return { ...base, seed: true, bodydiff: false };
        }
        const a = treeOf(seed);
        const b = treeOf(c);
        const keys = Object.keys(b.fm).filter((k) => a.fm[k] !== b.fm[k]).sort();
        const files = Object.keys(b.files).filter((f) => a.files[f] !== b.files[f]).sort();
        return {
            ...base,
            seed: false,
            ...(keys.length ? { keys } : {}),
            ...(files.length ? { files } : {}),
            bodydiff: a.body.trim() !== b.body.trim(),
        };
    };

    // like PlanAdopt: a skipped name contributes nothing, even when it also has a keep. A copy under a
    // vault skill's name is compared against the vault and never unresolved; any other name's kept copy
    // (else its first) seeds, and the rest are compared against it.
    const plan = (d) => {
        const skip = new Set(d.skip ?? []);
        const keep = Object.fromEntries(Object.entries(d.keep ?? {}).filter(([n]) => !skip.has(n)));
        const canonical = new Set((s.skills.skills ?? []).map((k) => k.name));
        const copies = unmanaged().filter((m) => !skip.has(m.name));
        for (const [n, rt] of Object.entries(keep)) {
            if (canonical.has(n) && rt !== KEEP_VAULT) {
                throw new Error(`cannot keep ${rt}'s copy of "${n}": the skill is already managed by Arc`);
            }
            if (!canonical.has(n) && (rt === KEEP_VAULT || !copies.some((c) => c.name === n && c.runtime === rt))) {
                throw new Error(`cannot keep ${rt}'s copy of "${n}": ${rt} holds no unmanaged copy of it`);
            }
        }
        const moves = [];
        const unresolved = [];
        for (const n of unique(copies.map((c) => c.name))) {
            const mine = copies.filter((c) => c.name === n);
            if (canonical.has(n)) {
                moves.push(...mine.map((c) => ({ ...c, seed: false, vault: true })));
                continue;
            }
            const seed = mine.find((c) => c.runtime === keep[n]) ?? mine[0];
            const rows = mine.map((c) => compare(seed, c));
            if (!keep[n] && rows.some((r) => r.bodydiff)) {
                unresolved.push(n);
            }
            moves.push(...rows);
        }
        return { keep, canonical, moves, unresolved };
    };

    const presentStates = () =>
        Object.fromEntries((s.skills.columns ?? []).filter((c) => c.present).map((c) => [c.runtime, "synced"]));

    const adopt = (d) => {
        const apply = d.apply === true;
        const entry = adoptEntry(d);
        let p;
        try {
            p = plan(d);
        } catch (e) {
            note({ ...entry, outcome: "rejected", reason: msg(e) });
            throw e;
        }
        const result = { moves: p.moves, unresolved: p.unresolved };
        if (!apply) {
            note({ ...entry, outcome: "ok" });
            return result;
        }
        // a snapshot store turns the apply into a dry run and says so
        if (s.snapshotStore) {
            note({ ...entry, outcome: "dryrun" });
            return { ...result, dryrun: true };
        }
        lastMutation = "adopt";
        // an unresolved name moves nothing; a vault skill's copy moves only when the vault copy was kept
        const blocked = new Set(p.unresolved);
        const movable = unique(p.moves.map((m) => m.name)).filter(
            (n) => !blocked.has(n) && (!p.canonical.has(n) || p.keep[n] === KEEP_VAULT)
        );
        const partial = s.partialAdopt;
        s.partialAdopt = null;
        const names = partial ? movable.slice(0, partial.after) : movable;
        for (const n of names) {
            const leaving = unmanaged().filter((m) => m.name === n);
            s.skills.unmanaged = unmanaged().filter((m) => m.name !== n);
            if (p.canonical.has(n)) {
                // set aside under skills-replaced; the reconcile then writes the vault copy in its place
                const row = s.skills.skills.find((k) => k.name === n);
                leaving.forEach((m) => (row.states[m.runtime] = "synced"));
                leaving.forEach((m) => (s.contents.dests[`${n}/${m.runtime}`] = s.contents.vault[n]));
                continue;
            }
            s.skills.skills.push({ name: n, description: "Adopted by the fixture", states: presentStates() });
            s.contents.vault[n] = `adopted ${n}`;
        }
        recomputeUnresolved();
        if (partial) {
            note({ ...entry, outcome: "partial", moved: names });
            throw new Error(partial.message);
        }
        note({ ...entry, outcome: "ok", moved: names });
        return result;
    };

    // ---- dispatch ----

    const handlers = {
        agentsyncstatus: () => {
            note({ kind: "read", command: "agentsyncstatus", outcome: "ok" });
            return { ...copy(s.status), steeringdoc: s.disk.path };
        },
        agentsyncsteeringread: read,
        agentsyncskills: () => {
            note({ kind: "read", command: "agentsyncskills", outcome: "ok" });
            return copy(s.skills);
        },
        agentsyncsteeringwrite: write,
        agentsyncapply: apply,
        agentsyncadopt: adopt,
    };

    const call = async (command, data) => {
        if (!Object.prototype.hasOwnProperty.call(handlers, command)) {
            note({ kind: "rejected", command, outcome: "unhandled" });
            throw new Error(`setup fixture: unhandled agentsync command "${command}"`);
        }
        if (delays[command]) {
            await sleep(delays[command]);
        }
        const fault = faults[command];
        if (fault) {
            if (fault.times !== undefined && --fault.times <= 0) {
                delete faults[command];
            }
            // an attempted mutation is logged like any other attempt, so a no-mutation assertion cannot pass falsely
            if (command === "agentsyncsteeringwrite") {
                note({ kind: "write-attempt", data: { content: data?.content, basemtime: data?.basemtime ?? 0 }, outcome: "error", accepted: false });
                lastMutation = "save-failed";
            } else if (command === "agentsyncapply") {
                note({ ...applyEntry(data), outcome: "error", reason: fault.message });
                lastMutation = "apply";
            } else if (command === "agentsyncadopt") {
                note({ ...adoptEntry(data ?? {}), outcome: "error", reason: fault.message });
            } else {
                note({ kind: "failed", command, outcome: "error" });
            }
            throw new Error(fault.message);
        }
        return handlers[command](copy(data) ?? {});
    };

    // ---- scenario controls (outside the app's own call log) ----

    const ops = {
        // an edit outside Arc: new content and a new mtime, so a save based on the old read conflicts.
        // exists: false deletes the doc (mtime 0), which reads back empty
        setDisk: ({ content = "", exists = true }) => {
            s.disk = { ...s.disk, content: exists ? content : "", mtime: exists ? tick() : 0 };
            markStale();
        },
        // times: 1 fails only the next call, e.g. the first agentsyncstatus read a visit makes
        fail: ({ command, message, times }) => {
            if (message == null) {
                delete faults[command];
            } else {
                faults[command] = { message, times };
            }
        },
        delay: ({ command, ms }) => {
            delays[command] = ms;
        },
        partialApply: (arg) => {
            s.partialApply = arg;
        },
        partialAdopt: (arg) => {
            s.partialAdopt = arg;
        },
        // the store is an ARC_SNAPSHOT copy: an adopt apply moves nothing and returns dryrun
        snapshotStore: ({ on = true }) => {
            s.snapshotStore = on;
        },
        // the skill directory (with its SKILL.md) must already exist in the fixture's files, like every copy
        discoverNew: ({ name, runtime }) => {
            s.skills.unmanaged = [...unmanaged(), { runtime, name, from: `${s.adopt.destinations?.[runtime] ?? ""}/${name}`, seed: false, bodydiff: false }];
        },
        // a canonical edit lands in the vault source; shipped sources are read-only
        editSource: ({ name, content }) => {
            const row = (s.skills.skills ?? []).find((k) => k.name === name);
            if (!row || s.contents.shipped[name] !== undefined) {
                throw new Error(`setup fixture: "${name}" is not a user-owned vault skill`);
            }
            s.contents.vault[name] = content;
            // an unmanaged local shadow is not a destination: it keeps its state and its own bytes
            Object.keys(row.states).forEach((rt) => {
                if (row.states[rt] !== "unmanaged") {
                    row.states[rt] = "differs";
                }
            });
        },
        useVariant: ({ key }) => {
            const v = s.variants[key];
            if (!v) {
                throw new Error(`setup fixture: unknown variant "${key}"`);
            }
            if (v.skills) s.skills = copy(v.skills);
            if (v.steering) {
                s.disk = copy(v.steering);
                clock = Math.max(clock, s.disk.mtime || 0);
            }
            if (v.status) s.status = copy(v.status);
        },
        resetLog: () => {
            log.length = 0;
            diskWrites.length = 0;
            lastMutation = null;
        },
    };

    return {
        call,
        control(op, arg) {
            if (!Object.prototype.hasOwnProperty.call(ops, op)) {
                throw new Error(`setup fixture: unknown control "${op}"`);
            }
            ops[op](arg ?? {});
            if (op !== "resetLog") {
                controls.push({ op, arg: copy(arg) });
            }
            return true;
        },
        snapshot() {
            return copy({ log, diskWrites, controls, disk: s.disk, skills: s.skills, status: s.status, contents: s.contents });
        },
    };
}

// call-log digest for scenario assertions: what the app attempted versus what actually landed
export function callSummary(snapshot) {
    const log = snapshot.log;
    const only = (kind) => log.filter((e) => e.kind === kind);
    const writes = only("write-attempt");
    const applies = only("apply").filter((e) => !e.dryrun);
    const reviews = only("adopt-review");
    const adoptApplies = only("adopt-apply");
    const last = (list) => (list.length ? list[list.length - 1] : null);
    return {
        reads: log.filter((e) => e.kind === "read").reduce((m, e) => ({ ...m, [e.command]: (m[e.command] ?? 0) + 1 }), {}),
        writeAttempts: writes.length,
        writeConflicts: writes.filter((e) => e.outcome === "conflict").length,
        diskWrites: snapshot.diskWrites.length,
        overwriteWrites: snapshot.diskWrites.filter((w) => w.overwrite).length,
        applies: applies.length,
        applyErrors: applies.filter((e) => e.outcome === "error").length,
        adoptErrors: adoptApplies.filter((e) => e.outcome === "error").length,
        applyAfterSave: applies.filter((e) => e.afterSave).length,
        applyOnly: applies.filter((e) => !e.afterSave).length,
        adoptReviews: reviews.length,
        adoptApplies: adoptApplies.length,
        adoptAppliesMoved: adoptApplies.filter((e) => e.outcome === "ok" || e.outcome === "partial").length,
        adoptRejected: adoptApplies.filter((e) => e.outcome === "rejected").length,
        unhandled: only("rejected").length,
        lastWrite: last(writes),
        lastReview: last(reviews),
        lastAdoptApply: last(adoptApplies),
    };
}

// ---- datasets ----

const SKILL_FILE = "SKILL.md";
// the markers pkg/agentsync/steering.go writes around Arc's region of a harness file
const STEERING_BEGIN = "<!-- ARC-STEERING:BEGIN (generated — do not edit; managed by Arc) -->";
const STEERING_END = "<!-- ARC-STEERING:END -->";
// one unbroken 200-character token, for a doc that must wrap rather than widen its box
export const LONG_TOKEN = "0123456789".repeat(20);
const skillDoc = (name, body, extra = "") => `---\nname: ${name}\ndescription: ${name} fixture skill\n${extra}---\n\n${body}\n`;

function buildFixture(name, ownedDir) {
    const home = join(ownedDir, "home");
    const vaultRoot = join(ownedDir, "vault", "skills");
    const roots = { claude: join(home, ".claude", "skills"), codex: join(home, ".codex", "skills") };
    const files = [];
    const addFile = (path, content) => files.push({ path, content });
    const posix = (p) => p.replace(/\\/g, "/");

    // content the in-page runtime rewrites on Apply: the vault body, what each harness holds, shipped sources
    const contents = { vault: {}, shipped: {}, dests: {}, deltas: {} };

    // user-owned vault skills are real files so Open SKILL.md has something canonical to open
    const vaultSkill = (n, over = {}) => {
        const body = skillDoc(n, `${n} vault source body`);
        addFile(join(vaultRoot, n, SKILL_FILE), body);
        contents.vault[n] = body;
        for (const rt of Object.keys(roots)) {
            // a link is no destination: Arc writes nothing through it
            if (over.states?.[rt] === "linked") continue;
            contents.dests[`${n}/${rt}`] = over.states?.[rt] === "differs" ? skillDoc(n, `${n} stale harness body`) : body;
        }
        return { name: n, description: `${n} fixture skill`, states: { claude: "synced", codex: "synced" }, ...over };
    };
    // the vault holds a stale replica of the shipped body plus the user's .arc deltas; Apply reseeds the
    // body and must leave the deltas alone
    const shipped = (n, over = {}) => {
        const stale = skillDoc(n, `${n} shipped body v1`);
        const current = skillDoc(n, `${n} shipped body v2`);
        addFile(join(vaultRoot, n, SKILL_FILE), stale);
        contents.vault[n] = stale;
        contents.shipped[n] = current;
        for (const [rt, files] of Object.entries(over.deltas ?? {})) {
            const sidecarFiles = files.map((f) => [join(vaultRoot, n, ".arc", rt, f), `# ${rt} override for ${n}\n`]);
            sidecarFiles.forEach(([path, text]) => addFile(path, text));
            sidecarFiles.forEach(([path, text]) => (contents.deltas[relative(ownedDir, path)] = text));
            addFile(join(vaultRoot, n, ".arc", `${rt}.yaml`), "model: fixture-model\n");
            contents.deltas[relative(ownedDir, join(vaultRoot, n, ".arc", `${rt}.yaml`))] = "model: fixture-model\n";
        }
        // claude loads a shipped skill from the arc plugin, so only codex holds a projected copy
        contents.dests[`${n}/codex`] = stale;
        return { name: n, description: `${n} fixture skill`, states: { claude: "plugin", codex: "differs" }, ...over };
    };

    const managed = [
        vaultSkill("commit-helper", { deltas: { claude: ["model"] }, states: { claude: "synced", codex: "unmanaged" } }),
        vaultSkill("vault-drift", { states: { claude: "differs", codex: "synced" } }),
        // codex's folder holds a link under this vault skill's name, listed in linked below
        vaultSkill("vault-linked", { states: { claude: "synced", codex: "linked" } }),
        shipped("design", { deltas: { codex: ["agents/openai.yaml"] } }),
        shipped("cockpit"),
    ];

    // moves[].from is the skill directory, as the RPC returns it; the SKILL.md sits beneath it. Bodies are
    // shared unless a copy says otherwise, so bodydiff always matches what the files hold.
    const trees = {};
    const copyOf = (runtime, n, over = {}) => {
        const dir = join(roots[runtime], n);
        const { frontmatter = "", body = `${n} shared body`, extraFiles = {}, ...move } = over;
        addFile(join(dir, SKILL_FILE), skillDoc(n, body, frontmatter));
        for (const [rel, text] of Object.entries(extraFiles)) {
            addFile(join(dir, ...rel.split("/")), text);
        }
        // the page runtime has no file access; it compares these descriptions of the files just written
        const fm = { name: n, description: `${n} fixture skill` };
        for (const line of frontmatter.split("\n").filter(Boolean)) {
            fm[line.slice(0, line.indexOf(":"))] = line;
        }
        trees[`${n}/${runtime}`] = { fm, body, files: extraFiles };
        return { runtime, name: n, from: dir, seed: false, bodydiff: false, ...move };
    };
    const unmanagedCopies = [
        copyOf("claude", "identical-copy"),
        copyOf("codex", "identical-copy"),
        copyOf("claude", "differs-body"),
        copyOf("codex", "differs-body", { bodydiff: true, body: "differs-body codex variant" }),
        copyOf("codex", "codex-only-skill"),
        copyOf("claude", "fm-delta"),
        copyOf("codex", "fm-delta", {
            keys: ["model"],
            files: ["agents/openai.yaml"],
            frontmatter: "model: fixture-model\n",
            extraFiles: { "agents/openai.yaml": "interface:\n  display_name: fixture\n" },
        }),
        // a local copy under a vault skill's name: compared against the vault, never unresolved, and moved
        // (set aside) only when the vault copy is kept
        copyOf("codex", "commit-helper", { body: "commit-helper local shadow body", vault: true, bodydiff: true }),
    ];
    // a shadow's destination holds the user's own bytes, not the vault body: sync must leave them alone
    for (const c of unmanagedCopies) {
        if (contents.vault[c.name] !== undefined) {
            contents.dests[`${c.name}/${c.runtime}`] = files.find((f) => f.path === join(c.from, SKILL_FILE)).content;
        }
    }
    // present on disk but not in the listing until a scenario calls discoverNew
    copyOf("claude", "late-arrival");

    const columns = [
        { runtime: "claude", label: "Claude Code", present: true },
        { runtime: "codex", label: "Codex", present: true },
        { runtime: "opencode", label: "OpenCode", present: false },
    ];
    // every link in a harness skills folder, a vault skill's name included: neither adopted nor written through
    const link = (runtime, n) => ({ runtime, name: n, path: join(roots[runtime], n), target: join(ownedDir, "elsewhere", n) });
    const linked = [link("claude", "linked-tool"), link("codex", "vault-linked")];
    const skills = {
        skills: managed,
        columns,
        skillsroot: vaultRoot,
        unmanaged: unmanagedCopies,
        unresolved: ["differs-body"],
        linked,
    };

    const sharedDoc = "# Shared instructions\n\nPrefer small diffs. Verify before claiming done.\n";
    const longDoc = Array.from({ length: 60 }, (_, i) => `- rule ${i + 1}: keep changes small and verify them`).join("\n") + "\n";
    const steering = {
        path: join(ownedDir, "vault", "steering", "AGENTS.md"),
        content: name === "setup-narrow" ? longDoc : sharedDoc,
        // UnixMilli like the real RPC: saved an hour before the fixture was built
        mtime: Date.now() - 60 * 60 * 1000,
    };
    // each present harness file holds the user's own lines and Arc's region, as the reconcile writes it
    const region = (body) => `${STEERING_BEGIN}\n${body.trimEnd()}\n${STEERING_END}\n`;
    const harnessFile = (runtime, steeringState) =>
        `# My own ${runtime} notes\n\nKeep these.\n\n${region(steeringState === "stale" ? "# Shared instructions\n\nAn older version." : steering.content)}`;
    const harness = (runtime, label, rel, present, steeringState, over = {}) => {
        const path = join(home, ...rel);
        if (present) {
            addFile(path, harnessFile(runtime, steeringState));
        }
        return { runtime, label, path, present, steering: steeringState, skillsmanaged: 4, skillsunmanaged: 2, ...over };
    };
    const status = {
        harnesses: [
            harness("claude", "Claude Code", [".claude", "CLAUDE.md"], true, "current"),
            harness("codex", "Codex", [".codex", "AGENTS.md"], true, "stale"),
            harness("pi", "Pi", [".pi", "agent", "AGENTS.md"], true, "current", {
                note: "pi settings do not point at the synced skills",
                notetone: "warn",
            }),
            harness("opencode", "OpenCode", [".config", "opencode", "AGENTS.md"], false, "absent"),
        ],
        steeringdoc: steering.path,
        skillsroot: vaultRoot,
    };

    const patch = (value, mutate) => {
        const c = JSON.parse(JSON.stringify(value));
        mutate(c);
        return c;
    };
    const variants = {
        "no-skills": { skills: patch(skills, (c) => Object.assign(c, { skills: [], unmanaged: [], unresolved: [], linked: [] })) },
        "unavailable-column": { skills: patch(skills, (c) => c.columns.forEach((col) => (col.present = false))) },
        "doc-absent": { steering: { ...steering, content: "", mtime: 0 } },
        "long-doc": { steering: { ...steering, content: longDoc } },
        // an empty shared doc: every present harness is blank, whatever its file holds
        blank: {
            steering: { ...steering, content: "" },
            status: patch(status, (c) => c.harnesses.filter((x) => x.present).forEach((x) => (x.steering = "blank"))),
        },
        "long-token": { steering: { ...steering, content: `${LONG_TOKEN}\n` } },
        // pi is set up but has not received the doc yet
        "not-written": { status: patch(status, (c) => (c.harnesses.find((x) => x.runtime === "pi").steering = "absent")) },
    };

    return {
        name,
        ownedDir,
        files,
        contents,
        status,
        steering,
        skills,
        adopt: { trees, destinations: { claude: posix(roots.claude), codex: posix(roots.codex) } },
        variants,
    };
}

// plain data, no side effects: the files are written and the mock installed by installSetupFixture
export function createSetupFixture(name, tempRoot) {
    if (!SETUP_SCENARIO_NAMES.includes(name)) {
        throw new Error(`unknown setup fixture "${name}"; expected one of ${SETUP_SCENARIO_NAMES.join(", ")}`);
    }
    if (!tempRoot) {
        throw new Error("createSetupFixture needs a temp root: fixture files must never live in real user paths");
    }
    return buildFixture(name, join(tempRoot, `setup-fixture-${name}`));
}

// ---- installation ----

const DISCOVER_SCRIPT = `(() => {
    const hits = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\\/wshclientapi\\.ts(\\?|$)/.test(n));
    return hits.length ? hits[hits.length - 1] : null;
})()`;

function installScript(url, fixture) {
    const { files: _files, ...pageFixture } = fixture;
    return `(async () => {
    const mod = await import(${JSON.stringify(url)});
    const api = mod.RpcApi;
    if (!api || typeof api.setMockRpcClient !== "function") throw new Error("setup fixture: RpcApi not found at " + ${JSON.stringify(url)});
    if (window.${WINDOW_KEY}) throw new Error("setup fixture: already installed");
    const runtime = (${createFixtureRuntime.toString()})(${JSON.stringify(pageFixture)});
    const prev = api.mockClient ?? null;
    const isAgentSync = (c) => typeof c === "string" && c.startsWith("agentsync");
    const mock = {
        mockWshRpcCall(client, command, data, opts) {
            if (isAgentSync(command)) return runtime.call(command, data);
            return prev ? prev.mockWshRpcCall(client, command, data, opts) : client.wshRpcCall(command, data, opts);
        },
        mockWshRpcStream(client, command, data, opts) {
            if (isAgentSync(command)) throw new Error("setup fixture: agentsync stream " + command + " is not simulated");
            return prev ? prev.mockWshRpcStream(client, command, data, opts) : client.wshRpcStream(command, data, opts);
        },
    };
    window.${WINDOW_KEY} = { api, prev, mock, runtime };
    api.setMockRpcClient(mock);
    return true;
})()`;
}

// a real call through RpcApi proves the app's own module instance routes to the simulation
const PROBE_SCRIPT = `(async () => {
    const f = window.${WINDOW_KEY};
    if (!f) return "missing";
    if (f.api.mockClient !== f.mock) return "replaced";
    const status = await f.api.AgentSyncStatusCommand(window.TabRpcClient ?? null);
    if (!status || !Array.isArray(status.harnesses)) return "not-intercepted";
    f.runtime.control("resetLog");
    return "ok";
})()`;

const CHECK_SCRIPT = `(() => {
    const f = window.${WINDOW_KEY};
    if (!f) return "missing";
    return f.api.mockClient === f.mock ? "ok" : "replaced";
})()`;

const restoreScript = (tolerateMissing) => `(() => {
    const f = window.${WINDOW_KEY};
    if (!f) {
        if (${tolerateMissing}) return "absent";
        throw new Error("setup fixture: interception is gone (page reloaded?); the safety boundary dropped mid-scenario");
    }
    if (f.api.mockClient !== f.mock && f.api.mockClient !== f.prev) {
        throw new Error("setup fixture: RpcApi mock was replaced by something else; not restoring over it");
    }
    f.api.setMockRpcClient(f.prev);
    if (f.api.mockClient !== f.prev) throw new Error("setup fixture: prior RpcApi mock was not restored");
    delete window.${WINDOW_KEY};
    return "restored";
})()`;

// the hard gate before any mutation interaction: throws unless the app's RpcApi is routed to the fixture
export async function assertSetupFixtureInstalled(h) {
    const state = await h.ev(CHECK_SCRIPT);
    if (state !== "ok") {
        throw new Error(`setup fixture is not intercepting agentsync (${state}); refusing to touch the app`);
    }
}

function assertOwned(fixture) {
    for (const f of fixture.files) {
        const rel = relative(fixture.ownedDir, f.path);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
            throw new Error(`setup fixture file ${f.path} is outside its temporary folder ${fixture.ownedDir}`);
        }
    }
}

async function runCleanup(cleanup) {
    const errors = [];
    for (const item of [...cleanup].reverse()) {
        try {
            await item.run();
            cleanup.splice(cleanup.indexOf(item), 1);
        } catch (e) {
            errors.push(new Error(`${item.label}: ${msg(e)}`));
        }
    }
    return errors;
}

export async function installSetupFixture(h, fixture, deps = {}) {
    const fs = deps.fs ?? nodeFs;
    // each obligation is recorded before the side effect it undoes
    const cleanup = [];
    try {
        assertOwned(fixture);
        const url = await h.ev(DISCOVER_SCRIPT);
        if (typeof url !== "string" || !url) {
            throw new Error("setup fixture: cannot find the app's wshclientapi module URL (is the dev app loaded?)");
        }
        // rolling back must never restore over an install this call did not make
        if ((await h.ev(CHECK_SCRIPT)) !== "missing") {
            throw new Error("setup fixture: already installed in this page; restore it first");
        }
        cleanup.push({ label: "remove fixture files", run: () => fs.rmSync(fixture.ownedDir, { recursive: true, force: true }) });
        for (const f of fixture.files) {
            fs.mkdirSync(dirname(f.path), { recursive: true });
            fs.writeFileSync(f.path, f.content);
        }
        cleanup.push({ label: "restore RpcApi mock", run: () => h.ev(restoreScript(true)) });
        await h.ev(installScript(url, fixture));
        const probe = await h.ev(PROBE_SCRIPT);
        if (probe !== "ok") {
            throw new Error(`setup fixture: installation probe failed (${probe})`);
        }
    } catch (e) {
        const rollback = await runCleanup(cleanup);
        throw combine(e, rollback, "rollback failed");
    }
    // after a successful install a missing marker is a dropped boundary, not a no-op
    cleanup.find((c) => c.label === "restore RpcApi mock").run = () => h.ev(restoreScript(false));
    return { name: fixture.name, ownedDir: fixture.ownedDir, cleanup };
}

export async function restoreSetupFixture(h, handle) {
    const errors = await runCleanup(handle.cleanup);
    if (errors.length > 0) {
        throw new SetupFixtureError(`setup fixture restore failed: ${errors.map(msg).join("; ")}`, errors);
    }
}

export async function readSetupFixture(h) {
    await assertSetupFixtureInstalled(h);
    return h.ev(`window.${WINDOW_KEY}.runtime.snapshot()`);
}

export async function controlSetupFixture(h, op, arg) {
    await assertSetupFixtureInstalled(h);
    await h.ev(`window.${WINDOW_KEY}.runtime.control(${JSON.stringify(op)}, ${JSON.stringify(arg ?? {})})`);
}

// ---- scenario wrappers ----

// creates the temp root, installs, and on any failure removes what it created: the runner cannot tear
// down a context that arrange never returned
export async function arrangeSetupFixture(h, name, deps = {}) {
    const fs = deps.fs ?? nodeFs;
    const root = fs.mkdtempSync(join(deps.tmpdir ?? tmpdir(), "arc-setup-fixture-"));
    try {
        const fixture = createSetupFixture(name, root);
        const handle = await installSetupFixture(h, fixture, deps);
        return { root, fixture, handle };
    } catch (e) {
        const errors = [];
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch (r) {
            errors.push(r);
        }
        throw combine(e, errors, "temp root cleanup failed");
    }
}

export async function teardownSetupFixture(h, ctx, deps = {}) {
    const fs = deps.fs ?? nodeFs;
    const errors = [];
    try {
        await restoreSetupFixture(h, ctx.handle);
    } catch (e) {
        errors.push(e);
    }
    try {
        fs.rmSync(ctx.root, { recursive: true, force: true });
    } catch (e) {
        errors.push(e);
    }
    if (errors.length > 0) {
        throw new SetupFixtureError(`setup fixture teardown failed: ${errors.map(msg).join("; ")}`, errors);
    }
}
