import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { cpSync, createReadStream, existsSync, realpathSync } from "fs";
import { resolve, sep } from "path";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";

const fe = resolve(__dirname, ".."); // frontend/
const outDir = resolve(__dirname, "dist");

// Excalidraw fetches its fonts at run time from window.EXCALIDRAW_ASSET_PATH, else from esm.sh. The CSP is
// default-src 'self' and the app must work offline, so the app serves them itself at EXCALIDRAW_FONTS_URL
// (boardview.tsx points Excalidraw there): from the package in dev, copied into the bundle on build.
const EXCALIDRAW_FONTS_URL = "/excalidraw/fonts/";
const excalidrawFontsDir = resolve(fe, "../node_modules/@excalidraw/excalidraw/dist/prod/fonts");
// the cjk fallback font (13 MB) is left out: cjk text on a board falls back to a system font
const excalidrawCjkFontDir = resolve(excalidrawFontsDir, "Xiaolai");
const isServedFont = (file: string) =>
    file.startsWith(excalidrawFontsDir + sep) && !file.startsWith(excalidrawCjkFontDir);

function excalidrawFonts(): Plugin {
    return {
        name: "arc-excalidraw-fonts",
        configureServer(server) {
            server.middlewares.use(EXCALIDRAW_FONTS_URL, (req, res, next) => {
                const rel = decodeURIComponent((req.url ?? "").split("?")[0]);
                const file = resolve(excalidrawFontsDir, "." + rel);
                if (!isServedFont(file) || !existsSync(file)) {
                    return next();
                }
                res.setHeader("Content-Type", "font/woff2");
                createReadStream(file).pipe(res);
            });
        },
        writeBundle() {
            cpSync(excalidrawFontsDir, resolve(outDir, ...EXCALIDRAW_FONTS_URL.split("/").filter(Boolean)), {
                recursive: true,
                filter: (src) => src === excalidrawFontsDir || isServedFont(src),
            });
        },
    };
}

// monaco's ts/js language mode lazy-loads tsMode.js, which spawns the 7 MB ts.worker. monaco-env.ts turns every
// feature of that mode off, so the build swaps it for a no-op and the worker is never emitted. dev keeps the real
// module: vite pre-bundles monaco without user plugins
const NO_TS_MODE_ID = "\0arc-no-ts-mode";

function monacoWithoutTsMode(): Plugin {
    return {
        name: "arc-monaco-without-ts-mode",
        apply: "build",
        enforce: "pre",
        resolveId(source, importer) {
            if (source === "./tsMode.js" && importer?.replace(/\\/g, "/").includes("/language/typescript/")) {
                return NO_TS_MODE_ID;
            }
        },
        load(id) {
            if (id === NO_TS_MODE_ID) {
                return "export function setupTypeScript() {}\nexport function setupJavaScript() {}\n";
            }
        },
    };
}

// Mirror tsconfig.json "paths" exactly (deterministic prefix aliases; @/store -> app/store, etc.).
// A flat "@" -> frontend alias would mis-resolve @/store, @/view, @/element, @/shadcn.
export default defineConfig({
    root: resolve(__dirname),
    // serve the workspace-root public/ (Font Awesome + other static assets Electron used to serve).
    // without this, publicDir defaults to frontend/tauri/public and /fontawesome/* 404s to the SPA fallback.
    publicDir: resolve(fe, "../public"),
    // a worktree's node_modules is a junction to the main checkout's, so its default node_modules/.vite is shared by
    // every dev app on the machine: one re-optimizing mid-boot swaps the deps under another and loads two reacts.
    // scripts/cdp/final-verify.mjs gives its dev app a cache of its own; unset keeps vite's default
    cacheDir: process.env.ARC_VITE_CACHE_DIR || undefined,
    plugins: [react(), tailwindcss(), excalidrawFonts(), monacoWithoutTsMode()],
    resolve: {
        alias: {
            "@/app": resolve(fe, "app"),
            "@/store": resolve(fe, "app/store"),
            "@/view": resolve(fe, "app/view"),
            "@/element": resolve(fe, "app/element"),
            "@/shadcn": resolve(fe, "app/shadcn"),
            "@/util": resolve(fe, "util"),
        },
    },
    server: {
        port: 5174,
        strictPort: true,
        // a worktree's node_modules is a junction to the main checkout's, and vite resolves it to that real
        // path, outside the worktree: without it every asset a package loads by url() (monaco's codicon
        // font) is refused with a 403 in a worktree's dev app
        fs: { allow: [searchForWorkspaceRoot(process.cwd()), realpathSync(resolve(fe, "../node_modules"))] },
    },
    build: {
        outDir,
        emptyOutDir: true,
        // the 500 kB default is a network-delivery budget; these chunks load from the app bundle on disk.
        // monaco alone is 3.8 MB and already lazy, so the limit sits just above it to still catch a jump.
        chunkSizeWarningLimit: 4000,
        // the cockpit and the desktop popup's page (the attention-popup window)
        rollupOptions: { input: [resolve(__dirname, "index.html"), resolve(__dirname, "popup.html")] },
    },
});
