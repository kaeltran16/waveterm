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

    it("names a plain program on a long line", () => {
        expect(
            commandTitle("ls -la C:/Users/someone/AppData/Local/arc-wt/d71b0df7-t-7/frontend/app/view/agents/x")
        ).toBe("Ran ls");
    });

    it("leaves a short one-liner untitled", () => {
        expect(commandTitle("ls -la")).toBeUndefined();
        expect(commandTitle("git status --short")).toBeUndefined();
    });

    it("leaves a command with no program untitled", () => {
        expect(commandTitle("A=1\nB=2")).toBeUndefined();
    });
});
