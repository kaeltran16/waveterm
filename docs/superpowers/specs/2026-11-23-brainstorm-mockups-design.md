# Seeing a brainstorm's mockups

## Intent

A brainstorm's mockups can't be seen well enough to choose between them. In the Brainstorm tab an answer's board is only a name chip. In the wide view it is a live thumbnail 200 px wide, about 14% of a 1440×900 board, so its text is around 2 px; a part's board is 300 px, about 21%. Full size opens the canvas window with one board, covering the question and its reasoning. You end up picking a design you can't see next to the arguments for it.

## Goals

- You choose between an answer's designs by looking at each board at near full size, with that answer's reasoning in view, and pick from there.
- Every board in a brainstorm, whether on a question or a part, is looked at the same way.

## Non-goals

- A side-by-side compare grid, or previews readable inside the tab. At the tab's width neither reaches a readable scale.
- Changing the board format, or cropping boards to a region.
- A second OS window.

## Anti-goals

- A board shrunk or covered in order to fit its reasoning beside it.
- The window opening by itself while you are working in the terminal.

## Decisions

**The canvas window is where you choose.** It opens on an answer's board at the window's width. You flip between the answers' boards in place with `[` and `]` or a digit, and picking in the window answers the question. Why: the window already fits one board to its width (close to real size) and already flips and picks, and flipping in place shows the difference between answers as a change on the same spot.

**An answer band sits over the board.** Under the window's toolbar, a band shows the answer whose board is shown: its number and label, the judge's or agent's pick mark, its detail, its pros and cons, and Pick. The board fills the window's width below the band and scrolls. Flipping to another answer's board swaps the band with it. Why: only width costs the board scale, so a band costs height alone and keeps the reasoning in view without shrinking or covering the board.

**The tabs come from where you opened the window.** Opened from an answer (its chip, or `o` on the question), the tabs are that question's answers, each shown as its number and label in answer order, and the window opens on the answer you came from. Opened from a part (its chip, or `o` in the builder check's review), the tabs are that part's boards. Either way, the canvas's other boards (today's screen, earlier questions' boards) sit behind one Other boards tab. That tab lays them out in a grid like today's All, and clicking one shows it alone with no band. `[` and `]` step through every tab, Other boards included, and Mark and Open in browser work on any single board shown. Opened from anywhere else (a Rendered card, the history, a board made this turn, or after the question has closed or while the agent is writing over it), the window is today's: every board by name, All, and no band. Why: today the tabs list every board on the canvas by file name and the answers get lost among them; taking the tabs from where you opened the window keeps them stable while the brainstorm moves on.

**Picking from the window.** Pick in the band sends that answer exactly as picking its row on the question does, then closes the window while the agent writes it up. If the send fails, the window stays open with the reason in the band. Why: this keeps today's behaviour.

**Several boards for one answer, one board for every answer.** An answer with several boards gets one tab per board, each named by the answer's number and the board's name, and each shows that answer's band. A board the question shows for every answer gets its own tab named Every answer; its band says it applies to every answer and has no Pick. A board two answers share shows both answers in its band, each with its own Pick. Why: every tab says which answer it shows.

**While the judge weighs.** The window works the same way over the approaches: the tabs are the approaches that have boards, and the band shows the approach's name and description with Pick. The judge has not written pros and cons yet, so the band has none. Why: you can already pick an approach while the judge weighs.

**Parts open the same way.** A part's boards, in the design list and the builder check's review, open the same window. Its tabs are that part's boards, and the band names the part (its title and one-line gist) with no Pick. Why: those thumbnails are just as unreadable, and the review is where you confirm the design.

**The tab shows name chips at every width.** Answer rows, parts and the boards made this turn show their boards as small name chips at every width, never as thumbnails, and a chip opens the window on that board. Every thumbnail in the brainstorm goes: the wide view's 200 px, the parts' 300 px and this turn's 220 px. Why: once the window does the looking, the tab only needs a cheap way in, and chips load no board until one is opened.

**`o` opens the window.** While the brainstorm is shown, `o` opens the window. On an open question it opens on the focused answer's first board, or the first answer's when no answer is focused. In the builder check's review it opens on the boards of the part under the cursor. In the design list, which has no cursor, it does nothing: a part's chips open its boards there. It does nothing when there is no board to show, and the keyboard shortcuts list it with the brainstorm's keys. Why: no key opens the window from a brainstorm today, and `o` is free on the Agent surface (`v` already switches between Terminal and Rendered).

**Answer boards compare like for like.** The brainstorm skill tells agents that the boards for one question's answers show the same screen, at the same moment, with the same data, so flipping between them shows only what the answer changes. A board carries no banner restating its option, since the band says it. Why: when one answer's board draws a whole review screen and the others a landing list, the fuller board looks worse just for showing more.

## Left to the builder

- The band's exact layout and type sizes, within DESIGN.md.
- How a board taller than the window scrolls under the band.
- Removing the thumbnail code the chips replace.
- Where Mark and Open in browser sit in the window's toolbar.
- Updating the brainstorm UI scenarios and the keyboard shortcuts doc.
