// Arc's texts that reach the session while its turn runs, held until the model's next request or the turn's end.
// kept free of the engine so vitest can run it; register.ts holds the queue and makes the engine calls.
//
// they join the turn at the moment the next request is about to go out (the last tool result of a step), and a
// joined text is never sent again. the person's own messages never come here: Arc types them into the terminal,
// since the engine sends a mod's text as a note from the plugin, "not from the user"
import { isCommand } from "./control-core";
import type { ControlMsg } from "./control-core";

// one held text; seq keeps arrival order when an item is put back
export type Held = { seq: number; text: string };

// the held texts in arrival order, and whether a turn-end action is out and not yet taken
export type Queue = { held: Held[]; seq: number; isOut: boolean };

// what the turn's end sends, in order: a prompt, or a command run as typed
export type TurnEndAction = { kind: "prompt" | "command"; text: string; items: Held[] };

export function newQueue(): Queue {
    return { held: [], seq: 0, isOut: false };
}

// whether a stream message waits in the queue: Arc's mid-turn text, while a turn runs. outside a turn every text
// runs at once; a text that asked for no join waits for the turn's end itself
export function isHeld(msg: ControlMsg, isTurnOpen: boolean): msg is { text: string } {
    return isTurnOpen && "text" in msg && msg.midTurn === true;
}

export function hold(queue: Queue, text: string): Held {
    queue.seq += 1;
    const item: Held = { seq: queue.seq, text };
    queue.held.push(item);
    return item;
}

// the prompts to join now, in arrival order. a command stays held: joined as text it would be read, not run
export function joinNow(queue: Queue): Held[] {
    const joined = queue.held.filter((item) => !isCommand(item.text));
    queue.held = queue.held.filter((item) => !joined.includes(item));
    return joined;
}

// the first of what is still held, as the turn's end sends it (each text its own prompt, each command a command),
// taken out of the held list, or null while the one before it is out. the engine does not keep call order (a
// command queues at once, a prompt only after its hooks), so the turn's end sends one action at a time
export function nextAction(queue: Queue): TurnEndAction | null {
    const [first] = queue.held;
    if (queue.isOut || first === undefined) {
        return null;
    }
    queue.held = queue.held.slice(1);
    queue.isOut = true;
    return { kind: isCommand(first.text) ? "command" : "prompt", text: first.text, items: [first] };
}

// the action out was taken (or failed and was put back): the next may go
export function actionEnded(queue: Queue): void {
    queue.isOut = false;
}

// holds taken items again in their arrival places (a join or send that failed), as if they never left
export function putBack(queue: Queue, items: Held[]): void {
    queue.held = [...queue.held, ...items].sort((a, b) => a.seq - b.seq);
}

// one model request of the main loop and the tool calls its response made. held prompts join once the
// response is whole and every call has its stored result: joined earlier, a row would split a parallel
// batch's results. calls is null until the response ends
export type Step = { calls: number | null; results: number; isJoined: boolean };

export function newStep(): Step {
    return { calls: null, results: 0, isJoined: false };
}

function isBatchIn(step: Step): boolean {
    if (step.isJoined || step.calls === null || step.calls === 0 || step.results < step.calls) {
        return false;
    }
    step.isJoined = true;
    return true;
}

// the response ended having made this many tool calls; true when held prompts join now
export function stepEnded(step: Step, calls: number): boolean {
    step.calls = calls;
    return isBatchIn(step);
}

// a stored tool-result row carried this many results; true when held prompts join now
export function resultsStored(step: Step, results: number): boolean {
    step.results += results;
    return isBatchIn(step);
}
