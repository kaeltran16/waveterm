// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A lead's run report (Run.report, the markdown `wsh jarvis complete --report` files) read as the design's
// structured report (design L508-537, parser L1023, classification L1406-1418). Pure.

export type ReportItem = {
    text: string;
    hash: string;
    tag: string;
    dot: "ok" | "warn" | "accent" | "faint" | "muted";
    dim: boolean;
};
export type ReportSection = { heading: string; count: string; items: ReportItem[] };
export type RunReport = { title: string; lead: string; sections: ReportSection[] };

type Kind = "landed" | "verified" | "answered" | "forwarded" | "live" | "other";

function kindOf(heading: string): Kind {
    const k = heading.toLowerCase();
    for (const kind of ["landed", "verified", "answered", "forwarded", "live"] as const) {
        if (k.startsWith(kind)) {
            return kind;
        }
    }
    return "other";
}

function item(raw: string, kind: Kind): ReportItem {
    let text = raw.replace(/`/g, "");
    let hash = "";
    let tag = "";
    const hm = kind === "landed" ? /^([0-9a-f]{7,8})\s+(.*)$/.exec(text) : null;
    if (hm != null) {
        hash = hm[1];
        text = hm[2];
    }
    const tm = /\s*\((t-\d+(?:\s*\+\s*t-\d+)*)\)\s*$/.exec(text);
    if (tm != null) {
        tag = tm[1];
        text = text.slice(0, tm.index);
    }
    const pm = tag === "" ? /^(t-\d+):\s*/.exec(text) : null;
    if (pm != null) {
        tag = pm[1];
        text = text.slice(pm[0].length);
    }
    const none = text.toLowerCase() === "none";
    const notChecked = /^NOT checked/.test(text);
    const fail = /failures in|fail(ed)?\b/i.test(text) && !/0 fail/i.test(text);
    const pass = /\bPASS\b|\bpass\b|exit 0/.test(text);
    const dim = none || notChecked;
    const dot: ReportItem["dot"] = dim
        ? "faint"
        : kind === "live" || kind === "verified"
          ? fail
              ? "warn"
              : pass
                ? "ok"
                : "muted"
          : kind === "landed"
            ? "ok"
            : kind === "answered"
              ? "accent"
              : "muted";
    return { text, hash, tag, dot, dim };
}

export function parseRunReport(md: string): RunReport | null {
    if (md.trim() === "") {
        return null;
    }
    const out: RunReport = { title: "", lead: "", sections: [] };
    let sec: { heading: string; raw: string[] } | null = null;
    const secs: { heading: string; raw: string[] }[] = [];
    for (const rawLine of md.split("\n")) {
        const l = rawLine.trimEnd();
        if (/^# /.test(l)) {
            out.title = l.slice(2).trim();
        } else if (/^## /.test(l)) {
            sec = { heading: l.slice(3).trim(), raw: [] };
            secs.push(sec);
        } else if (/^- /.test(l) && sec != null) {
            sec.raw.push(l.slice(2).trim());
        } else if (/^\s+\S/.test(l) && sec != null && sec.raw.length > 0) {
            sec.raw[sec.raw.length - 1] += " " + l.trim();
        } else if (l.trim() !== "" && sec == null && out.lead === "") {
            out.lead = l.trim();
        }
    }
    out.sections = secs.map((s) => {
        const kind = kindOf(s.heading);
        const items = s.raw.map((r) => item(r, kind));
        const real = items.filter((i) => i.text.toLowerCase() !== "none").length;
        return { heading: s.heading, count: real > 0 ? String(real) : "none", items };
    });
    return out;
}
