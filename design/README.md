# design/

The spacing and sizing this product is built from, and the components that apply it.

Before this there were eleven pixel values doing the work of six -- 2, 4, 5, 6, 8, 10, 12, 16,
20 and 30 for gaps alone -- each chosen a component at a time. None of them was wrong on its
own, which is exactly why it happened: the result was two panes almost aligned and a dialog
whose columns were almost in step.

## The scale

`tokens.css` is the whole of it, as CSS custom properties on `:root`. Six steps of space, three
control heights, four widths, each with a line saying what it is for. Arithmetic is
`calc(var(--dev-space-4) * 2)`; there is deliberately no SCSS copy of the numbers, because two
definitions of one scale is the problem the file exists to end.

It is plain CSS imported from `tokens.ts` rather than SCSS `@use`d from a component. The shell
prepends its own SCSS to every component stylesheet through `additionalData`, so a `@use`
written in one is never the first rule in the sheet and sass refuses it.

The middle of the scale is 10px, which is Rancher's own `$space-s`. This product renders inside
Rancher's chrome, and a rhythm of its own would read as a mistake beside the header and nav it
sits between.

## The components

| Component | For |
| --- | --- |
| `Stack` | things in a column, one gap apart |
| `Row` | things in a line, one gap apart, with an alignment |
| `Spacer` | nothing, that takes the leftover room |
| `Panel` | a bordered box with a head that stays put and a body that scrolls |

They exist because `display: flex` is not the hard part. Writing it in thirty components means
choosing the gap thirty times, and the gap is the thing that was never the same twice. Here it
is a step on the scale, so the only gaps that exist are the ones on it.

Two of them also carry a fix for a bug this codebase hit twice. `Stack` sets `min-height: 0` and
`Row` sets `min-width: 0`, because a flex child's default is to shrink to its content: without
them a fixed-height row gets squeezed and a long name makes its container wider than the page.
Both took a measurement to find, and neither is obvious from reading the markup.

## Using them

```vue
<Row gap="4">
  <span>This workspace is stopped.</span>
  <RcButton>Start it</RcButton>
</Row>
```

A raw `padding: 10px` is not a crime, but it should be `var(--dev-space-4)`, and if it is a gap
between two elements it should probably be a `Stack` or a `Row`.
