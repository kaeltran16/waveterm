// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { AllServiceTypes } from "@/app/store/services";
import { handleWaveEvent } from "@/app/store/wps";
import { RpcApiType } from "@/app/store/wshclientapi";
import { WaveEnv } from "@/app/waveenv/waveenv";
import { PlatformMacOS } from "@/util/platformutil";
import { Atom, atom, PrimitiveAtom, useAtomValue } from "jotai";
import { showPreviewContextMenu } from "../preview-contextmenu";
import { DefaultFullConfig } from "./defaultconfig";
import { DefaultMockFilesystem } from "./mockfilesystem";
import { previewElectronApi } from "./preview-electron-api";

export const PreviewTabId = crypto.randomUUID();
export const PreviewWindowId = crypto.randomUUID();
export const PreviewWorkspaceId = crypto.randomUUID();
export const PreviewClientId = crypto.randomUUID();
export const WebBlockId = crypto.randomUUID();

// What works "out of the box" in the mock environment (no MockEnv overrides needed):
//
// RPC calls (handled in makeMockRpc):
//   - rpc.EventPublishCommand           -- dispatches to handleWaveEvent(); works when the subscriber
//                                          is purely FE-based (registered via WPS on the frontend)
//   - rpc.GetMetaCommand                -- reads .meta from the mock WOS atom for the given oref
//   - rpc.GetSecretsNamesCommand        -- lists secret names from the in-memory mock secret store
//   - rpc.SetMetaCommand                -- writes .meta to the mock WOS atom (null values delete keys)
//   - rpc.SetConfigCommand              -- merges settings into fullConfigAtom (null values delete keys)
//   - rpc.SetSecretsCommand             -- writes/deletes secrets in the in-memory mock secret store
//   - rpc.UpdateWorkspaceTabIdsCommand  -- updates .tabids on the Workspace WaveObj in the mock WOS
//
// Any other RPC call falls through to a console.log and resolves null.
// Override specific calls via MockEnv.rpc (keys are Command method names, e.g. "GetMetaCommand").
// Override specific streaming calls via MockEnv.rpcStreaming (same key names, handler returns AsyncGenerator).
//
// Backend service calls (handled in callBackendService):
//   Any call falls through to a console.log and resolves null.
//   Override specific calls via MockEnv.services: { Service: { Method: impl } }
//   e.g. { "block": { "GetControllerStatus": (blockId) => myStatus } }

export type RpcHandlerType = (...args: any[]) => Promise<any>;
export type RpcStreamHandlerType = (...args: any[]) => AsyncGenerator<any, void, boolean>;

export type RpcOverrides = {
    [K in keyof RpcApiType as K extends `${string}Command` ? K : never]?: RpcHandlerType;
};

export type RpcStreamOverrides = {
    [K in keyof RpcApiType as K extends `${string}Command` ? K : never]?: RpcStreamHandlerType;
};

type ServiceOverrides = {
    [Service: string]: {
        [Method: string]: (...args: any[]) => Promise<any>;
    };
};

export type MockEnv = {
    isDev?: boolean;
    tabId?: string;
    platform?: NodeJS.Platform;
    settings?: Partial<SettingsType>;
    rpc?: RpcOverrides;
    rpcStreaming?: RpcStreamOverrides;
    services?: ServiceOverrides;
    atoms?: Partial<GlobalAtomsType>;
    electron?: Partial<ElectronApi>;
    showContextMenu?: WaveEnv["showContextMenu"];
    mockWaveObjs?: Record<string, WaveObj>;
};

export type MockWaveEnv = WaveEnv & {
    mockEnv: MockEnv;
    addRpcOverride: <K extends keyof RpcOverrides>(command: K, handler: RpcHandlerType) => void;
    addRpcStreamOverride: <K extends keyof RpcStreamOverrides>(command: K, handler: RpcStreamHandlerType) => void;
};

function mergeRecords<T>(base: Record<string, T>, overrides: Record<string, T>): Record<string, T> {
    if (base == null && overrides == null) {
        return undefined;
    }
    return { ...(base ?? {}), ...(overrides ?? {}) };
}

export function mergeMockEnv(base: MockEnv, overrides: MockEnv): MockEnv {
    let mergedServices: ServiceOverrides;
    if (base.services != null || overrides.services != null) {
        mergedServices = {};
        for (const svc of Object.keys(base.services ?? {})) {
            mergedServices[svc] = { ...(base.services[svc] ?? {}) };
        }
        for (const svc of Object.keys(overrides.services ?? {})) {
            mergedServices[svc] = { ...(mergedServices[svc] ?? {}), ...(overrides.services[svc] ?? {}) };
        }
    }
    return {
        isDev: overrides.isDev ?? base.isDev,
        tabId: overrides.tabId ?? base.tabId,
        platform: overrides.platform ?? base.platform,
        settings: mergeRecords(base.settings, overrides.settings),
        rpc: mergeRecords(base.rpc as any, overrides.rpc as any) as RpcOverrides,
        rpcStreaming: mergeRecords(base.rpcStreaming as any, overrides.rpcStreaming as any) as RpcStreamOverrides,
        services: mergedServices,
        atoms: overrides.atoms != null || base.atoms != null ? { ...base.atoms, ...overrides.atoms } : undefined,
        electron:
            overrides.electron != null || base.electron != null
                ? { ...(base.electron ?? {}), ...(overrides.electron ?? {}) }
                : undefined,
        showContextMenu: overrides.showContextMenu ?? base.showContextMenu,
        mockWaveObjs: mergeRecords(base.mockWaveObjs, overrides.mockWaveObjs),
    };
}

function makeMockGlobalAtoms(
    settingsOverrides: Partial<SettingsType>,
    atomOverrides: Partial<GlobalAtomsType>,
    tabId: string,
    getWaveObjectAtom: <T extends WaveObj>(oref: string) => PrimitiveAtom<T>
): GlobalAtomsType {
    let fullConfig = DefaultFullConfig;
    if (settingsOverrides) {
        fullConfig = {
            ...DefaultFullConfig,
            settings: { ...DefaultFullConfig.settings, ...settingsOverrides },
        };
    }
    const fullConfigAtom = atom(fullConfig) as PrimitiveAtom<FullConfigType>;
    const settingsAtom = atom((get) => get(fullConfigAtom)?.settings ?? {}) as Atom<SettingsType>;
    const workspaceIdAtom: Atom<string> = atomOverrides?.workspaceId ?? (atom(null as string) as Atom<string>);
    const workspaceAtom: Atom<Workspace> = atom((get) => {
        const wsId = get(workspaceIdAtom);
        if (wsId == null) {
            return null;
        }
        return get(getWaveObjectAtom<Workspace>("workspace:" + wsId));
    });
    const defaults: GlobalAtomsType = {
        uiContext: atom({ windowid: "", activetabid: tabId ?? "" } as UIContext),
        workspaceId: workspaceIdAtom,
        workspace: workspaceAtom,
        fullConfigAtom,
        settingsAtom,
        hasConfigErrors: atom((get) => {
            const c = get(fullConfigAtom);
            return c?.configerrors != null && c.configerrors.length > 0;
        }),
        staticTabId: atom(tabId ?? ""),
        isFullScreen: atom(false) as any,
        zoomFactorAtom: atom(1.0) as any,
        controlShiftDelayAtom: atom(false) as any,
        prefersReducedMotionAtom: atom(false),
        documentHasFocus: atom(true) as any,
        modalOpen: atom(false) as any,
        reinitVersion: atom(0) as any,
    };
    if (!atomOverrides) {
        return defaults;
    }
    const merged = { ...defaults, ...atomOverrides };
    if (!atomOverrides.workspace) {
        merged.workspace = workspaceAtom;
    }
    return merged;
}

type MockWosFns = {
    getWaveObjectAtom: <T extends WaveObj>(oref: string) => PrimitiveAtom<T>;
    mockSetWaveObj: <T extends WaveObj>(oref: string, obj: T) => void;
    fullConfigAtom: PrimitiveAtom<FullConfigType>;
    platform: NodeJS.Platform;
};

export function makeMockRpc(
    overrides: RpcOverrides,
    streamOverrides: RpcStreamOverrides,
    wos: MockWosFns
): {
    rpc: RpcApiType;
    setRpcHandler: (command: string, fn: RpcHandlerType) => void;
    setRpcStreamHandler: (command: string, fn: RpcStreamHandlerType) => void;
} {
    const callDispatchMap = new Map<string, (...args: any[]) => Promise<any>>();
    const streamDispatchMap = new Map<string, (...args: any[]) => AsyncGenerator<any, void, boolean>>();
    const secrets = new Map<string, string>();
    const setCallHandler = (command: string, fn: (...args: any[]) => Promise<any>) => {
        callDispatchMap.set(command, fn);
    };
    const setStreamHandler = (command: string, fn: (...args: any[]) => AsyncGenerator<any, void, boolean>) => {
        streamDispatchMap.set(command, fn);
    };
    setCallHandler("eventpublish", async (_client, data: WaveEvent) => {
        console.log("[mock eventpublish]", data);
        handleWaveEvent(data);
        return null;
    });
    setCallHandler("getmeta", async (_client, data: CommandGetMetaData) => {
        const objAtom = wos.getWaveObjectAtom(data.oref);
        const current = globalStore.get(objAtom) as WaveObj & { meta?: MetaType };
        return current?.meta ?? {};
    });
    setCallHandler("setmeta", async (_client, data: CommandSetMetaData) => {
        const objAtom = wos.getWaveObjectAtom(data.oref);
        const current = globalStore.get(objAtom) as WaveObj & { meta?: MetaType };
        const updatedMeta = { ...(current?.meta ?? {}) };
        for (const [key, value] of Object.entries(data.meta)) {
            if (value === null) {
                delete updatedMeta[key];
            } else {
                (updatedMeta as any)[key] = value;
            }
        }
        const updated = { ...current, meta: updatedMeta };
        wos.mockSetWaveObj(data.oref, updated);
        return null;
    });
    setCallHandler("setconfig", async (_client, data: SettingsType) => {
        const current = globalStore.get(wos.fullConfigAtom);
        const updatedSettings = { ...(current?.settings ?? {}) };
        for (const [key, value] of Object.entries(data)) {
            if (value === null) {
                delete (updatedSettings as any)[key];
            } else {
                (updatedSettings as any)[key] = value;
            }
        }
        globalStore.set(wos.fullConfigAtom, { ...current, settings: updatedSettings as SettingsType });
        return null;
    });
    setCallHandler("getsecretsnames", async () => {
        return Array.from(secrets.keys()).sort();
    });
    setCallHandler("setsecrets", async (_client, data: Record<string, string>) => {
        for (const [name, value] of Object.entries(data ?? {})) {
            if (value == null) {
                secrets.delete(name);
                continue;
            }
            secrets.set(name, value);
        }
        return null;
    });
    setCallHandler("updateworkspacetabids", async (_client, data: { args: [string, string[]] }) => {
        const [workspaceId, tabIds] = data.args;
        const wsORef = "workspace:" + workspaceId;
        const objAtom = wos.getWaveObjectAtom(wsORef);
        const current = globalStore.get(objAtom) as Workspace;
        const updated = { ...current, tabids: tabIds };
        wos.mockSetWaveObj(wsORef, updated);
        return null;
    });
    setCallHandler("fileinfo", async (_client, data: FileData) => DefaultMockFilesystem.fileInfo(data));
    setCallHandler("fileread", async (_client, data: FileData) => DefaultMockFilesystem.fileRead(data));
    setCallHandler("filejoin", async (_client, data: string[]) => DefaultMockFilesystem.fileJoin(data));
    if (overrides) {
        for (const key of Object.keys(overrides) as (keyof RpcOverrides)[]) {
            const cmdName = key.slice(0, -"Command".length).toLowerCase();
            setCallHandler(cmdName, overrides[key] as RpcHandlerType);
        }
    }
    if (streamOverrides) {
        for (const key of Object.keys(streamOverrides) as (keyof RpcStreamOverrides)[]) {
            const cmdName = key.slice(0, -"Command".length).toLowerCase();
            setStreamHandler(cmdName, streamOverrides[key] as RpcStreamHandlerType);
        }
    }
    const rpc = new RpcApiType();
    rpc.setMockRpcClient({
        mockWshRpcCall(_client, command, data, _opts) {
            const fn = callDispatchMap.get(command);
            if (fn) {
                return fn(_client, data, _opts);
            }
            console.log("[mock rpc call]", command, data);
            return Promise.resolve(null);
        },
        async *mockWshRpcStream(_client, command, data, _opts) {
            const streamFn = streamDispatchMap.get(command);
            if (streamFn) {
                yield* streamFn(_client, data, _opts);
                return;
            }
            const callFn = callDispatchMap.get(command);
            if (callFn) {
                yield await callFn(_client, data, _opts);
                return;
            }
            console.log("[mock rpc stream]", command, data);
            yield null;
        },
    });
    return {
        rpc,
        setRpcHandler: (command: string, fn: RpcHandlerType) => {
            const cmdName = command.endsWith("Command") ? command.slice(0, -"Command".length).toLowerCase() : command;
            setCallHandler(cmdName, fn);
        },
        setRpcStreamHandler: (command: string, fn: RpcStreamHandlerType) => {
            const cmdName = command.endsWith("Command") ? command.slice(0, -"Command".length).toLowerCase() : command;
            setStreamHandler(cmdName, fn);
        },
    };
}

export function applyMockEnvOverrides(env: WaveEnv, newOverrides: MockEnv): MockWaveEnv {
    const existing = (env as MockWaveEnv).mockEnv;
    const merged = existing != null ? mergeMockEnv(existing, newOverrides) : newOverrides;
    return makeMockWaveEnv(merged);
}

export function makeMockWaveEnv(mockEnv?: MockEnv): MockWaveEnv {
    const overrides: MockEnv = mockEnv ?? {};
    const tabId = overrides.tabId ?? PreviewTabId;
    const defaultMockWaveObjs: Record<string, WaveObj> = {
        [`workspace:${PreviewWorkspaceId}`]: {
            otype: "workspace",
            oid: PreviewWorkspaceId,
            version: 1,
            name: "Preview Workspace",
            tabids: [PreviewTabId],
            activetabid: PreviewTabId,
            meta: {},
        } as Workspace,
        [`tab:${PreviewTabId}`]: {
            otype: "tab",
            oid: PreviewTabId,
            version: 1,
            name: "Preview Tab",
            blockids: [WebBlockId],
            meta: {},
        } as Tab,
        [`block:${WebBlockId}`]: {
            otype: "block",
            oid: WebBlockId,
            version: 1,
            meta: {
                view: "web",
            },
        } as Block,
    };
    const defaultAtoms: Partial<GlobalAtomsType> = {
        uiContext: atom({ windowid: PreviewWindowId, activetabid: PreviewTabId } as UIContext),
        staticTabId: atom(PreviewTabId),
        workspaceId: atom(PreviewWorkspaceId),
    };
    const mergedOverrides: MockEnv = {
        ...overrides,
        tabId,
        mockWaveObjs: { ...defaultMockWaveObjs, ...(overrides.mockWaveObjs ?? {}) },
        atoms: { ...defaultAtoms, ...(overrides.atoms ?? {}) },
    };
    const platform = mergedOverrides.platform ?? PlatformMacOS;
    const waveObjectValueAtomCache = new Map<string, PrimitiveAtom<any>>();
    const waveObjectDerivedAtomCache = new Map<string, Atom<any>>();
    const getWaveObjectAtom = <T extends WaveObj>(oref: string): PrimitiveAtom<T> => {
        if (!waveObjectValueAtomCache.has(oref)) {
            const obj = (mergedOverrides.mockWaveObjs?.[oref] ?? null) as T;
            waveObjectValueAtomCache.set(oref, atom(obj) as PrimitiveAtom<T>);
        }
        return waveObjectValueAtomCache.get(oref) as PrimitiveAtom<T>;
    };
    const atoms = makeMockGlobalAtoms(
        mergedOverrides.settings,
        mergedOverrides.atoms,
        mergedOverrides.tabId,
        getWaveObjectAtom
    );
    const mockWosFns: MockWosFns = {
        getWaveObjectAtom,
        fullConfigAtom: atoms.fullConfigAtom,
        platform,
        mockSetWaveObj: <T extends WaveObj>(oref: string, obj: T) => {
            if (!waveObjectValueAtomCache.has(oref)) {
                waveObjectValueAtomCache.set(oref, atom(null as WaveObj));
            }
            globalStore.set(waveObjectValueAtomCache.get(oref), obj);
        },
    };
    const { rpc, setRpcHandler, setRpcStreamHandler } = makeMockRpc(
        mergedOverrides.rpc,
        mergedOverrides.rpcStreaming,
        mockWosFns
    );
    const env = {
        isMock: true,
        mockEnv: mergedOverrides,
        electron: {
            ...previewElectronApi,
            getPlatform: () => platform,
            openExternal: (url: string) => {
                window.open(url, "_blank");
            },
            ...mergedOverrides.electron,
        },
        rpc,
        atoms,
        platform,
        isDev: () => mergedOverrides.isDev ?? true,
        showContextMenu: mergedOverrides.showContextMenu ?? showPreviewContextMenu,
        wos: {
            getWaveObjectAtom: mockWosFns.getWaveObjectAtom,
            getWaveObjectLoadingAtom: (oref: string) => {
                const cacheKey = oref + ":loading";
                if (!waveObjectDerivedAtomCache.has(cacheKey)) {
                    waveObjectDerivedAtomCache.set(cacheKey, atom(false));
                }
                return waveObjectDerivedAtomCache.get(cacheKey) as Atom<boolean>;
            },
            isWaveObjectNullAtom: (oref: string) => {
                const cacheKey = oref + ":isnull";
                if (!waveObjectDerivedAtomCache.has(cacheKey)) {
                    waveObjectDerivedAtomCache.set(
                        cacheKey,
                        atom((get) => get(env.wos.getWaveObjectAtom(oref)) == null)
                    );
                }
                return waveObjectDerivedAtomCache.get(cacheKey) as Atom<boolean>;
            },
            useWaveObjectValue: <T extends WaveObj>(oref: string): [T, boolean] => {
                const objAtom = env.wos.getWaveObjectAtom<T>(oref);
                return [useAtomValue(objAtom), false];
            },
        },
        services: null as any,
        callBackendService: (service: string, method: string, args: any[], noUIContext?: boolean) => {
            const fn = mergedOverrides.services?.[service]?.[method];
            if (fn) {
                return fn(...args);
            }
            console.log("[mock callBackendService]", service, method, args, noUIContext);
            return Promise.resolve(null);
        },
        mockSetWaveObj: mockWosFns.mockSetWaveObj,
        mockModels: new Map<any, any>(),
        addRpcOverride: <K extends keyof RpcOverrides>(command: K, handler: RpcHandlerType) => {
            setRpcHandler(command as string, handler);
        },
        addRpcStreamOverride: <K extends keyof RpcStreamOverrides>(command: K, handler: RpcStreamHandlerType) => {
            setRpcStreamHandler(command as string, handler);
        },
    } as MockWaveEnv;
    env.services = Object.fromEntries(
        Object.entries(AllServiceTypes).map(([key, ServiceClass]) => [key, new ServiceClass(env)])
    ) as any;
    return env;
}
