// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as util from "@/util/util";

export function blockViewToIcon(view: string): string {
    if (view == "term") {
        return "terminal";
    }
    return "square";
}

export function blockViewToName(view: string): string {
    if (util.isBlank(view)) {
        return "(No View)";
    }
    if (view == "term") {
        return "Terminal";
    }
    return view;
}
