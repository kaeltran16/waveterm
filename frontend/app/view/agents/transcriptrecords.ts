// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Transcript JSONL parsed once per line. The live stream keeps these records across chunks and hands the same
// objects to every projection pass, so a projector reads a record and never mutates one.

/** A parsed transcript line; undefined for a malformed line, so records stay index-aligned with their lines. */
export type TranscriptRecord = unknown;

export function parseTranscriptLines(lines: readonly string[]): TranscriptRecord[] {
    return lines.map((line) => {
        try {
            return JSON.parse(line);
        } catch {
            return undefined;
        }
    });
}
