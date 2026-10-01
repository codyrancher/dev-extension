<script>
// The skills the agents run on: read here and edited here. A save reaches every running
// workspace at once and, when asked, the repository the skills are kept in. See skills.ts.
//
// A skill is a directory, not a file. A third of them carry something beside the prose - a
// `share.sh`, an `a11y-probe.mjs`, a manifest - that the SKILL.md tells the agent to run, and
// editing the prose while the script it names stays as it was is editing half the skill. So the
// editor is a file picker over the skill's directory, and every file in it saves and commits the
// same way.
//
// The list is the same row and the same hover card the navigation uses (NavRow, HoverCard), so
// a list of skills reads like a list of workspaces rather than like a different product.
//
// There is no agent on this page. Asking an agent to improve a skill used to be a panel at the
// bottom with a conversation picker of its own, which is a second way to start a conversation on
// a page whose subject is a file - and the product already has one that is always to hand.
import Loading from '@shell/components/Loading';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import NavRow from '../components/NavRow.vue';
import NavHead from '../components/NavHead.vue';
import HoverCard from '../components/HoverCard.vue';
import hoverCard from '../components/hover-card';
import {
  listSkills, readSkill, saveSkill, resetSkill, refreshSkillsEverywhere
} from '../skills';

/** The prose, which every skill has and which is what the page opens on. */
const PROSE = 'SKILL.md';

export default {
  name: 'DevSkills',

  components: {
    Loading, Banner, RcButton, NavRow, NavHead, HoverCard
  },

  mixins: [hoverCard],

  async fetch() {
    await this.load();
  },

  data() {
    return {
      skills:        [],
      version:       '',
      filter:        '',
      selected:      '',
      skill:         null,
      /** Which file of the skill is open, by path. Always a file the skill has. */
      path:          PROSE,
      draft:         '',
      loadingSkill:  false,
      busy:          '',
      error:         '',
      notice:        '',
      commitMessage: '',
    };
  },

  computed: {
    shown() {
      const f = this.filter.trim().toLowerCase();

      return f ? this.skills.filter((s) => s.name.includes(f) || s.description.toLowerCase().includes(f)) : this.skills;
    },

    /** Every file of the open skill, its prose first. */
    files() {
      if (!this.skill) {
        return [];
      }

      return [
        {
          path: PROSE, content: this.skill.content, baked: this.skill.baked, overridden: this.skill.overridden,
        },
        ...(this.skill.files || []),
      ];
    },

    /** The file being edited. */
    file() {
      return this.files.find((f) => f.path === this.path) || this.files[0] || null;
    },

    dirty() {
      return !!this.file && this.draft !== this.file.content;
    },

    /** How many are edited here, counting a skill once however many of its files differ. */
    edited() {
      return this.skills.filter((s) => s.overridden).length;
    },
  },

  watch: {
    '$route.query.skill': {
      immediate: true,
      handler(name) {
        if (name && name !== this.selected) {
          this.open(name);
        }
      },
    },
  },

  methods: {
    async load() {
      try {
        const { skills, version } = await listSkills();

        this.skills = skills;
        this.version = version;
      } catch (e) {
        this.error = e?.message || String(e);
      }
      if (!this.selected && this.skills.length && !this.$route.query.skill) {
        this.open(this.skills[0].name);
      }
    },

    async open(name) {
      if (this.dirty && !window.confirm('Drop the unsaved change to this file?')) {
        return;
      }
      this.selected = name;
      this.loadingSkill = true;
      this.error = '';
      this.notice = '';
      try {
        this.skill = await readSkill(name);
        this.show(PROSE, true);
        if (this.$route.query.skill !== name) {
          this.$router.replace({ query: { ...this.$route.query, skill: name } }).catch(() => {});
        }
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.loadingSkill = false;
      }
    },

    /**
     * Open one file of the skill. The draft follows it; an unsaved one is asked about first.
     *
     * `force` is for arriving at a skill rather than moving within one: the question was asked
     * when the skill was opened, and asking it again - against a draft that belongs to a file
     * of the skill being left - is asking about something that is no longer on screen.
     */
    show(path, force = false) {
      if (!force && path !== this.path && this.dirty && !window.confirm('Drop the unsaved change to this file?')) {
        return;
      }
      this.path = path;
      const file = this.files.find((f) => f.path === path) || this.files[0];

      this.draft = file?.content || '';
      this.commitMessage = `Skill ${ this.selected }: `;
    },

    /** What a row's card says: the whole description, and what the skill carries. */
    showSkill(skill, event) {
      const lines = [skill.description].filter(Boolean);

      if (skill.files) {
        lines.push(`${ skill.files } file${ skill.files === 1 ? '' : 's' } beside SKILL.md`);
      }
      if (skill.overridden) {
        lines.push('Edited here; differs from what shipped.');
      }
      this.openCard(skill, event, { title: skill.name, lines, links: [] });
    },

    async run(what, action) {
      if (this.busy) {
        return;
      }
      this.busy = what;
      this.error = '';
      this.notice = '';
      try {
        await action();
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.busy = '';
      }
    },

    /** Save the open file for every workspace; the commit to the repository when asked. */
    save(commit) {
      return this.run(commit ? 'commit' : 'save', async() => {
        const path = this.path;
        const result = await saveSkill(this.selected, this.draft, commit, this.commitMessage.trim(), path);

        this.skill = await readSkill(this.selected);
        this.version = result.version;
        await this.load();
        const spread = await refreshSkillsEverywhere((note) => {
          this.notice = note;
        });
        const committed = result.commit ? (result.commit.committed ? `committed (${ result.commit.url })` : 'already in the repository') : 'not committed';

        this.notice = `Saved ${ path }: ${ spread.done.length } workspace${ spread.done.length === 1 ? '' : 's' } updated${ spread.failed.length ? `, ${ spread.failed.length } could not be (${ spread.failed.map((f) => f.name).join(', ') })` : '' }; ${ committed }.`;
      });
    },

    reset() {
      if (!window.confirm(`Drop the edit and go back to the shipped ${ this.path }?`)) {
        return;
      }

      return this.run('reset', async() => {
        const path = this.path;

        await resetSkill(this.selected, path);
        this.skill = await readSkill(this.selected);
        this.show(path, true);
        await this.load();
        const spread = await refreshSkillsEverywhere((note) => {
          this.notice = note;
        });

        this.notice = `${ path } is back to what shipped, in ${ spread.done.length } workspaces.`;
      });
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="dev-skills"
  >
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="notice"
      color="info"
      :label="notice"
    />
    <div class="dev-skills__columns">
      <aside class="dev-skills__side">
        <NavHead
          label="Skills"
          icon="icon-file"
        />
        <!--
          The filter sits above the scrolling list rather than inside it: it is how you find a
          skill in a list of sixty, and it used to scroll away the moment you started looking.
        -->
        <div class="dev-skills__side-head">
          <input
            v-model="filter"
            type="text"
            class="dev-skills__filter"
            placeholder="Filter skills"
          >
          <p class="dev-skills__count">
            {{ shown.length }} of {{ skills.length }}<template v-if="edited"> &middot; {{ edited }} edited here</template>
          </p>
        </div>

        <div class="dev-skills__list">
          <NavRow
            v-for="s in shown"
            :key="s.name"
            tag="button"
            tall
            :current="s.name === selected"
            class="dev-skills__item"
            :class="{ 'dev-skills__item--current': s.name === selected }"
            @click="open(s.name)"
            @mouseenter="showSkill(s, $event)"
            @mouseleave="hideCard"
          >
            <template #glyph>
              <i
                class="dev-skills__dot"
                :class="{ 'dev-skills__dot--edited': s.overridden }"
              />
            </template>
            <template #name>
              {{ s.name }}
            </template>
            <template #detail>
              <span class="dev-skills__item-desc">{{ s.description }}</span>
              <span
                v-if="s.files"
                class="dev-skills__files"
                :title="`${ s.files } file${ s.files === 1 ? '' : 's' } beside SKILL.md`"
              >+{{ s.files }}</span>
            </template>
          </NavRow>
          <p
            v-if="!shown.length"
            class="dev-skills__count"
          >
            Nothing matches that.
          </p>
        </div>
      </aside>

      <section
        v-if="skill"
        class="dev-skills__editor"
      >
        <div class="dev-skills__head">
          <div class="dev-skills__head-text">
            <h1 class="dev-skills__title">
              {{ skill.name }}
            </h1>
            <p class="dev-skills__sub">
              {{ file && file.overridden ? 'Edited here - every workspace has this version.' : 'As shipped.' }}
              <span
                v-if="dirty"
                class="dev-skills__dirty"
              >Unsaved changes</span>
            </p>
          </div>
          <div class="dev-skills__actions">
            <RcButton
              v-if="file && file.overridden"
              variant="tertiary"
              :disabled="!!busy"
              @click="reset"
            >
              Back to shipped
            </RcButton>
            <RcButton
              variant="secondary"
              :disabled="!!busy || !dirty"
              @click="save(false)"
            >
              <i
                v-if="busy === 'save'"
                class="icon icon-spinner icon-spin"
              />
              Save to all workspaces
            </RcButton>
            <RcButton
              variant="primary"
              :disabled="!!busy || (!dirty && !(file && file.overridden))"
              @click="save(true)"
            >
              <i
                v-if="busy === 'commit'"
                class="icon icon-spinner icon-spin"
              />
              Save and commit
            </RcButton>
          </div>
        </div>

        <!--
          The skill's directory. One file always - its prose - and for the skills that carry a
          script or a manifest, that too: the SKILL.md tells the agent to run it, so it is part
          of the skill and belongs where the skill is edited.
        -->
        <div
          v-if="files.length > 1"
          class="dev-skills__files-row"
        >
          <button
            v-for="f in files"
            :key="f.path"
            type="button"
            class="dev-skills__file"
            :class="{ 'dev-skills__file--current': f.path === path, 'dev-skills__file--edited': f.overridden }"
            :title="f.overridden ? `${ f.path } - edited here` : f.path"
            @click="show(f.path)"
          >{{ f.path }}</button>
        </div>

        <!-- Labelled, because an unlabelled box above a file is read as part of the file. -->
        <label class="dev-skills__field">
          <span class="dev-skills__field-label">Commit message</span>
          <input
            v-model="commitMessage"
            type="text"
            class="dev-skills__filter"
          >
        </label>

        <textarea
          v-model="draft"
          class="dev-skills__text"
          spellcheck="false"
        />
      </section>
      <section
        v-else
        class="dev-skills__editor dev-skills__empty"
      >
        {{ loadingSkill ? 'Reading…' : 'Pick a skill.' }}
      </section>
    </div>

    <HoverCard
      v-if="card"
      :card="card"
      @keep="keepCard"
      @hide="hideCard"
    />
  </div>
</template>

<style lang="scss" scoped>
.dev-skills {
  display:        flex;
  flex-direction: column;
  height:         100%;
  min-height:     0;
  padding:        var(--dev-inset);
  gap:            var(--dev-space-3);

  &__columns {
    display:               grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap:                   var(--dev-space-5);
    flex:                  1 1 auto;
    min-height:            0;
  }

  // ── The list ──────────────────────────────────────────────────────────────────────────────
  //
  // The rows are the navigation's rows (NavRow) and the card is the navigation's card
  // (HoverCard): same height, same rail, same dot slot, same delay. `min-width: 0` all the way
  // down is what keeps the column 280px wide - a grid item's automatic minimum is its content,
  // and the content here is sixty one-line descriptions.
  &__side {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-2);
    min-width:      0;
    min-height:     0;
  }

  &__side-head {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-1);
    min-width:      0;
    padding:        0 var(--dev-space-3) 0 var(--dev-inset);
  }

  &__list {
    display:        flex;
    flex-direction: column;
    min-width:      0;
    min-height:     0;
    overflow-x:     hidden;
    overflow-y:     auto;
  }

  &__count {
    margin:    0;
    color:     var(--muted);
    font-size: 11px;
  }

  &__filter {
    box-sizing:    border-box;
    width:         100%;
    height:        32px;
    padding:       0 var(--dev-space-3);
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--input-bg);
    color:         var(--body-text);
    font:          inherit;
  }

  &__item {
    cursor: pointer;

    &:hover { background: var(--nav-hover, var(--accent-btn)); }
    &--current { background: var(--nav-hover, var(--accent-btn)); }
  }

  // A skill's dot says one thing - whether it still matches what shipped - so it is drawn
  // rather than coloured by a state it does not have.
  &__dot {
    display:       inline-block;
    width:         7px;
    height:        7px;
    border-radius: 50%;
    background:    var(--border);

    &--edited { background: var(--warning); }
  }

  &__item-desc {
    min-width:     0;
    overflow:      hidden;
    white-space:   nowrap;
    text-overflow: ellipsis;
  }

  // How many files the skill carries beside its prose, which is what makes it more than a
  // document: it tells the agent to run them.
  &__files {
    flex:          0 0 auto;
    padding:       0 5px;
    border-radius: 7px;
    background:    var(--box-bg);
    color:         var(--muted);
    font-size:     10px;
    font-weight:   600;
  }

  // ── The editor ────────────────────────────────────────────────────────────────────────────
  &__editor {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-3);
    min-width:      0;
    min-height:     0;
  }

  // Nothing picked, or still reading: centred in the space the file would have filled, rather
  // than one line of grey text in the top-left corner of an empty panel.
  &__empty {
    display:         flex;
    align-items:     center;
    justify-content: center;
    border:          1px dashed var(--border);
    border-radius:   var(--border-radius);
    color:           var(--muted);
  }

  &__head {
    display:         flex;
    align-items:     flex-start;
    justify-content: space-between;
    gap:             var(--dev-space-4);
  }

  &__head-text { min-width: 0; }

  &__title {
    margin:        0;
    font-size:     20px;
    line-height:   1.2;
    overflow:      hidden;
    white-space:   nowrap;
    text-overflow: ellipsis;
  }

  &__sub {
    display:     flex;
    align-items: center;
    gap:         var(--dev-space-2);
    margin:      var(--dev-space-1) 0 0 0;
    color:       var(--muted);
    font-size:   12px;
  }

  &__dirty {
    padding:       0 6px;
    border-radius: 8px;
    background:    rgba(255, 228, 122, .18);
    color:         var(--warning);
    font-size:     10px;
    font-weight:   700;
  }

  &__actions {
    display: flex;
    gap:     var(--dev-space-2);
    flex:    0 0 auto;
  }

  // The skill's files, as a strip of tabs over the box they open into.
  &__files-row {
    display:   flex;
    flex-wrap: wrap;
    gap:       var(--dev-space-2);
  }

  &__file {
    min-height:    0;
    padding:       3px var(--dev-space-3);
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    transparent;
    color:         var(--muted);
    font-family:   ui-monospace, 'SFMono-Regular', Menlo, monospace;
    font-size:     11px;
    cursor:        pointer;

    &:hover { color: var(--body-text); }

    &--current {
      border-color: var(--dev-accent);
      color:        var(--body-text);
    }

    // Edited here, the same amber the list's dot uses for the same fact.
    &--edited { color: var(--warning); }
  }

  &__field {
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-1);
    min-width:      0;
  }

  &__field-label {
    color:          var(--muted);
    font-size:      11px;
    font-weight:    600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  // The file. It takes what is left of the column rather than a minimum of 420px: with a
  // minimum it pushed itself past the bottom of a short window, and the page scrolled.
  &__text {
    flex:          1 1 auto;
    width:         100%;
    min-height:    0;
    box-sizing:    border-box;
    padding:       var(--dev-space-3) var(--dev-space-4);
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--input-bg);
    color:         var(--body-text);
    font-family:   ui-monospace, 'SFMono-Regular', Menlo, monospace;
    font-size:     12.5px;
    line-height:   1.5;
    resize:        none;
  }
}
</style>
