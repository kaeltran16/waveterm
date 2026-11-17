You are reviewing two independent implementations of the same feature. Both were written from the spec below by
different agents; you do not know which agent wrote which, and it does not matter. Judge only what the diffs show.

Compare them on:

1. Spec coverage: how much of what the spec requires each implementation delivers, and whether it adds scope the
   spec did not ask for.
2. Correctness: bugs, missed edge cases, and behaviour that contradicts the spec.
3. Tests: how well the tests prove the behaviour, meaning they would fail if the behaviour broke, rather than
   how many there are.
4. Simplicity: the smaller, clearer design wins when the other is no more correct or complete.

Weigh the four as a reviewer would for a change you were about to merge. Do not prefer a diff for its size, its
position in this message, or its label.

End your reply with one last line of JSON and nothing after it:

{"winner": "X", "why": "one or two sentences"}

`winner` is "X", "Y", or "tie" when you cannot separate them.

# Spec

{{SPEC}}

{{DIFFS}}
