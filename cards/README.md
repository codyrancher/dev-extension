# Focus cards

A card is one piece of work the deck can put in front of you, and this directory is where each one
is defined: what it claims, what it reads, what it shows, and what its buttons do. A card used to be
a declaration in one file and one of eleven hard-wired bodies in another, so a card somebody wanted
to change was neither of them. Now it is one file.

Each file is plain CommonJS and imports nothing:

```js
module.exports = {
  id:      'advisory',
  chip:    'Advisory',
  label:   'A security advisory',
  kind:    'signal',
  lede:    'severity',
  rules:   ['advisory-critical', 'advisory-high'],
  summary: '{why}',
  wants:   ['advisory'],
  actions: [
    { label: 'Open the advisory', verb: 'url' },
    { label: 'Later', verb: 'snooze', hours: 48 },
  ],
};
```

`rules` is the one key a card cannot do without: it names the rule ids whose work this card draws,
so a card with no rules claims nothing and never reaches the top of the deck. `wants` is what the
page fetches before drawing it, and asking for something a card does not show costs a round trip per
turn for nothing.

## The body

A card does not have to say how it draws. Leave `template` out and it gets `DEFAULT_BODY` —
`<CardSurface :api="api" />` — which is the dispatch that reads the `surface` the card declared, so
the card draws what the built-in surfaces have always drawn. That default lives in
`pkg/dev-extension/components/focus/card-runtime.ts`.

A card that wants its own body says so, and may use `setup` to put things in scope:

```js
  template: '<div class="mine"><StatPill :n="api.task.files" /></div>',
  setup(api) {
    return { api, mine: vue.computed(() => api.artifacts.files.length) };
  },
```

Inside a template you can name any component in
`pkg/dev-extension/components/focus/card-modules.ts`'s registry, and the loader will also resolve a
component by its file name even if nobody has registered it. A capitalised tag that resolves to
nothing is the one authoring mistake that fails *silently* — Vue's runtime compiler treats it as a
native element — so the card registry checks for it and the card reports it where its body would
have been, rather than drawing an empty box.

`styles` is scoped to the card, so a card may bring its own CSS without reaching other cards.

## What `api` carries

`pkg/dev-extension/components/focus/card-api.ts` is the contract: the task, the artifacts that
`wants` asked for, the notes, whether the card is interactive or claimed, the shell it can call
back into, and `api.vue` — the same Vue that is drawing the page, so a card can use `computed` and
`ref` without importing anything.

## Changing one

Cards are compiled into the bundle by `scripts/gen-cards.mjs`, so after editing a file here:

```bash
node scripts/gen-cards.mjs
```

That rewrites `pkg/dev-extension/cards.generated.ts`, which is generated — edit the card, not the
generated file.

A card is also overridable at runtime from a ConfigMap (`dev-card-<id>`, key `card.js`, labelled
`dev.rancher.io/kind=focus-card`), which is what makes a card editable without a release: the page
watches those and re-evaluates the module in place, keeping the last version that worked if the new
one throws. Anything added here has to keep working for a card that arrived that way, not only for
one compiled into the bundle.
