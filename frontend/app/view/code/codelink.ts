// frontend/app/view/code/codelink.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: turn a link inside a previewed markdown file into a file in the same repository. Relative
// links are how docs point at each other and at code, and the external opener refuses anything that
// is not a web or mail address, so without this they did nothing at all.

export interface DocLinkTarget {
    rel: string;
    line: number | null;
}

// a scheme ("https:", "mailto:", a drive letter) or a protocol-relative host is not a repository path
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
// GitHub's line anchors: #L12 and #L12-L20
const LINE_ANCHOR_RE = /^L(\d+)(?:-L\d+)?$/;

export function resolveDocLink(fromRel: string, href: string): DocLinkTarget | null {
    if (href === "" || href.startsWith("#") || EXTERNAL_RE.test(href)) {
        return null;
    }
    const hashAt = href.indexOf("#");
    const fragment = hashAt === -1 ? "" : href.slice(hashAt + 1);
    const pathPart = href.slice(0, hashAt === -1 ? href.length : hashAt).split("?")[0];
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathPart);
    } catch {
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
    const lineMatch = LINE_ANCHOR_RE.exec(fragment);
    return { rel: segs.join("/"), line: lineMatch ? Number(lineMatch[1]) : null };
}
