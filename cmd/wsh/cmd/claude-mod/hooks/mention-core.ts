// tagging other live agent tabs from the prompt with @@: the typeahead rows, the tags a submitted prompt
// holds and the context that tells this agent how to reach them. kept free of the engine so vitest can
// run it; register.ts holds the hooks and the `wsh agents list` fetch.

// one `wsh agents list --json` row, the fields the mention needs
export type AgentRow = { tabid: string; name: string; harness: string; state: string; title?: string };
// one typeahead row, as prompt.autocomplete takes it
export type Suggestion = { text: string; label: string; description: string };

// bare @ is claude code's file mention, whose rows would bury ours
const TRIGGER = "@@";
// the short tab id `wsh agents list` prints
const ID8_LEN = 8;
// shorter id prefixes would match by accident too often
const MIN_ID_PREFIX = 4;
// not after a word character or @, so `a@@b` and the `@@@` of a diff are not tags
const TAG_RE = /(?<![\w@])@@([A-Za-z0-9_][A-Za-z0-9_-]*)/g;
// a duplicate tag's id8 suffix, which still names its tab once the other duplicate has closed
const ID8_SUFFIX_RE = new RegExp(`-([0-9a-f]{${ID8_LEN}})$`);
const NON_SLUG_RE = /[^a-z0-9_]+/g;

const id8 = (row: AgentRow) => row.tabid.slice(0, ID8_LEN).toLowerCase();
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function slugOf(row: AgentRow): string {
    const slug = row.name
        .toLowerCase()
        .replace(NON_SLUG_RE, "-")
        .replace(/^-+|-+$/g, "");
    return slug || id8(row);
}

export function mentionQuery(token: string): string | null {
    return token.startsWith(TRIGGER) ? token.slice(TRIGGER.length) : null;
}

// a bare "@@" is a new tag starting, so the roster may have changed since the last one
export function needsFetch(cachedStart: number | null, token: string, start: number): boolean {
    return token === TRIGGER || cachedStart !== start;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parseAgents(stdout: string): AgentRow[] {
    let data: unknown;
    try {
        data = JSON.parse(stdout);
    } catch (err) {
        throw new Error(`wsh agents list --json printed no JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(data)) {
        throw new Error("wsh agents list --json printed no array");
    }
    return data.map((v) => {
        if (typeof v?.tabid !== "string" || v.tabid === "") {
            throw new Error("wsh agents list --json printed a row without a tabid");
        }
        const row: AgentRow = { tabid: v.tabid, name: str(v.name), harness: str(v.harness), state: str(v.state) };
        if (str(v.title)) {
            row.title = v.title;
        }
        return row;
    });
}

// tab names are often the project's, so a shared slug is common and gets the short id to tell rows apart
export function tagOf(row: AgentRow, rows: readonly AgentRow[]): string {
    const slug = slugOf(row);
    const shared = rows.some((r) => r.tabid !== row.tabid && slugOf(r) === slug);
    return shared ? `${TRIGGER}${slug}-${id8(row)}` : `${TRIGGER}${slug}`;
}

function describe(row: AgentRow): string {
    const head = `${id8(row)} ${row.harness} ${row.state}`;
    const title = oneLine(row.title ?? "");
    return title ? `${head} · ${title}` : head;
}

// the title is what tells same-named tabs apart, so the query matches it as well as the tag and id
export function suggestions(rows: readonly AgentRow[], query: string): Suggestion[] {
    const q = query.toLowerCase();
    return rows.flatMap((row) => {
        const tag = tagOf(row, rows);
        const hit = [tag.slice(TRIGGER.length), row.tabid, row.title ?? ""].some((s) => s.toLowerCase().includes(q));
        return hit ? [{ text: tag, label: tag, description: describe(row) }] : [];
    });
}

export function submittedTags(text: string): string[] {
    const seen = new Map<string, string>();
    for (const m of text.matchAll(TAG_RE)) {
        const key = m[0].toLowerCase();
        if (!seen.has(key)) {
            seen.set(key, m[0]);
        }
    }
    return [...seen.values()];
}

// other origins are the cockpit, the bridge and other agents: a quoted @@x there must never make this
// agent message a third one. a slash command's text is not the user's message to anyone
export function isTaggable(e: { origin: { kind: string }; command?: unknown }): boolean {
    return e.origin.kind === "composer" && e.command == null;
}

type Resolved = { row: AgentRow } | { candidates: AgentRow[] } | null;

// the first rule with any match decides: the tag a row gets now, a slug only one row has, a tab id prefix
function resolveTag(tag: string, rows: readonly AgentRow[]): Resolved {
    const text = tag.slice(TRIGGER.length).toLowerCase();
    const prefix = text.match(ID8_SUFFIX_RE)?.[1] ?? text;
    const rules: ((r: AgentRow) => boolean)[] = [
        (r) => tagOf(r, rows).slice(TRIGGER.length) === text,
        (r) => slugOf(r) === text,
        (r) => prefix.length >= MIN_ID_PREFIX && r.tabid.toLowerCase().startsWith(prefix),
    ];
    for (const rule of rules) {
        const [first, ...rest] = rows.filter(rule);
        if (first && rest.length === 0) {
            return { row: first };
        }
        if (first) {
            return { candidates: [first, ...rest] };
        }
    }
    return null;
}

const titled = (row: AgentRow) => {
    const title = oneLine(row.title ?? "");
    return title ? `${id8(row)} (${title})` : id8(row);
};

function reachLine(tag: string, row: AgentRow): string {
    const title = oneLine(row.title ?? "");
    const what = `${row.harness}, ${row.state}${title ? `, working on: ${title}` : ""}`;
    const t = row.tabid;
    return (
        `- ${tag} is the live agent tab ${t} (${what}). Message it with \`wsh agents send ${t} "<message>"\`, ` +
        `read its last answer with \`wsh agents read ${t}\`, wait for it to settle with \`wsh agents wait ${t}\`.`
    );
}

// one entry per prompt. a tag that names nothing is said here, never a failed prompt
export function mentionContext(tags: readonly string[], roster: readonly AgentRow[] | { error: string }): string {
    if (tags.length === 0) {
        return "";
    }
    if ("error" in roster) {
        return (
            `The user tagged other agent tabs (${tags.join(", ")}), but Arc could not read the live agents to ` +
            `resolve them: ${roster.error}. \`wsh agents list\` shows the live agents in this project.`
        );
    }
    const reach: string[] = [];
    const problems: string[] = [];
    for (const tag of tags) {
        const res = resolveTag(tag, roster);
        if (res === null) {
            problems.push(`- ${tag} names no live agent in this project; \`wsh agents list\` shows the live ones.`);
        } else if ("candidates" in res) {
            const which = res.candidates.map(titled).join(", ");
            problems.push(`- ${tag} is ambiguous: it could be ${which}; ask the user which one they mean.`);
        } else {
            reach.push(reachLine(tag, res.row));
        }
    }
    const lines = [
        "The user tagged other live agents in this prompt. You do the talking: the user's text is not sent to them.",
    ];
    if (reach.length > 0) {
        lines.push(
            ...reach,
            `When the prompt asks a tagged agent for something back, send with \`wsh agents send --wait <tab> "<message>"\` ` +
                `and continue with its answer; when it only tells the agent something, send and move on.`,
            "Write the message yourself and keep it to what the user asked; do not forward the user's prompt verbatim."
        );
    }
    lines.push(...problems);
    return lines.join("\n");
}
