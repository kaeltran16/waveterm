// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WshClient } from "./wshclient";

export class TabClient extends WshClient {
    constructor(routeId: string) {
        super(routeId);
    }
}
