// Key probe for the agent-rendered scenario: run as a block's cmd controller, it appends the hex of every stdin
// chunk it receives to <outfile>, one chunk per line, so a scenario can assert the exact keys typed into the pty.
//
//   node scripts/cdp/fixtures/keyprobe.mjs <outfile>
//
// It exits when its pty closes (the tab closes), so nothing outlives the scenario.
import { appendFileSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) {
    console.error("usage: keyprobe.mjs <outfile>");
    process.exit(1);
}
// the file exists once the probe is reading, which the scenario waits on before typing
writeFileSync(out, "");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => appendFileSync(out, chunk.toString("hex") + "\n"));
process.stdin.on("end", () => process.exit(0));
process.stdout.write("keyprobe: listening\r\n");
