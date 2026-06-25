// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

let isJetBrainsMonoLoaded = false;
let isHackFontLoaded = false;
let isHackNerdFontLoaded = false;
let isInterFontLoaded = false;
let isHankenGroteskLoaded = false;

function addToFontFaceSet(fontFaceSet: FontFaceSet, fontFace: FontFace) {
    // any cast to work around typing issue
    (fontFaceSet as any).add(fontFace);
}

function loadJetBrainsMonoFont() {
    if (isJetBrainsMonoLoaded) {
        return;
    }
    isJetBrainsMonoLoaded = true;
    const jbmFontNormal = new FontFace("JetBrains Mono", "url('fonts/jetbrains-mono-v13-latin-regular.woff2')", {
        style: "normal",
        weight: "400",
    });
    const jbmFont200 = new FontFace("JetBrains Mono", "url('fonts/jetbrains-mono-v13-latin-200.woff2')", {
        style: "normal",
        weight: "200",
    });
    const jbmFont700 = new FontFace("JetBrains Mono", "url('fonts/jetbrains-mono-v13-latin-700.woff2')", {
        style: "normal",
        weight: "700",
    });
    addToFontFaceSet(document.fonts, jbmFontNormal);
    addToFontFaceSet(document.fonts, jbmFont200);
    addToFontFaceSet(document.fonts, jbmFont700);
    jbmFontNormal.load();
    jbmFont200.load();
    jbmFont700.load();
}

function loadHackNerdFont() {
    if (isHackNerdFontLoaded) {
        return;
    }
    isHackFontLoaded = true;
    const hackRegular = new FontFace("Hack", "url('fonts/hacknerdmono-regular.ttf')", {
        style: "normal",
        weight: "400",
    });
    const hackBold = new FontFace("Hack", "url('fonts/hacknerdmono-bold.ttf')", {
        style: "normal",
        weight: "700",
    });
    const hackItalic = new FontFace("Hack", "url('fonts/hacknerdmono-italic.ttf')", {
        style: "italic",
        weight: "400",
    });
    const hackBoldItalic = new FontFace("Hack", "url('fonts/hacknerdmono-bolditalic.ttf')", {
        style: "italic",
        weight: "700",
    });
    addToFontFaceSet(document.fonts, hackRegular);
    addToFontFaceSet(document.fonts, hackBold);
    addToFontFaceSet(document.fonts, hackItalic);
    addToFontFaceSet(document.fonts, hackBoldItalic);
    hackRegular.load();
    hackBold.load();
    hackItalic.load();
    hackBoldItalic.load();
}

function loadInterFont() {
    if (isInterFontLoaded) {
        return;
    }
    isInterFontLoaded = true;
    const interFont = new FontFace("Inter", "url('fonts/inter-variable.woff2')", {
        style: "normal",
        weight: "100 900",
    });
    addToFontFaceSet(document.fonts, interFont);
    interFont.load();
}

function loadHankenGroteskFont() {
    if (isHankenGroteskLoaded) {
        return;
    }
    isHankenGroteskLoaded = true;
    // variable font: a single woff2 covers the whole weight axis (same as Inter)
    const hankenFont = new FontFace("Hanken Grotesk", "url('fonts/hanken-grotesk-variable.woff2')", {
        style: "normal",
        weight: "100 900",
    });
    addToFontFaceSet(document.fonts, hankenFont);
    hankenFont.load();
}

function loadFonts() {
    loadHankenGroteskFont();
    loadInterFont();
    loadJetBrainsMonoFont();
    loadHackNerdFont();
}

export { loadFonts };
