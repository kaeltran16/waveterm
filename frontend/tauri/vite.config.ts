import react from "@vitejs/plugin-react-swc";
import { resolve } from "path";
import { defineConfig } from "vite";

const fe = resolve(__dirname, ".."); // frontend/

// Mirror tsconfig.json "paths" exactly (deterministic prefix aliases; @/store -> app/store, etc.).
// A flat "@" -> frontend alias would mis-resolve @/store, @/view, @/element, @/shadcn.
export default defineConfig({
    root: resolve(__dirname),
    plugins: [react()],
    resolve: {
        alias: {
            "@/app": resolve(fe, "app"),
            "@/store": resolve(fe, "app/store"),
            "@/view": resolve(fe, "app/view"),
            "@/element": resolve(fe, "app/element"),
            "@/shadcn": resolve(fe, "app/shadcn"),
            "@/util": resolve(fe, "util"),
            "@/layout": resolve(fe, "layout"),
            "@/builder": resolve(fe, "builder"),
            "@/preview": resolve(fe, "preview"),
        },
    },
    server: { port: 5174, strictPort: true },
    build: { outDir: resolve(__dirname, "dist"), emptyOutDir: true },
});
