// the mod's $.state contract: the question the last reply left waiting on the person, with whether its rows have
// scrolled out of view. the two /config rows (highlight, dim) are its userConfig, not state.

export type Ask = { hash: string; text: string };

declare module "claude-code" {
    interface PluginState {
        "arc-skim": { ask: Ask | null; isAskHidden: boolean };
    }
}
