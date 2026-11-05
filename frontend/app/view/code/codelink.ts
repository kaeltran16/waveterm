// frontend/app/view/code/codelink.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: turn a link inside a previewed markdown file into a file in the same repository. Relative
// links are how docs point at each other and at code, and the external opener refuses anything that
// is not a web or mail address, so without this they did nothing at all.

export interface DocLinkTarget {
    rel: string;
    line: number | null;
    // a heading slug, resolved against the target's outline once it opens
    anchor: string | null;
}

// a scheme ("https:", "mailto:", a drive letter) or a protocol-relative host is not a repository path
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
// GitHub's line anchors: #L12 and #L12-L20
const LINE_ANCHOR_RE = /^L(\d+)(?:-L\d+)?$/;
// what GitHub strips from a heading's text to make its anchor
const SLUG_DROP_RE = /[^\p{L}\p{M}\p{N}\s_-]/gu;

// GitHub's heading anchors, in document order: a repeat takes the next free "-n", as github-slugger does
export function slugHeadings(names: readonly string[]): string[] {
    const seen = new Map<string, number>();
    return names.map((name) => {
        const base = name.toLowerCase().replace(SLUG_DROP_RE, "").replace(/\s/g, "-");
        let slug = base;
        while (seen.has(slug)) {
            const n = seen.get(base) + 1;
            seen.set(base, n);
            slug = `${base}-${n}`;
        }
        seen.set(slug, 0);
        return slug;
    });
}

function decode(s: string): string | null {
    try {
        return decodeURIComponent(s);
    } catch {
        return null;
    }
}

export function resolveDocLink(fromRel: string, href: string): DocLinkTarget | null {
    if (href === "" || href === "#" || EXTERNAL_RE.test(href)) {
        return null;
    }
    const hashAt = href.indexOf("#");
    const fragment = hashAt === -1 ? "" : (decode(href.slice(hashAt + 1)) ?? "");
    const lineMatch = LINE_ANCHOR_RE.exec(fragment);
    const line = lineMatch ? Number(lineMatch[1]) : null;
    const anchor = lineMatch == null && fragment !== "" ? fragment : null;
    if (hashAt === 0) {
        return { rel: fromRel, line, anchor };
    }
    const pathPart = href.slice(0, hashAt === -1 ? href.length : hashAt).split("?")[0];
    const decoded = decode(pathPart);
    if (decoded == null) {
        return null;
    }
    const segs = decoded.startsWith("/") ? [] : fromRel.split("/").slice(0, -1);
    for (const seg of decoded.split("/")) {
        if (seg === "" || seg === ".") {
            continue;
        }
        if (seg === "..") {
            if (segs.length === 0) {
                return null;
            }
            segs.pop();
        } else {
            segs.push(seg);
        }
    }
    if (segs.length === 0) {
        return null;
    }
    return { rel: segs.join("/"), line, anchor };
}
