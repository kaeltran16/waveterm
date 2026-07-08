// d3-force-3d ships no TypeScript types; declare the minimal surface memgraph's force setup uses.
declare module "d3-force-3d" {
    export function forceCollide(radius?: number | ((node: any) => number)): any;
    export function forceX(x?: number): any;
    export function forceY(y?: number): any;
}
