// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { setWpsRpcClient, wpsReconnectHandler } from "@/app/store/wps";
import { TabClient } from "@/app/store/tabrpcclient";
import { WshRouter } from "@/app/store/wshrouter";
import { getWSServerEndpoint } from "@/util/endpoints";
import { addWSReconnectHandler, type ElectronOverrideOpts, globalWS, initGlobalWS, WSControl } from "./ws";
import { DefaultRouter, setDefaultRouter } from "./wshrpcutil-base";

let TabRpcClient: TabClient;

// eoOpts carries the authkey when the host can't inject it session-wide (Tauri webview). Electron
// leaves it undefined — its main process injects X-AuthKey via onBeforeSendHeaders.
function initWshrpc(routeId: string, eoOpts?: ElectronOverrideOpts): WSControl {
    const router = new WshRouter(new UpstreamWshRpcProxy());
    setDefaultRouter(router);
    const handleFn = (event: WSEventType) => {
        DefaultRouter.recvRpcMessage(event.data);
    };
    initGlobalWS(getWSServerEndpoint(), routeId, handleFn, eoOpts);
    globalWS.connectNow("connectWshrpc");
    TabRpcClient = new TabClient(routeId);
    setWpsRpcClient(TabRpcClient);
    DefaultRouter.registerRoute(TabRpcClient.routeId, TabRpcClient);
    addWSReconnectHandler(() => {
        DefaultRouter.reannounceRoutes();
    });
    addWSReconnectHandler(wpsReconnectHandler);
    return globalWS;
}

class UpstreamWshRpcProxy implements AbstractWshClient {
    recvRpcMessage(msg: RpcMessage): void {
        const wsMsg: WSRpcCommand = { wscommand: "rpc", message: msg };
        globalWS?.pushMessage(wsMsg);
    }
}

export { DefaultRouter, initWshrpc, TabRpcClient };
export { initElectronWshrpc, sendRpcCommand, sendRpcResponse, shutdownWshrpc } from "./wshrpcutil-base";
