// Pure helpers for the prose-question bridge. No external imports so the repo's vitest
// can cover it. The default export is a no-op: pi auto-loads every file in the extensions
// directory, and this module is a dependency, not an extension.

export interface ProseOption {
    label: string;
    description?: string;
}

export interface ProseQuestion {
    question: string;
    options?: ProseOption[];
}

// Fences are stripped only for the option scan: "- item" lines inside code would otherwise
// read as choices. The question candidate deliberately uses the RAW text (see below).
const FENCE_RE = /```[\s\S]*?```/g;

// paragraphs splits on blank lines and returns non-empty, trimmed paragraphs.
function paragraphs(text: string): string[] {
    return text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
}

// optionScan collects 2-4 chip candidates, one per line: "Approach A:"-style headers
// (label "Approach A", description = the rest of the line), "A)" / "B." / "C:" lines, and
// "- " bullets. Agents write option lists with single newlines, not blank-line
// paragraphs, so the scan is line-based (a paragraph-level regex would swallow the whole
// list into one description). De-duplicated by label, capped at 4.
function optionScan(text: string): ProseOption[] {
    const cleaned = text.replace(FENCE_RE, "");
    const options: ProseOption[] = [];
    const seen = new Set<string>();
    const push = (o: ProseOption) => {
        if (seen.has(o.label) || options.length >= 4) {
            return;
        }
        seen.add(o.label);
        options.push(o);
    };
    for (const line of cleaned.split("\n")) {
        const t = line.trim();
        const pm = /^([A-Za-z]+)\s+([A-Z]):\s*(.*)$/.exec(t);
        if (pm) {
            push({ label: `${pm[1]} ${pm[2]}`, description: pm[3].trim() || undefined });
            continue;
        }
        const m = /^([A-Z])[).:]\s*(.+)$/.exec(t);
        if (m) {
            push({ label: m[1], description: m[2] });
        } else if (t.startsWith("- ")) {
            push({ label: t.slice(2) });
        }
    }
    return options;
}

// detectProseQuestion classifies the final assistant text of a settled turn. v1 rule: the
// LAST paragraph of the RAW text must end with "?" (a trailing code fence therefore misses
// — pinned limitation). Options ride along when 2-4 are found anywhere in the message.
export function detectProseQuestion(lastAssistantText: string): ProseQuestion | null {
    const ps = paragraphs(lastAssistantText);
    if (ps.length === 0) {
        return null;
    }
    const question = ps[ps.length - 1];
    if (!question.endsWith("?")) {
        return null;
    }
    const options = optionScan(lastAssistantText);
    return { question, options: options.length >= 2 ? options : undefined };
}

export default function wavetermProseCore(): void {
    // no-op dependency module
}
