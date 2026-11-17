import { describe, expect, it } from "vitest";
import { commandTitle } from "./commandtitle";

describe("commandTitle", () => {
    it.each([
        ["python - <<'EOF'\nimport json\nprint(1)\nEOF", "Ran a Python script"],
        ['python3 -c "import sys\nprint(sys.argv)"', "Ran a Python script"],
        ["node - <<EOF\nconsole.log(1)\nEOF", "Ran a Node script"],
        ["bash <<'EOF'\nset -e\necho hi\nEOF", "Ran a shell script"],
        ["cd C:/work/repo && C:/venv/Scripts/python.exe - <<'EOF'\nprint(1)\nEOF", "Ran a Python script"],
    ])("names a script fed to an interpreter: %s", (cmd, title) => {
        expect(commandTitle(cmd)).toBe(title);
    });

    it.each([
        ["cat > out/plan.md <<EOF\n# Plan\nEOF", "Wrote plan.md"],
        ["cat <<'EOF' > C:/tmp/notes/report.txt\nhello\nEOF", "Wrote report.txt"],
        ["tee docs/a/b.md <<EOF\nx\nEOF", "Wrote b.md"],
    ])("names the file a heredoc writes: %s", (cmd, title) => {
        expect(commandTitle(cmd)).toBe(title);
    });

    it("skips leading assignments and names the subcommand of a tool that has them", () => {
        expect(commandTitle("F=a && O=b && git status --short")).toBe("Ran git status");
        expect(commandTitle("export WAVE_DEV=1 && go test ./pkg/x")).toBe("Ran go test");
    });

    it("names the script a runtime runs", () => {
        expect(
            commandTitle(
                "cd C:/repo && node scripts/cdp/final-verify.mjs transcript-base transcript-arc narration-feed"
            )
        ).toBe("Ran node final-verify.mjs");
    });

    it("drops a title that would only name the program", () => {
        expect(
            commandTitle("ls -la C:/Users/someone/AppData/Local/arc-wt/d71b0df7-t-7/frontend/app/view/agents/x")
        ).toBeUndefined();
        expect(
            commandTitle("grep -n retry C:/Users/someone/AppData/Local/arc-wt/d71b0df7-t-7/frontend/a.ts")
        ).toBeUndefined();
    });

    const LONG_PATH = "C:/Users/someone/.claude/plugins/marketplaces/arc/plugins/arc-mod";

    it("skips wrappers when picking the program", () => {
        expect(commandTitle(`timeout 120 claude plugin validate ${LONG_PATH}`)).toBe("Ran claude plugin");
        expect(commandTitle(`timeout -k 5 2m git status --short -- ${LONG_PATH}`)).toBe("Ran git status");
        expect(commandTitle(`env -u HOME FOO=1 git log --oneline -- ${LONG_PATH}`)).toBe("Ran git log");
        expect(commandTitle(`nohup time command node scripts/cdp/final-verify.mjs ${LONG_PATH}`)).toBe(
            "Ran node final-verify.mjs"
        );
    });

    it("takes a bare env as no program and titles from the command after it", () => {
        expect(commandTitle(`env | git grep -n FOO -- ${LONG_PATH}`)).toBe("Ran git grep");
        expect(commandTitle(`env | grep FOO | sort | uniq -c | sort -rn | head -40 > ${LONG_PATH}/x`)).toBeUndefined();
    });

    it("skips the commands inside a substitution", () => {
        const script = "const fs = require('fs'); console.log(fs.readFileSync(process.env.F, 'utf8').length)";
        expect(commandTitle(`cd ~/p && F=$(ls -t | head -1); node -e "${script}"`)).toBe("Ran a Node script");
        expect(commandTitle(`F=\`ls -t | head -1\` && python3 -c "${script}"`)).toBe("Ran a Python script");
    });

    it("names a subcommand only when it reads as a word", () => {
        expect(commandTitle(`claude -p "review the diff under ${LONG_PATH} and report"`)).toBeUndefined();
    });

    it("leaves a short one-liner untitled", () => {
        expect(commandTitle("ls -la")).toBeUndefined();
        expect(commandTitle("git status --short")).toBeUndefined();
    });

    it("leaves a command with no program untitled", () => {
        expect(commandTitle("A=1\nB=2")).toBeUndefined();
    });
});
