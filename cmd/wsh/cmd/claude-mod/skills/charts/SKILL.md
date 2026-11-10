---
name: charts
description: Use when numbers in your answer would read better as a chart than as a table or prose (timings, counts, sizes, a trend over runs or days, one value against another) and you are running inside Arc — write a ```chart fenced block that Arc draws as a bar, line, area or scatter chart.
---

# Charts in Arc

Arc draws a fenced block whose language is `chart` as a chart card wherever it renders your markdown.
Put JSON in it. Everywhere else (a plain terminal, another viewer) it stays a readable code block, so
say the key numbers in prose too.

Use a chart when there are enough numbers that a shape tells the story: five packages by wall time, a
metric over twenty runs, size against duration. Do not chart two or three numbers; write them.

## Schema

```
{
  "type": "bar" | "line" | "area" | "scatter",
  "title": "Slowest test packages, wall time",
  "x": { "label": "package" },
  "y": { "label": "wall time", "unit": "s" },
  "series": [
    { "name": "wall", "points": [{ "x": "pkg/orchestrate", "y": 118 }] }
  ]
}
```

- `type`, `title` and `series` are required. `x` and `y` are optional; `unit` is appended to each value
  as written (`"s"`, `"ms"`, `"%"`, `" MB"`).
- `x` is a string category or a number. Bar charts use categories; line and area take either; a
  `scatter` needs a numeric `x` on every point.
- `y` is a finite number. No strings, no `null`, no `NaN`.
- At most 8 series and 500 points per series. A series with more points: aggregate or sample first.
- Bars are horizontal, one row per category, in the order the points first appear: sort them yourself
  (largest first reads best).
- More than one series draws a legend, and each category's row holds one thin bar per series.
- The JSON must be strict: double quotes, no comments, no trailing commas.

If the block is not valid, Arc shows the raw block with the reason instead of a chart. The user can
always open the raw spec from the card's `spec` toggle.

## Examples

Bar: categories against one value.

```chart
{"type": "bar", "title": "Slowest test packages, wall time", "y": {"unit": "s"},
 "series": [{"name": "wall", "points": [
   {"x": "pkg/orchestrate", "y": 118}, {"x": "pkg/jarvis", "y": 41},
   {"x": "pkg/wstore", "y": 22}, {"x": "pkg/agentsync", "y": 15}, {"x": "pkg/wshrpc", "y": 9}]}]}
```

Line: a trend, one or more series.

```chart
{"type": "line", "title": "Run wall time by day", "x": {"label": "day"}, "y": {"label": "wall", "unit": "m"},
 "series": [
   {"name": "p50", "points": [{"x": "11-03", "y": 21}, {"x": "11-04", "y": 19}, {"x": "11-05", "y": 24}]},
   {"name": "p90", "points": [{"x": "11-03", "y": 38}, {"x": "11-04", "y": 33}, {"x": "11-05", "y": 41}]}]}
```

Area: a cumulative or volume trend.

```chart
{"type": "area", "title": "Tokens per hour", "x": {"label": "hour"}, "y": {"label": "tokens"},
 "series": [{"name": "tokens", "points": [{"x": 9, "y": 120000}, {"x": 10, "y": 340000}, {"x": 11, "y": 210000}]}]}
```

Scatter: one number against another; `x` must be numeric.

```chart
{"type": "scatter", "title": "Diff size vs review time", "x": {"label": "lines changed"},
 "y": {"label": "review", "unit": "s"},
 "series": [{"name": "tasks", "points": [{"x": 40, "y": 31}, {"x": 220, "y": 95}, {"x": 610, "y": 240}]}]}
```
