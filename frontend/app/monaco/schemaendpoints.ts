// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import connectionsSchema from "../../../schema/connections.json";
import settingsSchema from "../../../schema/settings.json";

type SchemaInfo = {
    uri: string;
    fileMatch: Array<string>;
    schema: object;
};

const MonacoSchemas: SchemaInfo[] = [
    {
        uri: "wave://schema/settings.json",
        fileMatch: ["*/WAVECONFIGPATH/settings.json"],
        schema: settingsSchema,
    },
    {
        uri: "wave://schema/connections.json",
        fileMatch: ["*/WAVECONFIGPATH/connections.json"],
        schema: connectionsSchema,
    },
];

export { MonacoSchemas };
