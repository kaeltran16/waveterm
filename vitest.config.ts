import { UserConfig, configDefaults, defineConfig, mergeConfig } from "vitest/config";
import electronViteConfig from "./electron.vite.config";

export default mergeConfig(
    electronViteConfig.renderer as UserConfig,
    defineConfig({
        test: {
            // git worktrees under .claude/ carry a full copy of the suite; vitest's default glob
            // walks the repo root, so without this it runs every sibling session's tests too.
            exclude: [...configDefaults.exclude, "**/.claude/**"],
            reporters: ["verbose", "junit"],
            outputFile: {
                junit: "test-results.xml",
            },
            coverage: {
                provider: "istanbul",
                reporter: ["lcov"],
                reportsDirectory: "./coverage",
            },
            typecheck: {
                tsconfig: "tsconfig.json",
            },
        },
    })
);
