// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import type { WaveStreamdownProps } from "./streamdown";

// the heavy markdown stack (streamdown -> mermaid/shiki/katex, plus shiki/bundle/web)
// only loads when markdown first renders, not at app startup
const WaveStreamdownInner = lazy(() =>
    import("./streamdown").then((m) => ({ default: m.WaveStreamdown }))
);

export const WaveStreamdown = (props: WaveStreamdownProps) => (
    <Suspense fallback={null}>
        <WaveStreamdownInner {...props} />
    </Suspense>
);
