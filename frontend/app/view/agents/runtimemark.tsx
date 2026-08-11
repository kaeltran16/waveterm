// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Small presentational mark for a runtime author: renders the real brand mark (runtimelogo) as an <img>,
// falling back to the runtime's glyph span. Shared by badges/avatars that want the logo when one exists.

import { runtimeLogo } from "./runtimelogo";
import { runtimeMeta } from "./runtimemeta";

export function RuntimeMark({ runtime, className, imageClassName }: {
    runtime?: string;
    className?: string;
    imageClassName?: string;
}) {
    const logo = runtimeLogo(runtime);
    const meta = runtimeMeta(runtime);
    if (logo) {
        return <img src={logo} alt={`${meta.label} logo`} className={imageClassName ?? className} />;
    }
    return <span className={className}>{meta.glyph}</span>;
}
