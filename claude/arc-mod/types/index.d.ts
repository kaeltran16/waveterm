// the mod's $.state contract: the question the terminal's picker is showing, and the cache miss the band
// above the prompt is showing; each null when none is.

export type PickerOption = { label: string; description?: string };
export type PickerQuestion = { question: string; header: string; multiSelect: boolean; options: PickerOption[] };
export type PickerAnswer = { selectedindexes?: number[]; text?: string };
export type Picker = {
    questions: PickerQuestion[];
    index: number;
    answers: PickerAnswer[];
    marked: number[];
};

declare module "claude-code" {
    interface PluginState {
        arc: { picker: Picker | null; cacheMiss: string | null };
    }
}
