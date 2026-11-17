// the texts that reach the session while its turn runs, held until the model's next request or the turn's end.
// kept free of the engine so vitest can run it; register.ts holds the queue and makes the engine calls.
//
// Arc's texts join the turn at the moment the next request is about to go out (the last tool result of a step),
// and a joined text is never sent again. the person's wait for the turn's end and go as a prompt: the engine sends
// a joined row as a note from the plugin, "not from the user", which the model may decline to act on
import { isCommand } from "./control-core";
import type { ControlMsg } from "./control-core";

// one held text: the person's own (typed into an agent's box, with the id the cockpit knows it by) or Arc's,
// which has no id and is never reported or taken back. seq keeps arrival order when an item is put back
export type Held = { seq: number; text: string; ts: number; id?: string };

// wavesrv also takes "joined", which this mod never sends: the person's items do not join
export type LeftHow = "sent" | "takenback";
export type Left = { id: string; how: LeftHow };

// the held texts in arrival order, and the person's items that left since the last report wavesrv took
export type Queue = { held: Held[]; left: Left[]; seq: number; idPrefix: string };

// what `wsh agentqueue set` reads on stdin
export type Report = {
    held: { id: string; text: string; ts: number }[];
    left: Left[];
    takeback?: string;
};

// what the turn's end sends, in order: a prompt (several of the person's merged), or a command run as typed
export type TurnEndAction = { kind: "prompt" | "command"; text: string; items: Held[] };

// idPrefix must differ per queue (per load of the mod): a reload drops the queue, and an id reused after it
// would read as one wavesrv already reported lost
export function newQueue(idPrefix: string): Queue {
    return { held: [], left: [], seq: 0, idPrefix };
}

// whether a stream message waits in the queue: the person's queued text and Arc's mid-turn text, while a turn
// runs. outside a turn every text runs at once; a text that asked for no join waits for the turn's end itself
export function isHeld(msg: ControlMsg, isTurnOpen: boolean): msg is { text: string } {
    return isTurnOpen && "text" in msg && (msg.queue === true || msg.midTurn === true);
}

export function hold(queue: Queue, text: string, isPerson: boolean, now: number): Held {
    queue.seq += 1;
    const item: Held = { seq: queue.seq, text, ts: now, ...(isPerson && { id: `${queue.idPrefix}-${queue.seq}` }) };
    queue.held.push(item);
    return item;
}

const isPersons = (item: Held): item is Held & { id: string } => item.id !== undefined;

// removes the items keep() refuses from the held list, recording the person's as left by how
function take(queue: Queue, keep: (item: Held) => boolean, how: LeftHow): Held[] {
    const taken = queue.held.filter((item) => !keep(item));
    queue.held = queue.held.filter(keep);
    queue.left.push(...taken.filter(isPersons).map(({ id }) => ({ id, how })));
    return taken;
}

// Arc's prompts to join now, in arrival order. a command stays held: joined as text it would be read, not run
export function joinNow(queue: Queue): Held[] {
    const joined = queue.held.filter((item) => !isPersons(item) && !isCommand(item.text));
    queue.held = queue.held.filter((item) => !joined.includes(item));
    return joined;
}

// everything still held, as the turn's end sends it: consecutive person prompts as one prompt (Claude Code
// merges its own queued prompts into one turn), each Arc text as its own prompt, each command as a command
export function turnEndPlan(queue: Queue): TurnEndAction[] {
    const plan: TurnEndAction[] = [];
    for (const item of take(queue, () => false, "sent")) {
        const last = plan.at(-1);
        if (isCommand(item.text)) {
            plan.push({ kind: "command", text: item.text, items: [item] });
        } else if (last?.kind === "prompt" && isPersons(item) && last.items.every(isPersons)) {
            last.text += `\n${item.text}`;
            last.items.push(item);
        } else {
            plan.push({ kind: "prompt", text: item.text, items: [item] });
        }
    }
    return plan;
}

// the person's held items, in the order they were sent; Arc's stay held
export function takeBack(queue: Queue): Held[] {
    return take(queue, (item) => !isPersons(item), "takenback");
}

// holds taken items again in their arrival places (a join, send or take-back that failed), as if they never left
export function putBack(queue: Queue, items: Held[]): void {
    const ids = new Set(items.filter(isPersons).map((item) => item.id));
    queue.left = queue.left.filter((left) => !ids.has(left.id));
    queue.held = [...queue.held, ...items].sort((a, b) => a.seq - b.seq);
}

// the person's held items, in the order they were sent
export function personsHeld(queue: Queue): Held[] {
    return queue.held.filter(isPersons);
}

// drops the items with no left entry: the next report leaves them out, so wavesrv reads them as lost and the box
// gets them back. for what the engine will not send (after the person's Stop), which must not vanish
export function release(queue: Queue, items: Held[]): void {
    queue.held = queue.held.filter((item) => !items.includes(item));
}

// the whole held list of the person's items, every left entry no report has carried yet, and the take-back
// request the report answers
export function report(queue: Queue, takeback?: string): Report {
    return {
        held: queue.held.filter(isPersons).map(({ id, text, ts }) => ({ id, text, ts })),
        left: [...queue.left],
        ...(takeback && { takeback }),
    };
}

// forgets the left entries a report wavesrv took; a failed report's stay for the next, or wavesrv would read
// those items as lost
export function settle(queue: Queue, sent: Left[]): void {
    queue.left = queue.left.filter((left) => !sent.some((s) => s.id === left.id && s.how === left.how));
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
