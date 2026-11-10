// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CodeBlock } from "./codeblock";

// stub: Task 6 draws the chart. Until then a chart block reads as the raw spec.
export function ChartCard({ raw }: { raw: string }) {
    return <CodeBlock code={raw} lang="json" />;
}
