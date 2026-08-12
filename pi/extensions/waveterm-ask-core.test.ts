import { describe, expect, it } from "vitest";
import {
    buildAskEnvelope,
    buildAskPayload,
    DECLINE_MESSAGE,
    ENVELOPE_PREFIX,
    ENVELOPE_SUFFIX,
    parseAskResult,
} from "./waveterm-ask-core";

const QUESTIONS = [
    {
        question: "A or B?",
        header: "Pick",
        multiSelect: false,
        options: [{ label: "A", description: "option A", preview: "mockup A" }, { label: "B" }],
    },
];

describe("buildAskPayload", () => {
    it("emits the questions container the wsh ask parser accepts", () => {
        const payload = JSON.parse(buildAskPayload(QUESTIONS));
        expect(payload.questions).toHaveLength(1);
        expect(payload.questions[0].options[0]).toEqual({
            label: "A",
            description: "option A",
            preview: "mockup A",
        });
        expect(payload.questions[0].options[1].preview).toBeUndefined();
    });
});

describe("parseAskResult", () => {
    it("parses the answered shape", () => {
        const r = parseAskResult(`{"answers":[{"selectedindexes":[1]}],"cancelled":false}`);
        expect(r.cancelled).toBe(false);
        expect(r.answers[0].selectedindexes).toEqual([1]);
    });
    it("parses the cancelled shape", () => {
        const r = parseAskResult(`{"answers":null,"cancelled":true}`);
        expect(r.cancelled).toBe(true);
        expect(r.answers).toEqual([]);
    });
    it("throws on malformed output", () => {
        expect(() => parseAskResult("not json")).toThrow();
    });
});

describe("buildAskEnvelope", () => {
    it("formats the canonical answered envelope", () => {
        const env = buildAskEnvelope({ answers: [{ selectedindexes: [1] }], cancelled: false }, QUESTIONS);
        expect(env.content[0].text).toBe(`${ENVELOPE_PREFIX} "A or B?"="B". ${ENVELOPE_SUFFIX}`);
        expect(env.details.answers[0]).toEqual({
            questionIndex: 0,
            question: "A or B?",
            selectedIndexes: [1],
        });
    });
    it("formats free-text answers verbatim", () => {
        const env = buildAskEnvelope({ answers: [{ text: "neither" }], cancelled: false }, QUESTIONS);
        expect(env.content[0].text).toBe(`${ENVELOPE_PREFIX} "A or B?"="neither". ${ENVELOPE_SUFFIX}`);
    });
    it("uses the decline message for cancelled", () => {
        const env = buildAskEnvelope({ answers: [], cancelled: true }, QUESTIONS);
        expect(env.content[0].text).toBe(DECLINE_MESSAGE);
        expect(env.details.cancelled).toBe(true);
    });
});
