// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// TickNumber's pure logic (moment 12), kept out of ticknumber.tsx so it is testable; its own name, because a
// ticknumber.ts beside ticknumber.tsx would win the `element/ticknumber` import.

export type TickDir = -1 | 0 | 1;

// up (+1) when the new value is larger, down (-1) when smaller, 0 when unchanged
export function tickDirection(prev: number, next: number): TickDir {
    return next > prev ? 1 : next < prev ? -1 : 0;
}

// the width, in characters, the number holds while both values are on screen: the longer of the two, so a roll
// from 9 to 10 (or back) never shifts its neighbours mid-flight
export function reservedWidth(prevText: string, nextText: string): number {
    return Math.max(prevText.length, nextText.length);
}
