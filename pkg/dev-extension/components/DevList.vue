<script>
// One titled column of rows: a heading with a create control, rows with a state dot and a
// delete, and a line for when there are none.
//
// It exists because the product has two of these columns and they were two different pieces of
// markup. The sidebar's workspaces had a dot, a create and a two-step delete; the conversation
// list beside a workspace had a dot it computed itself, a create button in a different place and
// no delete at all, so a conversation could be opened and never closed. They are the same thing
// and they are now the same component.
//
// The metrics are Rancher's own, kept from the sidebar this was lifted out of: the shell's nav
// rows are 33px tall with a 16px left inset and 14px labels on a 16px line
// (components/nav/Group.vue), and $space-s is its small step. Nothing here is picked to match a
// screenshot.
//
// Not the shell's `nav/Type.vue` or `nav/Group.vue`, and both were tried. Type renders its own
// `<li>`, so a row that needs a dot before the link and a delete after it ends up with an `<li>`
// inside an `<li>`; Group renders its children through Type with no slot between them, so
// neither a dot nor a delete can reach a row at all.
import BrandImage from '@shell/components/BrandImage';
import NavHead from './NavHead.vue';
import { colorForState, stateDisplay } from '@shell/plugins/dashboard-store/resource-class';
import HoverCard from './HoverCard.vue';
import hoverCard from './hover-card';

// A status tone to the dot colour that matches its status text. The same palette the detail line
// uses (see the `&__detail--<tone>` and `&__dot--<tone>` rules, and workspace-status Tone), so a
// running row reads one colour top to bottom rather than the pod's green beside an amber status.
const TONE_DOT = {
  green:     'dev-list__dot--green',
  attention: 'dev-list__dot--attention',
  waiting:   'dev-list__dot--waiting',
  working:   'dev-list__dot--working',
  muted:     'dev-list__dot--muted',
};

export default {
  name: 'DevList',

  components: { BrandImage, HoverCard, NavHead },

  mixins: [hoverCard],

  emits: ['select', 'create', 'delete', 'rename'],

  props: {
    /**
     * The heading. Uppercased by the stylesheet, so pass it in its ordinary case.
     *
     * Empty is allowed and means the column is named by whatever is above it: the heading row
     * stays, because the create control lives in it, and only the words go.
     */
    label: {
      type:    String,
      default: '',
    },

    /** The heading's glyph, from Rancher's icon font. */
    icon: {
      type:    String,
      default: '',
    },

    /**
     * A brand image for the heading instead of a glyph, by file name in the shell's assets.
     *
     * Which is the only way to use Rancher's own mark: it is an SVG rather than a character in
     * the icon font, so there is no class that draws it. BrandImage is what the shell's own
     * header uses, so a Rancher with custom branding gets its logo here too.
     */
    logo: {
      type:    String,
      default: '',
    },

    /**
     * The rows: `{ key, label, state, to, fixed }`.
     *
     * `fixed` marks a row that is not one of the things the list is a list of - the workspace's
     * own shell among its conversations - which gets neither a rename nor a delete.
     *
     * `state` is a Rancher state name, so the dot is the same colour it would be in a table.
     * `to` makes the row a link; a row without one is a button and selecting it is an event,
     * which is the difference between a workspace (a page) and a conversation (a pane).
     */
    rows: {
      type:    Array,
      default: () => [],
    },

    /** The key of the row that is selected. */
    current: {
      type:    [String, Number],
      default: '',
    },

    /** Where the heading's create control goes, when it is a link rather than an event. */
    createTo: {
      type:    Object,
      default: null,
    },

    /** What the create control says. No label, no control. */
    createLabel: {
      type:    String,
      default: '',
    },

    /** Whether rows can be deleted. The confirm step is this component's. */
    deletable: {
      type:    Boolean,
      default: false,
    },

    /**
     * Whether rows can be renamed, in place: a pencil on the row, then the name is an input
     * until Enter or a click away. On the row itself rather than in a control below the list,
     * because the name being changed is the thing being pointed at.
     */
    renamable: {
      type:    Boolean,
      default: false,
    },

    /**
     * Optional headings inside the list: `{ id, label, icon, rows }`, drawn in order with a
     * small heading above each. The sidebar splits a workspace app's rows by the part you play
     * in them; the list is still one list, because the app is still one thing.
     *
     * Groups with no rows are left out. With no groups the list draws `rows` as it always has.
     */
    groups: {
      type:    Array,
      default: () => [],
    },

    empty: {
      type:    String,
      default: 'None yet',
    },

    /**
     * A word about the heading's state, which colours it. '' is the ordinary case.
     *
     * The sidebar uses it to say that a cluster is running out of room, which is a thing worth
     * seeing without opening anything.
     */
    tone: {
      type:    String,
      default: '',
    },
  },

  computed: {
    /** What to draw: the groups that have rows, or one nameless block holding `rows`. */
    blocks() {
      const groups = this.groups.filter((group) => group.rows?.length);

      return groups.length ? groups : [{ id: '', label: '', rows: this.rows }];
    },

    /** Whether there is anything at all to draw, groups or not. */
    anyRows() {
      return this.blocks.some((block) => block.rows.length);
    },
  },

  data() {
    return {
      renaming: '',
      draft:    '',
      /**
       * Rows whose delete has been asked for and not yet finished.
       *
       * A delete is not instant - the Installation has to tear down what it deployed before it
       * can go - and until this existed the UI said nothing at all about that: the tick was
       * pressed, the controls went back to how they started, and the row sat there looking
       * exactly like a row nobody had touched. There was no way to tell "still working" from
       * "silently failed", which is the difference somebody actually needs.
       *
       * Held here rather than derived from the row's state, because the state comes from a poll
       * and the poll is seconds behind the press.
       */
      deleting:   {},
    };
  },

  methods: {
    /**
     * The dot's colour, from Rancher's own state colours, with one deliberate exception.
     *
     * `colorForState('stopped')` is error red, because in the rest of Rancher a stopped thing is
     * a thing that stopped. Here it is something someone pressed Stop on, which is the ordinary
     * way to leave one, and a red dot next to it says the same thing as the red dot next to a
     * crash loop. Muted is what the nav already uses for "nothing to report".
     */
    dotClass(row) {
      if (this.isDeleting(row)) {
        // Red, and pulsing (see the CSS): this is a destructive state in progress, which is
        // what the colour means everywhere else in the nav.
        return 'text-error';
      }

      // A workspace that is not running is coloured by its lifecycle: stopped is muted (someone
      // pressed Stop, the ordinary way to leave one), the rest are Rancher's own state colours.
      if (row.state && row.state !== 'running') {
        return row.state === 'stopped' ? 'text-muted' : colorForState(row.state);
      }

      // A running row - or a conversation, which has no run state of its own - is coloured by
      // what its status is, so the dot reads the same colour as the words beneath it: one status,
      // one colour, rather than a running pod's green beside an amber "your pass".
      return TONE_DOT[row.tone] || colorForState(row.state);
    },

    stateLabel(row) {
      return this.isDeleting(row) ? 'Deleting' : stateDisplay(row.state);
    },

    /**
     * Open a row's card: what it has to say, and what can be done to it.
     *
     * Every row that can be deleted gets one even with nothing to say, because the delete is in
     * the card now - a control that is only there while the pointer is on the row is a control
     * you have to chase, and one that appears and disappears under the pointer is one you press
     * by accident. A row that can neither say anything nor be acted on has no card at all.
     */
    showCard(row, event) {
      if (!row.card && !this.canDelete(row)) {
        return;
      }
      const card = row.card || {};

      this.openCard(row, event, {
        title: card.title || row.label, lines: card.lines || [], links: card.links || [],
      });
    },

    /** Delete from the card: the card goes at once, since what it was about is on its way out. */
    removeFromCard(row) {
      this.dropCard();
      this.remove(row);
    },

    /** Whether this row's delete is offered, which is also what gives a plain row a card. */
    canDelete(row) {
      return this.deletable && !row.fixed && !this.isDeleting(row);
    },

    detailClass(row) {
      return `dev-list__detail--${ row.tone || 'muted' }`;
    },

    startRename(row) {
      this.renaming = row.key;
      this.draft = row.label;
      this.$nextTick(() => this.$refs[`rename-${ row.key }`]?.[0]?.focus?.() || this.$refs[`rename-${ row.key }`]?.focus?.());
    },

    commitRename(row) {
      const title = this.draft.trim();

      this.renaming = '';

      if (title && title !== row.label) {
        this.$emit('rename', { key: row.key, title });
      }
    },

    remove(row) {
      // Marked before the emit, so the row goes red under the finger that pressed it rather
      // than on the next poll.
      this.deleting = { ...this.deleting, [row.key]: Date.now() };
      this.$emit('delete', row.key);
    },

    /** Whether this row is mid-delete: asked for, and still here. */
    isDeleting(row) {
      return !!this.deleting[row.key];
    },
  },
};
</script>

<template>
  <section class="dev-list">
    <NavHead
      :label="label"
      :icon="icon"
      :logo="logo"
      :tone="tone"
      :create-label="createLabel"
      :create-to="createTo"
      @create="$emit('create')"
    />

    <ul>
      <!--
        The rows, under their group headings where the list has groups: the sidebar splits a
        workspace app by the part you play in each of its workspaces. Without groups this is
        one nameless block and the list draws exactly as it did.
      -->
      <template
        v-for="block in blocks"
        :key="block.id || 'all'"
      >
        <li
          v-if="block.label"
          class="dev-list__subhead"
        >
          <i
            v-if="block.icon"
            class="dev-list__subhead-glyph icon"
            :class="block.icon"
          />
          <span class="dev-list__subhead-label">{{ block.label }}</span>
        </li>
        <li
          v-for="row in block.rows"
          :key="row.key"
          :class="{ 'dev-list__row--current': row.key === current, 'dev-list__row--tall': row.detail || row.reserveDetail, 'dev-list__row--grouped': !!block.label }"
          class="dev-list__row"
          @mouseenter="showCard(row, $event)"
          @mouseleave="hideCard"
        >
          <!--
            The state class goes on the wrapper and the glyph reads it back through currentColor,
            which is what lets the stylesheet adjust it for the theme without knowing which state
            it is. See the __dot rule.
          -->
          <component
            :is="row.to ? 'router-link' : 'button'"
            v-if="renaming !== row.key"
            class="dev-list__link"
            :class="{ 'dev-list__link--deleting': isDeleting(row) }"
            :to="row.to"
            :type="row.to ? null : 'button'"
            @click="row.to ? null : $emit('select', row.key)"
          >
            <span
              v-clean-tooltip="stateLabel(row)"
              class="dev-list__glyph dev-list__dot"
              :class="dotClass(row)"
            ><i class="icon icon-dot" /></span>
            <span
              v-if="renaming !== row.key"
              class="dev-list__text"
            >
              <span
                class="dev-list__name"
                :title="row.card ? null : (row.title || row.label)"
                @dblclick.prevent="renamable && !row.fixed && startRename(row)"
              >{{ row.label }}</span>
              <!--
                What the work needs and what the agent is doing, under the name, in the colour of
                how much it needs the person. See workspace-status.ts.
              -->
              <span
                v-if="row.detail || row.reserveDetail"
                class="dev-list__detail"
                :class="detailClass(row)"
              >
                <span class="dev-list__detail-text">{{ row.detail }}</span>
                <!--
                  The PR's checks, in their own colour rather than the row's: the row's colour
                  says how much the work wants a person, and a red check is a fact about the PR
                  whatever the work is waiting on. The counts are on the title, since the line
                  is a column's width and "2 of 14 failing" is a sentence.
                -->
                <span
                  v-if="row.ci"
                  class="dev-list__ci"
                  :class="`dev-list__ci--${ row.ci.tone }`"
                  :title="row.ci.title"
                >{{ row.ci.label }}</span>
              </span>
            </span>
            <!--
              Said in words as well as in colour: a dot going red is not a message somebody reads,
              and a spinner beside it shows the delete is doing work rather than stuck. Both go
              when the row does.
            -->
            <span
              v-if="isDeleting(row)"
              class="dev-list__deleting"
            ><i class="icon icon-spinner icon-spin" /> Deleting</span>
          </component>
          <input
            v-if="renaming === row.key"
            :ref="`rename-${ row.key }`"
            v-model="draft"
            class="dev-list__rename"
            type="text"
            :aria-label="`Rename ${ row.label }`"
            @keydown.enter.prevent="commitRename(row)"
            @keydown.esc.prevent="renaming = ''"
            @blur="commitRename(row)"
            @click.stop
          >
          <button
            v-if="renamable && !row.fixed && renaming !== row.key"
            v-clean-tooltip="`Rename ${ row.label }`"
            type="button"
            class="dev-list__control dev-list__reveal dev-list__rename-btn"
            :aria-label="`Rename ${ row.label }`"
            @click.stop="startRename(row)"
          >
            <i class="icon icon-edit" />
          </button>
        </li>
      </template>

      <li
        v-if="!anyRows"
        class="dev-list__empty"
      >
        {{ empty }}
      </li>
    </ul>
    <!--
      The row the pointer is on, in the card every list in this product uses (HoverCard).

      The delete is in here rather than on the row, and there is still no confirm step: the
      moment it is pressed the row goes red and says it is deleting (see isDeleting and the row
      classes above), which is both the acknowledgement and the progress. A delete that has
      visibly started and is visibly working does not need to have been confirmed first.
    -->
    <HoverCard
      v-if="card"
      :card="card"
      @keep="keepCard"
      @hide="hideCard"
    >
      <template
        v-if="canDelete(card.item)"
        #actions
      >
        <button
          type="button"
          class="dev-list__control dev-list__delete"
          :aria-label="`Delete ${ card.item.label }`"
          @click="removeFromCard(card.item)"
        >
          <i class="icon icon-trash" /> Delete
        </button>
      </template>
    </HoverCard>
  </section>
</template>

<style lang="scss" scoped>
  $row-height: 33px;
  /*
   * The left inset, and the width of the icon slot.
   *
   * `--dev-inset` rather than a number of its own, because this is the same column the top bar,
   * the page headings and the page content are all drawn to - and while it was 16px against
   * their 20px, it was the one thing on screen that started somewhere else. A sidebar row is the
   * left edge of the product; if anything defines that column it is this, and it should not be
   * a second opinion about it.
   *
   * Still a SCSS variable, because the calc below reads better than nesting var() twice, and
   * because every other length in this file is one. Sass interpolates inside comments too, so
   * this one deliberately shows no example of the syntax it is describing.
   */
  $rail: var(--dev-inset);
  // The scale, not a number of this file's own. See design/tokens.css.
  $gap: var(--dev-space-3);
  $control: 22px;   // the right-hand control, the same box in both kinds of row

  .dev-list {
    // The rule between two stacked lists, and only between them. It used to be a border on every
    // heading, which is the same thing as long as a list is one of several in a column: on its
    // own, under something that already draws a line (a tab strip, a page header), it is a second
    // line a pixel below the first.
    & + & {
      border-top: 1px solid var(--nav-border, var(--border));
    }

    ul {
      margin:     0;
      padding:    0;
      list-style: none;
    }

    // The heading is NavHead's now (same box, same insets, same three columns); what is left
    // here is the row.
    &__row {
      display:       flex;
      align-items:   center;
      box-sizing:    border-box;
      width:         100%;
      height:        $row-height;
      margin:        0;
      padding:       0 $gap 0 $rail;
    }

    /*
     * A row under a group heading: further in than the heading, and joined to it by a hairline
     * down the gutter, so a list of eight workspaces reads as two groups rather than as eight
     * workspaces with two labels somewhere in them.
     */
    &__row--grouped {
      position:     relative;
      padding-left: 26px;

      &::before {
        content:    '';
        position:   absolute;
        left:       16px;
        top:        0;
        bottom:     0;
        width:      1px;
        background: var(--border);
      }
    }

    // The left rail: the section's icon and a row's state dot are the same box, so they share
    // one vertical line, and the labels after them share another.
    &__glyph {
      flex:         0 0 $rail;
      width:        $rail;
      margin-right: $gap;
      text-align:   left;
    }

    // One colour for every name, whatever state it is in: a stopped workspace is still one whose
    // name you are trying to read. State is the dot's job and only the dot's.
    //
    // The reset is here rather than only on the link, because a row without a route is a BUTTON
    // and the shell gives every one of those a border, a background and a 40px minimum height.
    &__link {
      display:         flex;
      align-items:     center;
      flex:            1 1 auto;
      min-width:       0;
      height:          100%;
      min-height:      0;
      margin:          0;
      padding:         0;
      border:          none;
      background:      transparent;
      color:           var(--body-text);
      font-family:     inherit;
      font-size:       14px;
      line-height:     16px;
      text-align:      left;
      text-decoration: none;
      appearance:      none;
      cursor:          pointer;

      &:hover,
      &:focus {
        text-decoration: none;
      }
    }

    &__row {
      .icon-dot {
        font-size:   8px;
        line-height: 1;
      }

      &:hover {
        background: var(--nav-hover, var(--accent-btn));
      }

      // Selected is a background and a weight, not a colour. Rancher's own nav pairs
      // --active-nav with --on-active, but only the second is defined in every theme here, and
      // taking one without the other is how a selected row ends up white on white.
      &--current {
        background: var(--nav-hover, var(--accent-btn));

        .dev-list__link {
          font-weight: 600;
        }
      }
    }

    // The state dot, pulled toward the body text until it is legible on the body background.
    //
    // Rancher's state colours are not theme-aware: --success is rgb(0, 112, 50) in both themes,
    // and only the background moves, so on the dark nav it measures 2.36:1 where a graphical
    // object needs 3:1. --error and --primary have the same problem. There is no token to switch
    // to either: the click-badge family is white for error and info in both themes, and the gauge
    // colours are a different vocabulary.
    //
    // So the state colour is kept and mixed toward --body-text, which is the one colour each
    // theme guarantees against its own background. In dark that lightens it, in light it deepens
    // it, and the direction is right in both without this file knowing which theme it is in or
    // inventing a colour of its own. A browser without color-mix ignores the declaration and gets
    // the state colour unchanged, which is where this started.
    // currentColor in a `color` declaration is the inherited value, so this is the state colour
    // the span carries (text-success and the rest) mixed toward the theme's body text, rather
    // than a second copy of Rancher's palette written out here.
  // A row on its way out: dimmed, pulsing, and plainly not a row to press again. The pulse is
  // what says "working" rather than "stuck" - a static red row could be either.
  &__link--deleting {
    animation: dev-list-deleting 1.4s ease-in-out infinite;
  }

  &__deleting {
    flex:           0 0 auto;
    display:        inline-flex;
    align-items:    center;
    gap:            4px;
    margin-left:    auto;
    padding-right:  $gap;
    color:          var(--error);
    font-size:      11px;
    letter-spacing: 0.02em;
    white-space:    nowrap;
  }

  &__dot .icon-dot {
      // The disc is the exact colour of its state or status - the same token the label beside it
      // uses - so the two read as one status. It used to be softened 45% toward the body text,
      // which left the disc a paler shade than its label; that gap is the mismatch this removes.
      color: inherit;
    }

    // The dot coloured by a status tone, matched to the detail line beneath it. The canonical
    // status palette (workspace-status Tone), so every status disk in the product reads the same.
    &__dot--green     { color: var(--status-done); }
    &__dot--attention { color: var(--status-input); }
    &__dot--waiting   { color: var(--status-waiting); }
    &__dot--working   { color: var(--status-working); }
    &__dot--muted     { color: var(--status-idle); }

    // The lifecycle discs come from Rancher's own state colours as text-* classes (a workspace
    // with no status yet, stopped, error, a delete in progress). Soften those to the same palette
    // so every disc in the list is drawn in the pastel, never the raw state colour.
    &__dot.text-success .icon-dot { color: var(--status-done); }
    &__dot.text-warning .icon-dot { color: var(--status-input); }
    &__dot.text-info    .icon-dot { color: var(--status-waiting); }
    &__dot.text-error   .icon-dot { color: var(--status-error); }
    &__dot.text-muted   .icon-dot { color: var(--status-idle); }

    // The name, truncated rather than wrapped: a row is one line and a workspace name can be
    // forty characters. It shrinks before the control does, so a long name never runs under it.
    &__text {
      display:        flex;
      flex-direction: column;
      min-width:      0;
      flex:           1 1 auto;
      line-height:    1.25;
    }

    &__name {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }

    &__detail {
      display:       flex;
      align-items:   center;
      gap:           5px;
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      font-size:     11px;
      line-height:   1;
      color:         var(--muted);
      // Reserve the line even before the status has loaded, so the name above does not jump down
      // when it arrives. A workspace row asks for this from the moment it appears (reserveDetail).
      min-height:    13px;

      .icon {
        font-size:   10px;
        // Centre the glyph on the text: align-items handles the box, line-height:1 drops the
        // icon font's own vertical padding that made it sit high.
        line-height: 1;
      }
    }

    // The stage's own words. It is the part that gives way when the line is too narrow, so that
    // a long stage name never pushes the checks off the end - which is the half a glance is for.
    &__detail-text {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
      min-width:     0;

      &--green {
        color: var(--status-done);
      }

      &--attention {
        color: var(--status-input);
      }

      &--waiting {
        color: var(--status-waiting);
      }
    }

    // The checks, said briefly and in their own three colours. Separated from the stage by a
    // middle dot drawn here rather than typed into the text, so the line reads as one thing
    // when there is no chip and as two when there is.
    &__ci {
      flex:        0 0 auto;
      white-space: nowrap;

      &::before {
        content: '·';
        margin-right: 4px;
        color:        var(--muted);
      }

      &--green     { color: var(--status-done); }
      &--attention { color: var(--status-input); }
      &--error     { color: var(--status-error); }

      &--working {
        color: var(--status-working);
      }
    }

    &__row--tall {
      height:     auto;
      min-height: $row-height;
      padding:    3px 0;
    }

    /*
     * A tall row zeroes its own left padding - it is drawn without the rail - so a grouped row
     * that is also tall has to be told its indent again, after that rule and over it.
     */
    &__row--tall#{&}__row--grouped {
      padding-left: 26px;
    }

    // The right-hand control of either row: one box, one column, one place.
    //
    // `min-height` as well as `height`, because one of the shell's global BUTTON rules sets a
    // 40px minimum and a minimum beats a height. Without it the row's delete is a 22x40 box
    // against the section's 22x22 plus, and the two rails stop lining up.
    &__control {
      display:         flex;
      align-items:     center;
      justify-content: center;
      flex:            0 0 $control;
      width:           $control;
      height:          $control;
      min-height:      $control;
      padding:         0;
      border:          none;
      border-radius:   var(--border-radius);
      background:      transparent;
      color:           var(--muted);
      cursor:          pointer;

      .icon {
        font-size: 12px;
      }
    }

    // The create control, outlined so it reads as a button rather than as another row icon.
    //
    // Both colours here are foreground tokens rather than --primary and --border, and that is
    // the point: --primary on the nav background is 2.93:1 in dark, and --border is about 1.4:1
    // in both themes, which is a control nobody can see with a glyph nobody can read. --muted
    // and --body-text are the two colours this nav already uses for text, so they are legible on
    // it by construction.
    &__control--bordered {
      border: 1px solid var(--muted);
      color:  var(--body-text);

      &:hover {
        background: var(--nav-hover, var(--accent-btn));
      }
    }

    // Quiet until you are on the thing it acts on, and always there for a keyboard. Opacity
    // rather than display, so the row's layout is the same whether it is showing or not.
    &__reveal {
      opacity: 0;

      &:focus-visible {
        opacity: 1;
      }
    }

    // On the row the control acts on, rather than anywhere in the list: in the sidebar a list
    // is as tall as its rows, so "the list" and "this row" are nearly the same place, but in
    // the conversations column it fills a 210px column and the control showed whenever the
    // pointer was anywhere in it.
    &__row:hover &__reveal {
      opacity: 1;
    }

    // The name, as an input, in the room the name had.
    &__rename {
      flex:       1 1 auto;
      min-width:  0;
      height:     24px;
      margin:     0 $gap 0 0;
      padding:    0 6px;
      font-size:  14px;
    }

    &__rename-btn {
      &:hover,
      &:focus-visible {
        opacity: 1;
        color:   var(--dev-accent);
      }
    }

    // The delete, which lives in the row's card (see HoverCard): wide enough for the word
    // beside the glyph, since in a card there is room to say what the button does.
    &__delete {
      width:       auto;
      gap:         var(--dev-space-2);
      padding:     0 var(--dev-space-2);
      opacity:     1;
      white-space: nowrap;

      &:hover,
      &:focus-visible {
        opacity: 1;
        color:   var(--error);
      }
    }

    // The confirm step: a small destructive button that says the word rather than a glyph. It
    // is always visible (no reveal-on-hover) because it only exists for the moment between the
    // trash icon being pressed and the delete happening, and a confirm you have to hover to
    // find is a confirm nobody completes.
    /*
     * A heading inside the list. Quieter than the list's own heading - smaller, no rail of its
     * own - because it divides a list rather than starting one, and a sidebar of headings that
     * all shout is a sidebar nobody reads.
     */
    &__subhead {
      display:        flex;
      align-items:    center;
      gap:            6px;
      /*
       * Left of the rows it heads, not right of them. Lining the heading up with the rows'
       * text put it further in than the workspaces underneath it, which reads as the rows
       * being the outer thing - so the heading sits under the app's own icon instead, and the
       * rows move out past it.
       */
      padding:        var(--dev-space-3) #{$gap} var(--dev-space-1) 26px;
      color:          var(--muted);
      font-size:      10px;
      font-weight:    600;
      letter-spacing: 0.08em;
      text-transform: uppercase;

      &:first-child { padding-top: 2px; }

      // A group that sits under another - Reviewer below Developer, Other below either - wants
      // clear air above it so the two read as separate lists rather than one run-on. A subhead
      // right after a row is exactly that case; the first group heads the list and keeps its
      // tight top above.
      .dev-list__row + & { padding-top: var(--dev-space-5, 18px); }
    }

    &__subhead-glyph {
      font-size: 11px;
      opacity:   .8;
    }

    &__empty {
      /*
       * Aligned with a row's label, not with its rail.
       *
       * The left inset is the same three the row spends before its text: the row's own left
       * padding ($rail), the glyph slot ($rail wide), and the gap after it ($gap). Written as
       * a sum of var()s rather than `calc(#{$rail} ...)` because $rail and $gap are custom
       * properties now, not sass numbers - the old form also divided $gap by 2 for the bottom
       * padding, which sass cannot do to a var() and which silently voided the whole
       * declaration, leaving the text hard against the edge (measured: 0px against the label's
       * 46px).
       */
      padding:   0 $gap var(--dev-space-2) calc(#{$rail} + #{$rail} + #{$gap});
      color:     var(--muted);
      font-size: 12px;
    }
  }
@keyframes dev-list-deleting {
  0%, 100% { opacity: 0.85; }
  50%      { opacity: 0.4; }
}
</style>

