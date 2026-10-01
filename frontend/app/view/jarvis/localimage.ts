// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A local image file read through wavesrv. A plain <img src> cannot carry the auth header the Tauri webview needs
// (fetchutil.ts), so the bytes are fetched and shown as a blob URL.

import { getWebServerEndpoint } from "@/util/endpoints";
import { fetch } from "@/util/fetchutil";
import { useEffect, useState } from "react";

export type LocalImageStatus = "loading" | "ok" | "missing" | "error";
export type LocalImage = {
    url: string | null;
    status: LocalImageStatus;
    httpStatus?: number;
    width?: number;
    height?: number;
};

export function localFileUrl(endpoint: string, path: string): string {
    return endpoint + "/wave/stream-local-file?path=" + encodeURIComponent(path);
}

export function imageStatus(httpStatus: number): Exclude<LocalImageStatus, "loading"> {
    if (httpStatus === 404) {
        return "missing";
    }
    return httpStatus >= 200 && httpStatus < 300 ? "ok" : "error";
}

export function useLocalImage(path: string): LocalImage {
    const [image, setImage] = useState<LocalImage>({ url: null, status: "loading" });
    useEffect(() => {
        let cancelled = false;
        let url: string | null = null;
        setImage({ url: null, status: "loading" });
        (async () => {
            try {
                const resp = await fetch(localFileUrl(getWebServerEndpoint(), path));
                const status = imageStatus(resp.status);
                if (status !== "ok") {
                    if (!cancelled) {
                        setImage({ url: null, status, httpStatus: resp.status });
                    }
                    return;
                }
                const blob = await resp.blob();
                const bitmap = await createImageBitmap(blob);
                const { width, height } = bitmap;
                bitmap.close();
                if (cancelled) {
                    return;
                }
                url = URL.createObjectURL(blob);
                setImage({ url, status: "ok", width, height });
            } catch (e) {
                console.error("final-shots: cannot load", path, e);
                if (!cancelled) {
                    setImage({ url: null, status: "error" });
                }
            }
        })();
        return () => {
            cancelled = true;
            if (url != null) {
                URL.revokeObjectURL(url);
            }
        };
    }, [path]);
    return image;
}
