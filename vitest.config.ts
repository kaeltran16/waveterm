import react from "@vitejs/plugin-react-swc";
import svgr from "vite-plugin-svgr";
import tsconfigPaths from "vite-tsconfig-paths";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [
        tsconfigPaths(),
        svgr({
            svgrOptions: { exportType: "default", ref: true, svgo: false, titleProp: true },
            include: "**/*.svg",
        }),
        react({}),
    ],
    css: {
        preprocessorOptions: {
            scss: {
                silenceDeprecations: ["mixed-decls"],
            },
        },
    },
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
});
