# Spec: initial load time for the Focus deck

Written for engineers working on this extension, and for agents asked to implement any part of it.

## The measurement

Installed plugin 0.3.310, viewport 1512x982, 26 cards in the live deck, measured over CDP from the
router push to the first drawn card:

```
deckAppeared: 13111ms   firstCardAppeared: 13111ms
firstBodyDrew: 13111ms  firstCardSettled: 13111ms
```

49 requests, 1,390 KB. The four milestones are the same number, and that is the finding: nothing is
drawn progressively. The deck, the first card, its body and its settled state all appear in one
frame, 13 seconds after the user asked for them.

Where the time goes (total time across requests, which exceeds wall-clock because some overlap -
what matters below is the serial depth, not the sum):

| Requests | Count | Total time | Bytes |
|---|---|---|---|
| `/graphql` | 9 | 12,524 ms | 385 KB |
| `my-work/pr/{n}` | 10 | 11,605 ms | 868 KB |
| `my-work/depend` | 2 | 2,837 ms | 28 KB |
| `dev-secrets-local---user-…` | 9 | 231 ms | 11 KB |

The single worst request is one `/graphql` call at **9,274 ms for 354 KB**.

And in the bundle, measured from the shipped artifacts:

| | |
|---|---|
| Main chunk | 3,837,023 B minified, 1,038,469 B gzipped |
| Reachable only from other pages | ~714 KB min, ~193 KB gz |
| The runtime template compiler group | ~102 KB min, ~28 KB gz |

## The diagnosis

Three independent causes, in the order they cost the user time.

**1. The skeleton is held until every request finishes.** `loading` is cleared only in `load()`'s
`finally` (`pages/Focus.vue:849`) and `<DeckSkeleton v-if="loading" />` holds until then
(`pages/Focus.vue:1975`). So the first card waits on the entire chain - roughly 24-30 requests on a
cold mount with ~8 workspaces, at a serial depth of at least 6, with no timeout anywhere on it. This
is why all four milestones share a timestamp. Everything else on this list is a contributor; this is
the reason the contributions are not hidden.

**2. The deck fetches the whole queue's evidence before it draws one card.** `readStatusNow` fans
out over every unread workspace and is awaited *before the queue is even built*
(`pages/Focus.vue:795-800`). That is the measured `my-work/pr/{n}` x10, 868 KB: per-PR detail for
ten pull requests, when the first card needs one. Each is roughly 10-12 GitHub REST calls
server-side.

**3. Work that is already in memory is fetched again.** `myWork` makes two serial GraphQL round
trips and the second re-runs the first's issue search (`github.ts:653-660`, `github.ts:702`,
duplicated search at `github.ts:280-291` vs `github.ts:438-456`). `stat` and the CI counts are in
memory after `myWork`, yet every card still awaits a `prDetail` for them
(`focus-artifacts.ts:1242-1243`). `listComments` is fetched twice for the top card
(`pages/Focus.vue:843`). And `githubToken()` re-reads its Secret on every call with no memo
(`api.ts:2485-2498`) - the measured x9.

## Target

A readable first card in **under 1.5s on a warm navigation** and **under 4s cold**, where "readable"
means the card's chrome - chip, title, summary, identifier, workspace tag, overdue badge, the rail's
"4 of 26 waiting", and the footer buttons - with the surface showing its own reading state if its
artifacts have not arrived.

This is deliberately not "a complete first card in under 4s". See *Costs that stay* below.

## Changes, in the order to apply them

Each is independently applicable and the tree builds after each. Confidence is the analysis's, and
"measured" vs "estimated" is marked.

### Stage 1 - draw before the chain finishes

The whole of the measured 13.1s is gated on this stage. Nothing else matters as much.

1. **Draw the deck as soon as there is a queue, not when load() returns.** Flip `loading` where
   `items.value` is assigned (`pages/Focus.vue:803`) instead of in `finally` (`:849`). The cards
   behind the first already render against `NO_ARTIFACTS`, so this is a change of *when*, not *what*.
   *Effect: decisive for the first card on every visit after the first in a session. Estimated.*

2. **Move the `readStatusNow` fan-out off the critical path** (`pages/Focus.vue:795-800`). Build the
   queue first, read status for the card that wins, and let the rest resolve behind the drawn deck.
   *Effect: the largest single saving on a cold load - removes 9 of the 10 measured per-PR reads,
   roughly 868 KB and the bulk of 11.6s, from before-first-paint. Measured basis.*

3. **Cut `FIRST_PAINT_WAIT` from 3000ms to 200-300ms** (`pages/Focus.vue:84`, `:842-845`). It exists
   to avoid drawing a half-filled card, but the first card is always cold and the measured per-card
   read is 0-4000ms, so the race is lost at least as often as won - and a lost race costs the full
   3000ms for exactly the outcome it was avoiding. Keep a short race so a cache hit on a return
   navigation still draws complete, and reserve the facts band with
   `v-if="hasFacts || reading"` (`components/focus/FocusCard.vue:806`) so nothing shifts under the
   user when artifacts land. `.card__head` is a fixed 119px from the task alone and
   `.card__surface` already has a 120px floor, so the rest of the card does not move.
   *Effect: removes 0-3000ms, most often all of it. High confidence, estimated.*

### Stage 2 - stop re-fetching what is already known

Cheap, low-risk, and each removes a serial hop from a chain that is already 4-6 deep.

4. **Memoise the GitHub token Secret** (`api.ts:2485-2498`). *Measured: 9 requests to 1.*

5. **Run `myWork`'s two GraphQL trips in parallel** and stop the second re-running the first's issue
   search (`github.ts:653-660`, `:702`). *Effect: ~300-900ms off the critical path. Measured basis
   (9 calls, 12.5s total).*

6. **Serve `stat` and the CI counts from what `myWork` already returned** rather than awaiting
   `prDetail` per card (`focus-artifacts.ts:1242-1243`, `:471-480`, `:495-510`; the data is at
   `github.ts:322-357` and the `pr` fragment at `:195-249`). The facts strip and the `checks`/`files`
   ledes then draw with zero requests, and `bump` cards stop fetching a pull request at all.
   *Effect: first card and every turn. High confidence.*

7. **Stop gating detail-free branches behind `await prDetail`** (`focus-artifacts.ts:1242-1245`).
   `notes`, `media`, `live`, `pool`, `conversation`, `advisory`, `bump` and `bumps` never read it,
   yet all start at `t=prDetail`. *Effect: first card and every turn.*

8. **Unblock `reviewNotes` from `prDetail`** (`focus-review.ts:157-162`) - only the hunks need it.
   The review-pass lede and findings then appear at `listComments` latency (~50ms in-cluster)
   instead of seconds. This is what makes stage 1's shortened race unnecessary rather than merely
   unreached.

9. **Drop the duplicated `listComments`** for the top card (`pages/Focus.vue:843` vs
   `focus-artifacts.ts:1267-1268`) and the `notes` that `readArtifacts` writes but nothing reads
   (`focus-artifacts.ts:1267-1269`).

10. **Parallelise `load()`'s four independent reads** (`pages/Focus.vue:755` → `:759` → `:766` →
    `:775`). *Effect: serial depth 4 → 2 before `myWork` starts; 1-3 round trips.*

### Stage 3 - make a return navigation free

11. **Persist the artifact cache across navigations.** The URL already restores which card you were
    on (`pages/Focus.vue:196-212`, `:824-828`) but the 12-entry `seen` map is memory-only
    (`:463-464`), so a return visit is always cold - and here most visits are return visits. On a
    hit, `readTheArtifacts` takes the `held` branch and the card draws complete in the first frame.
    *Effect: with change 3, a return navigation becomes essentially instant.*

### Stage 4 - the bundle

Byte size, not milliseconds-to-first-card. Do this stage last and measure the warm path, because
item 13 can make the *measured* path slower if done carelessly.

12. **Split `card-modules.ts`'s `require.context` in two** (`components/focus/card-modules.ts:52`).
    This is item zero of the bundle work: the context is *not* the weight (a static-reachability
    pass shows only 5 files / 3,616 B are in the bundle solely because of it), but being
    **synchronous** makes all 170 modules hard dependencies of the entry chunk, which foreclosed
    every other split. Measured across the commit that introduced it: 11 JS files and a 3,515,524 B
    main chunk plus 185,397 B of separate `detail`/`edit`/`list`/vendor chunks became 5 JS files and
    a 3,816,723 B main chunk. Replace with (a) a sync context rooted at `components/` and `design/`
    matching capitalised `.vue` files only - which is all `componentsIn` and `missingComponents` can
    ever ask for - and (b) a `lazy-once` context over the rest for the explicit-path `require` case,
    warmed in `evaluate()` before any card whose source contains a path-shaped `require(`.
    *All 19 bundled cards contain zero `require(` calls, so the synchronous module-scope seed at
    `focus-cards.ts:89-91` is unaffected.*

13. **Make each route component a dynamic import** (`routing/index.ts:9-19`). Give `Focus.vue` and
    `DevShell.vue` the same chunk name and `webpackPrefetch: true`.
    *Effect: on a cold `/focus` URL - a reload, bookmark, userscript or share link - ~193 KB gz never
    downloads. **On a warm in-dashboard navigation this is net negative without the prefetch hint**,
    because the Focus code is in memory today and splitting it adds a ~256 KB gz fetch to the first
    click. The prefetch keeps the warm path free. Do not ship this without it.*

14. **Defer or precompile away the runtime template compiler** (`card-runtime.ts:29`, `:101-113`).
    It is ~102 KB min / ~28 KB gz on the first-card path, and since all 19 bundled cards now take
    `DEFAULT_BODY` its entire job at boot is compiling one 26-character string. Ship the bundled
    cards with a precompiled render function and load the compiler on demand for a ConfigMap card.
    *Note the CPU cost is negligible (0.15ms warm, ~2ms first) - the win is bytes, not time.*

### Deliberately not in scope

Rendering work the analysis found and priced, none of which is worth doing before the above:

- Five `FocusCard` instances mount in one synchronous frame, four unreadable
  (`FocusDeck.vue:112-121`); an rAF gate plus a `lite` prop is an estimated 20-50ms.
- Ten `blur(18px)` glow passes at first paint, eight behind a card and never seen
  (`FocusCard.vue:674-675`, `:1132-1152`); estimated 5-20ms of raster.
- `MiniCard` renders a full `FocusCard` at 840x520 and then blurs it to illegibility
  (`MiniCard.vue:64-77`); costs ~20% of the deck's render per pinned card.
- Two forced-layout sites on the load path (`FocusDeck.vue:517-520`, `MiniCard.vue:48`/`:55`).
- `componentFor`'s memo is keyed per card id although all 19 share one template
  (`card-api.ts:189-191`); 2-3ms, worth doing for tidiness, not as a load-time claim.

Each is small, and each is cheaper to judge once the first card is not waiting 13 seconds.

## Costs that stay

So the spec does not promise what it cannot deliver:

- **The cold `prDetail` round trip for the first card.** Four artifacts come off that one response,
  and racing four requests through the same cache is worse. It can be overlapped or pre-warmed,
  never removed, and it sets the floor on when the first card's *surface* can be complete.
- **A surface cannot draw before its artifacts arrive.** The honest promise is a fast, complete card
  *chrome* with a body that says it is still reading - not a fast complete surface.
- **`new Function` plus the compiler for a ConfigMap card.** This is the whole mechanism by which a
  card lives in a ConfigMap and is editable in a text box, and it is a requirement. It can be
  deduplicated across identical templates, not removed.
- **The synchronous 19-card seed** (`focus-cards.ts:89`). It exists so the deck has cards on the
  first paint rather than after a k8s round trip, and it costs its milliseconds at dashboard boot,
  not on navigation here. Making it lazy would make first paint depend on the ConfigMap list, which
  is strictly worse.
- **One composited layer for the top card.** The perspective on the card you are reading is the
  deck's whole visual claim; the saving is in the four behind it.

Two things that look like load-time wins and are not, recorded so nobody spends a day on them:

- **The ConfigMap watch does not block first paint.** `cardsSettled` (`focus-cards.ts:97`) is
  declared for that job and nothing reads it but a probe. Do not "fix" it.
- **`styleFor` and the 19-card module init** land on dashboard boot, not on navigation to the deck.

## How to verify

Re-run the cold-load measurement and require all four milestones to *differ*, since a single
timestamp is the signature of the present fault:

- `deckAppeared` well before `firstCardSettled`
- `firstCardAppeared` under 1,500ms warm / 4,000ms cold
- requests before `firstCardAppeared` in single figures, down from 24-30
- `my-work/pr/{n}` at **1** before first paint, down from 10
- the token Secret fetched **once**, down from 9

For stage 4, `ls dist-pkg/<version>/*.js` must show the JS file count go from 5 back to 11+, with
the `detail`, `edit` and `list` chunks restored and the main chunk smaller; grep the main chunk's
source map for `/detail/appsplus` and require 0 hits.

Then, because both are requirements rather than nice-to-haves: load a card from a ConfigMap that
names a component in its template, and one that does an explicit path `require`, and confirm live
reload still replaces a card within a couple of seconds of the ConfigMap changing.
