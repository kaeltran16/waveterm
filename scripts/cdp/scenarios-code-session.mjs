// Code surface review fixes: code-session. Stub until its task writes the steps.

export const codeSession = {
    name: "code-session",
    surface: "code",
    async arrange() {
        return {};
    },
    async assert() {
        return [{ step: "code-session: steps not written yet", ok: false }];
    },
};
