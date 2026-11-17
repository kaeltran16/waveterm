import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { remarkSoftBreaks } from "./softbreaks";

describe("remarkSoftBreaks", () => {
    const run = (tree: Root) => {
        remarkSoftBreaks()(tree);
        return tree;
    };
    const para = (...children: any[]): Root => ({ type: "root", children: [{ type: "paragraph", children }] });
    const kids = (tree: Root) => (tree.children[0] as any).children;

    it("turns each newline inside a text node into a break", () => {
        const tree = run(
            para(
                { type: "text", value: "a.txt\nb.txt\nc " },
                { type: "strong", children: [{ type: "text", value: "bold" }] }
            )
        );
        expect(kids(tree)).toEqual([
            { type: "text", value: "a.txt" },
            { type: "break" },
            { type: "text", value: "b.txt" },
            { type: "break" },
            { type: "text", value: "c " },
            { type: "strong", children: [{ type: "text", value: "bold" }] },
        ]);
    });

    it("breaks at a newline that starts or ends a text node, without empty text", () => {
        const tree = run(
            para({ type: "emphasis", children: [{ type: "text", value: "x" }] }, { type: "text", value: "\nnext\r\n" })
        );
        expect(kids(tree)).toEqual([
            { type: "emphasis", children: [{ type: "text", value: "x" }] },
            { type: "break" },
            { type: "text", value: "next" },
            { type: "break" },
        ]);
    });

    it("leaves text with no newline, inline code and code blocks alone", () => {
        const tree: Root = {
            type: "root",
            children: [
                {
                    type: "paragraph",
                    children: [
                        { type: "text", value: "one line" },
                        { type: "inlineCode", value: "a\nb" },
                    ],
                },
                { type: "code", value: "x\ny" },
            ],
        };
        expect(run(structuredClone(tree))).toEqual(tree);
    });
});
