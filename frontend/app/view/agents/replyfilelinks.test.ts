import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { codeSpanLink, FILE_LINE_PROP, FILE_PATH_PROP, proseLinks, remarkFileLinks } from "./replyfilelinks";

describe("codeSpanLink", () => {
    it("links a code span that is one path, with its line", () => {
        expect(codeSpanLink("frontend/app/a.ts:42")).toEqual({ path: "frontend/app/a.ts", line: 42 });
        expect(codeSpanLink(" package.json ")).toEqual({ path: "package.json", line: null });
        expect(codeSpanLink("C:/Users/dev/x.go")).toEqual({ path: "C:/Users/dev/x.go", line: null });
    });

    it("leaves a span that is more than a path, or none", () => {
        expect(codeSpanLink("go test ./pkg/x")).toBeNull();
        expect(codeSpanLink("wsh effort show")).toBeNull();
        expect(codeSpanLink("https://example.com/a.ts")).toBeNull();
    });
});

describe("proseLinks", () => {
    it("splits prose around the paths with a folder in them", () => {
        expect(proseLinks("See pkg/a.go:12, then fix it.")).toEqual([
            "See ",
            { path: "pkg/a.go", line: 12, raw: "pkg/a.go:12" },
            ", then fix it.",
        ]);
    });

    it("leaves a bare name and plain prose alone", () => {
        expect(proseLinks("Node.js reads package.json and/or 1.2.3")).toEqual([
            "Node.js reads package.json and/or 1.2.3",
        ]);
    });
});

describe("remarkFileLinks", () => {
    const run = (tree: Root) => {
        remarkFileLinks()(tree);
        return tree;
    };
    const para = (...children: any[]): Root => ({ type: "root", children: [{ type: "paragraph", children }] });

    it("wraps a path code span and a prose path in marked links", () => {
        const tree = run(
            para({ type: "text", value: "edit src/x.ts now " }, { type: "inlineCode", value: "a/b.md:3" })
        );
        expect((tree.children[0] as any).children).toEqual([
            { type: "text", value: "edit " },
            {
                type: "link",
                url: "",
                children: [{ type: "text", value: "src/x.ts" }],
                data: { hProperties: { [FILE_PATH_PROP]: "src/x.ts" } },
            },
            { type: "text", value: " now " },
            {
                type: "link",
                url: "",
                children: [{ type: "inlineCode", value: "a/b.md:3" }],
                data: { hProperties: { [FILE_PATH_PROP]: "a/b.md", [FILE_LINE_PROP]: 3 } },
            },
        ]);
    });

    it("leaves text inside an existing link alone", () => {
        const link = { type: "link", url: "https://x.dev", children: [{ type: "text", value: "docs/a.md" }] };
        const tree = run(para(link));
        expect((tree.children[0] as any).children).toEqual([link]);
    });
});
