// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getWebServerEndpoint } from "@/util/endpoints";
import { fetch } from "@/util/fetchutil";
import { setPlatform } from "@/util/platformutil";
import {
    base64ToString,
    deepCompareReturnPrev,
    getPrefixedSettings,
    NullAtom,
} from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { setupBadgesSubscription } from "./badge";
import { atoms, initGlobalAtoms, orefAtomCache } from "./global-atoms";
import { globalStore } from "./jotaiStore";
import { isPreviewWindow } from "./windowtype";
import * as WOS from "./wos";
import { getFileSubject, waveEventSubscribeSingle } from "./wps";

function initGlobal(initOpts: GlobalInitOptions) {
    setPlatform(initOpts.platform);
    initGlobalAtoms(initOpts);
}

function initGlobalWaveEventSubs() {
    waveEventSubscribeSingle({
        eventType: "waveobj:update",
        handler: (event) => {
            // console.log("waveobj:update wave event handler", event);
            WOS.updateWaveObject(event.data);
        },
    });
    waveEventSubscribeSingle({
        eventType: "config",
        handler: (event) => {
            // console.log("config wave event handler", event);
            globalStore.set(atoms.fullConfigAtom, event.data.fullconfig);
        },
    });
    waveEventSubscribeSingle({
        eventType: "blockfile",
        handler: (event) => {
            // console.log("blockfile event update", event);
            const fileSubject = getFileSubject(event.data.zoneid, event.data.filename);
            if (fileSubject != null) {
                fileSubject.next(event.data);
            }
        },
    });
    setupBadgesSubscription();
}

function getBlockMetaKeyAtom<T extends keyof MetaType>(blockId: string, key: T): Atom<MetaType[T]> {
    const blockCache = getSingleBlockAtomCache(blockId);
    const metaAtomName = "#meta-" + key;
    let metaAtom = blockCache.get(metaAtomName);
    if (metaAtom != null) {
        return metaAtom;
    }
    metaAtom = atom((get) => {
        const blockAtom = WOS.getWaveObjectAtom(WOS.makeORef("block", blockId));
        const blockData = get(blockAtom);
        return blockData?.meta?.[key];
    });
    blockCache.set(metaAtomName, metaAtom);
    return metaAtom;
}

function getConnConfigKeyAtom<T extends keyof ConnKeywords>(connName: string, key: T): Atom<ConnKeywords[T]> {
    if (isPreviewWindow()) return NullAtom as Atom<ConnKeywords[T]>;
    const connCache = getSingleConnAtomCache(connName);
    const keyAtomName = "#conn-" + key;
    let keyAtom = connCache.get(keyAtomName);
    if (keyAtom != null) {
        return keyAtom;
    }
    keyAtom = atom((get) => {
        const fullConfig = get(atoms.fullConfigAtom);
        return fullConfig.connections?.[connName]?.[key];
    });
    connCache.set(keyAtomName, keyAtom);
    return keyAtom;
}

const settingsAtomCache = new Map<string, Atom<any>>();

function getOverrideConfigAtom<T extends keyof SettingsType>(blockId: string, key: T): Atom<SettingsType[T]> {
    if (isPreviewWindow()) return NullAtom as Atom<SettingsType[T]>;
    const blockCache = getSingleBlockAtomCache(blockId);
    const overrideAtomName = "#settingsoverride-" + key;
    let overrideAtom = blockCache.get(overrideAtomName);
    if (overrideAtom != null) {
        return overrideAtom;
    }
    overrideAtom = atom((get) => {
        const blockMetaKeyAtom = getBlockMetaKeyAtom(blockId, key as any);
        const metaKeyVal = get(blockMetaKeyAtom);
        if (metaKeyVal != null) {
            return metaKeyVal;
        }
        const connNameAtom = getBlockMetaKeyAtom(blockId, "connection");
        const connName = get(connNameAtom);
        const connConfigKeyAtom = getConnConfigKeyAtom(connName, key as any);
        const connConfigKeyVal = get(connConfigKeyAtom);
        if (connConfigKeyVal != null) {
            return connConfigKeyVal;
        }
        const settingsKeyAtom = getSettingsKeyAtom(key);
        const settingsVal = get(settingsKeyAtom);
        if (settingsVal != null) {
            return settingsVal;
        }
        return null;
    });
    blockCache.set(overrideAtomName, overrideAtom);
    return overrideAtom;
}

function useOverrideConfigAtom<T extends keyof SettingsType>(blockId: string | null, key: T): SettingsType[T] {
    if (blockId == null) {
        return useAtomValue(getSettingsKeyAtom(key));
    }
    return useAtomValue(getOverrideConfigAtom(blockId, key));
}

function getSettingsKeyAtom<T extends keyof SettingsType>(key: T): Atom<SettingsType[T]> {
    if (isPreviewWindow()) return NullAtom as Atom<SettingsType[T]>;
    let settingsKeyAtom = settingsAtomCache.get(key) as Atom<SettingsType[T]>;
    if (settingsKeyAtom == null) {
        settingsKeyAtom = atom((get) => {
            const settings = get(atoms.settingsAtom);
            if (settings == null) {
                return null;
            }
            return settings[key];
        });
        settingsAtomCache.set(key, settingsKeyAtom);
    }
    return settingsKeyAtom;
}

function getSettingsPrefixAtom(prefix: string): Atom<SettingsType> {
    if (isPreviewWindow()) return NullAtom as Atom<SettingsType>;
    let settingsPrefixAtom = settingsAtomCache.get(prefix + ":");
    if (settingsPrefixAtom == null) {
        // create a stable, closured reference to use as the deepCompareReturnPrev key
        const cacheKey = {};
        settingsPrefixAtom = atom((get) => {
            const settings = get(atoms.settingsAtom);
            const newValue = getPrefixedSettings(settings, prefix);
            return deepCompareReturnPrev(cacheKey, newValue);
        });
        settingsAtomCache.set(prefix + ":", settingsPrefixAtom);
    }
    return settingsPrefixAtom;
}

function getSingleBlockAtomCache(blockId: string): Map<string, Atom<any>> {
    const blockORef = WOS.makeORef("block", blockId);
    return getSingleOrefAtomCache(blockORef);
}

function getSingleConnAtomCache(connName: string): Map<string, Atom<any>> {
    // this is not a real "oref", but it will work for the cache.
    const connORef = WOS.makeORef("conn", connName);
    return getSingleOrefAtomCache(connORef);
}

function getSingleOrefAtomCache(oref: string): Map<string, Atom<any>> {
    let orefCache = orefAtomCache.get(oref);
    if (orefCache == null) {
        orefCache = new Map<string, Atom<any>>();
        orefAtomCache.set(oref, orefCache);
    }
    return orefCache;
}

function useBlockAtom<T>(blockId: string, name: string, makeFn: () => Atom<T>): Atom<T> {
    const blockCache = getSingleBlockAtomCache(blockId);
    let atom = blockCache.get(name);
    if (atom == null) {
        atom = makeFn();
        blockCache.set(name, atom);
    }
    return atom as Atom<T>;
}

/**
 * Get the preload api.
 */
function getApi(): ElectronApi {
    return (window as any).api;
}

// when file is not found, returns {data: null, fileInfo: null}
async function fetchWaveFile(
    zoneId: string,
    fileName: string,
    offset?: number
): Promise<{ data: Uint8Array; fileInfo: WaveFile }> {
    const usp = new URLSearchParams();
    usp.set("zoneid", zoneId);
    usp.set("name", fileName);
    if (offset != null) {
        usp.set("offset", offset.toString());
    }
    const resp = await fetch(getWebServerEndpoint() + "/wave/file?" + usp.toString());
    if (!resp.ok) {
        if (resp.status === 404) {
            return { data: null, fileInfo: null };
        }
        throw new Error("error getting wave file: " + resp.statusText);
    }
    if (resp.status == 204) {
        return { data: null, fileInfo: null };
    }
    const fileInfo64 = resp.headers.get("X-ZoneFileInfo");
    if (fileInfo64 == null) {
        throw new Error(`missing zone file info for ${zoneId}:${fileName}`);
    }
    const fileInfo = JSON.parse(base64ToString(fileInfo64));
    const data = await resp.arrayBuffer();
    return { data: new Uint8Array(data), fileInfo };
}

let cachedIsDev: boolean = null;

function isDev() {
    if (cachedIsDev == null) {
        cachedIsDev = getApi().getIsDev();
    }
    return cachedIsDev;
}

let cachedUserName: string = null;

function getUserName(): string {
    if (cachedUserName == null) {
        cachedUserName = getApi().getUserName();
    }
    return cachedUserName;
}

let cachedHostName: string = null;

function getHostName(): string {
    if (cachedHostName == null) {
        cachedHostName = getApi().getHostName();
    }
    return cachedHostName;
}

const LocalHostDisplayNameAtom: Atom<string> = atom((get) => {
    const configValue = get(getSettingsKeyAtom("conn:localhostdisplayname"));
    if (configValue != null) {
        return configValue;
    }
    return getUserName() + "@" + getHostName();
});

/**
 * Open a link in a new window, or in a new web widget. The user can set all links to open in a new web widget using the `web:openlinksinternally` setting.
 * @param uri The link to open.
 * @param forceOpenInternally Force the link to open in a new web widget.
 */
async function openLink(uri: string, _forceOpenInternally = false) {
    getApi().openExternal(uri);
}

export {
    atoms,
    fetchWaveFile,
    getApi,
    getBlockMetaKeyAtom,
    getHostName,
    getOverrideConfigAtom,
    getSettingsKeyAtom,
    getSettingsPrefixAtom,
    getUserName,
    globalStore,
    initGlobal,
    initGlobalWaveEventSubs,
    isDev,
    openLink,
    setPlatform,
    useBlockAtom,
    useOverrideConfigAtom,
    WOS,
};
