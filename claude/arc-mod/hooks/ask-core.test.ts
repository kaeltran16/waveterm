import { describe, expect, it } from "vitest";
import { answersFor, askPayload, cardCanAsk, parseAskReply } from "./ask-core";

const color = { question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] };
const sizes = { question: "Which sizes?", header: "Sizes", multiSelect: true, options: [{ label: "S" }, { label: "M" }, { label: "L" }] };

describe("cardCanAsk", () => {
    it("takes choice questions with options", () => {
        expect(cardCanAsk([color, { ...sizes, kind: "choice" }])).toBe(true);
    });
    it("sends the whole call native when any question is text or number, or has no options", () => {
        expect(cardCanAsk([color, { question: "Name?", header: "Name", multiSelect: false, kind: "text", options: [] }])).toBe(false);
        expect(cardCanAsk([{ ...color, kind: "number" }])).toBe(false);
        expect(cardCanAsk([{ ...color, options: [] }])).toBe(false);
        expect(cardCanAsk([])).toBe(false);
    });
});

describe("askPayload", () => {
    it("is the questions container wsh ask reads, previews included", () => {
        const preview = "x".repeat(50000);
        const parsed = JSON.parse(askPayload([{ ...color, options: [{ label: "Red", description: "warm", preview }, { label: "Blue" }] }]));
        expect(parsed).toEqual({
            questions: [
                {
                    question: "Which color?",
                    header: "Color",
                    multiSelect: false,
                    options: [{ label: "Red", description: "warm", preview }, { label: "Blue" }],
                },
            ],
        });
    });
});

describe("parseAskReply", () => {
    it("reads the last JSON line", () => {
        expect(parseAskReply('noise\n{"answers":[{"selectedindexes":[1]}],"cancelled":false}\n')).toEqual({
            answers: [{ selectedindexes: [1] }],
            cancelled: false,
        });
    });
    it("reads a cancel with null answers", () => {
        expect(parseAskReply('{"answers":null,"cancelled":true}')).toEqual({ answers: [], cancelled: true });
    });
    it("is null when wsh printed nothing usable", () => {
        expect(parseAskReply("")).toBeNull();
        expect(parseAskReply("Error: timeout")).toBeNull();
        expect(parseAskReply('{"other":1}')).toBeNull();
    });
});

describe("answersFor", () => {
    it("maps indexes to labels, joins a multi-select, and uses typed text verbatim", () => {
        expect(
            answersFor([color, sizes, { ...color, question: "Again?" }], {
                answers: [{ selectedindexes: [1] }, { selectedindexes: [0, 2] }, { text: "Green, please" }],
                cancelled: false,
            })
        ).toEqual({ "Which color?": "Blue", "Which sizes?": "S, L", "Again?": "Green, please" });
    });
    it("leaves out an unanswered question and an index past the options", () => {
        expect(answersFor([color, sizes], { answers: [{ selectedindexes: [7] }], cancelled: false })).toEqual({});
    });
});
