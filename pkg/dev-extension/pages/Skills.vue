<script>
// The skills the agents run on: read here and edited here. A save reaches every running
// workspace at once and, when asked, the repository the skills are kept in. See skills.ts.
//
// There is no agent on this page. Asking an agent to improve a skill used to be a panel at the
// bottom of the editor with a conversation picker of its own, which is a second way to start a
// conversation on a page whose subject is a file - and the product already has one that is
// always to hand. So: this page is the file, and the conversation is the global one.
import Loading from '@shell/components/Loading';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import {
  listSkills, readSkill, saveSkill, resetSkill, refreshSkillsEverywhere
} from '../skills';

export default {
  name: 'DevSkills',

  components: { Loading, Banner, RcButton },

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

    dirty() {
      return !!this.skill && this.draft !== this.skill.content;
    },

    /** How many are edited here, which is the one thing worth counting in the list's header. */
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
      if (this.dirty && !window.confirm('Drop the unsaved change to this skill?')) {
        return;
      }
      this.selected = name;
      this.loadingSkill = true;
      this.error = '';
      this.notice = '';
      try {
        this.skill = await readSkill(name);
        this.draft = this.skill.content;
        this.commitMessage = `Skill ${ name }: `;
        if (this.$route.query.skill !== name) {
          this.$router.replace({ query: { ...this.$route.query, skill: name } }).catch(() => {});
        }
      } catch (e) {
        this.error = e?.message || String(e);
      } finally {
        this.loadingSkill = false;
      }
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

    /** Save for every workspace; the commit to the repository when asked. */
    save(commit) {
      return this.run(commit ? 'commit' : 'save', async() => {
        const result = await saveSkill(this.selected, this.draft, commit, this.commitMessage.trim());

        this.skill = { ...this.skill, content: this.draft, overridden: result.overridden };
        this.version = result.version;
        await this.load();
        const spread = await refreshSkillsEverywhere((note) => {
          this.notice = note;
        });
        const committed = result.commit ? (result.commit.committed ? `committed (${ result.commit.url })` : 'already in the repository') : 'not committed';

        this.notice = `Saved: ${ spread.done.length } workspace${ spread.done.length === 1 ? '' : 's' } updated${ spread.failed.length ? `, ${ spread.failed.length } could not be (${ spread.failed.map((f) => f.name).join(', ') })` : '' }; ${ committed }.`;
      });
    },

    reset() {
      if (!window.confirm(`Drop the edit and go back to the shipped ${ this.selected }?`)) {
        return;
      }

      return this.run('reset', async() => {
        await resetSkill(this.selected);
        await this.open(this.selected);
        await this.load();
        const spread = await refreshSkillsEverywhere((note) => {
          this.notice = note;
        });

        this.notice = `Back to the shipped skill in ${ spread.done.length } workspaces.`;
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
          <button
            v-for="s in shown"
            :key="s.name"
            type="button"
            class="dev-skills__item"
            :class="{ 'dev-skills__item--current': s.name === selected }"
            :title="`${ s.name } - ${ s.description }`"
            @click="open(s.name)"
          >
            <span class="dev-skills__item-name">
              <span class="dev-skills__item-text">{{ s.name }}</span>
              <span
                v-if="s.overridden"
                class="dev-skills__edited"
                title="Edited here; differs from what shipped"
              >edited</span>
            </span>
            <!--
              One line, clipped with an ellipsis. Every one of these descriptions is a sentence
              or two, and a 300px column cannot shrink below its content unless it is told it
              can: `min-width: 0` on the button and on this span is what makes the ellipsis
              happen instead of the whole column growing to the width of the longest one.
            -->
            <span class="dev-skills__item-desc">{{ s.description }}</span>
          </button>
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
              {{ skill.overridden ? 'Edited here - every workspace has this version.' : 'As shipped.' }}
              <span
                v-if="dirty"
                class="dev-skills__dirty"
              >Unsaved changes</span>
            </p>
          </div>
          <div class="dev-skills__actions">
            <RcButton
              v-if="skill.overridden"
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
              :disabled="!!busy || (!dirty && !skill.overridden)"
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
  // Two parts: a head that stays, and a list that scrolls. `min-width: 0` all the way down is
  // what keeps the column 280px wide - a grid item's automatic minimum is its content, and the
  // content here is sixty one-line descriptions, the longest of which was setting the width of
  // the column and pushing the names out of sight.
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
  }

  &__list {
    display:        flex;
    flex-direction: column;
    gap:            1px;
    min-width:      0;
    min-height:     0;
    overflow-x:     hidden;
    overflow-y:     auto;
    padding-right:  var(--dev-space-1);
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
    display:        flex;
    flex-direction: column;
    gap:            1px;
    align-items:    stretch;
    width:          100%;
    min-width:      0;
    overflow:       hidden;
    padding:        var(--dev-space-2) var(--dev-space-3);
    border:         0;
    border-left:    2px solid transparent;
    border-radius:  var(--border-radius);
    background:     transparent;
    color:          var(--body-text);
    font:           inherit;
    text-align:     left;
    cursor:         pointer;

    &:hover { background: var(--box-bg); }

    // The mark for the current one is a left edge rather than an inset shadow, so it cannot
    // sit over the first character of the name.
    &--current {
      background:  var(--box-bg);
      border-left: 2px solid var(--primary);
    }
  }

  &__item-name {
    display:     flex;
    align-items: center;
    gap:         var(--dev-space-2);
    min-width:   0;
    font-weight: 600;
  }

  // The name is the part that must stay readable, so it is what gets the ellipsis.
  &__item-text,
  &__item-desc {
    min-width:     0;
    overflow:      hidden;
    white-space:   nowrap;
    text-overflow: ellipsis;
  }

  &__item-desc {
    color:     var(--muted);
    font-size: 11px;
  }

  &__edited {
    flex:          0 0 auto;
    padding:       0 6px;
    border-radius: 8px;
    background:    rgba(255, 228, 122, .18);
    color:         var(--warning);
    font-size:     10px;
    font-weight:   700;
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
    margin:      0;
    font-size:   20px;
    line-height: 1.2;
    overflow:    hidden;
    white-space: nowrap;
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
