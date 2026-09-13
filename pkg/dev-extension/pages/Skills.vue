<script>
// The skills the agents run on: read here, edited here, or improved by an agent from a
// conversation that showed where a skill fell short. A save reaches every running workspace
// at once and, when asked, the repository the skills are kept in. See skills.ts.
import Loading from '@shell/components/Loading';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import {
  listSkills, readSkill, saveSkill, resetSkill, refreshSkillsEverywhere, allConversations, improveSkillWith
} from '../skills';
import { DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE } from '../config/constants';

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
      conversations: [],
      fromId:        '',
      notes:         '',
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

    from() {
      return this.conversations.find((c) => `${ c.workspace }/${ c.id }` === this.fromId) || null;
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
      allConversations().then((list) => {
        this.conversations = list;
      }).catch(() => {});
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

    improve() {
      if (!this.from) {
        this.error = 'Pick the conversation the skill should learn from.';

        return;
      }

      return this.run('improve', async() => {
        const conversation = await improveSkillWith(this.selected, this.from, this.notes.trim());

        this.notice = `The agent is improving ${ this.selected } in ${ this.from.workspace }; it saves and commits when done.`;
        this.$router.push({
          name: WORKSPACE_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: this.from.workspace }, query: { c: conversation.id },
        });
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
      <aside class="dev-skills__list">
        <input
          v-model="filter"
          type="text"
          class="dev-skills__filter"
          placeholder="Filter skills"
        >
        <button
          v-for="s in shown"
          :key="s.name"
          type="button"
          class="dev-skills__item"
          :class="{ 'dev-skills__item--current': s.name === selected }"
          :title="s.description"
          @click="open(s.name)"
        >
          <span class="dev-skills__item-name">{{ s.name }}<span
            v-if="s.overridden"
            class="dev-skills__edited"
            title="Edited here; differs from what shipped"
          >edited</span></span>
          <span class="dev-skills__item-desc">{{ s.description }}</span>
        </button>
      </aside>

      <section
        v-if="skill"
        class="dev-skills__editor"
      >
        <div class="dev-skills__head">
          <div>
            <h1 class="dev-skills__title">{{ skill.name }}</h1>
            <div class="dev-skills__sub">{{ skill.overridden ? 'Edited here - every workspace has this version.' : 'As shipped.' }} <span v-if="dirty">Unsaved changes.</span></div>
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
              Save and commit to the repo
            </RcButton>
          </div>
        </div>
        <input
          v-model="commitMessage"
          type="text"
          class="dev-skills__filter"
          placeholder="Commit message"
        >
        <textarea
          v-model="draft"
          class="dev-skills__text"
          spellcheck="false"
        />

        <div class="dev-skills__improve">
          <h2 class="dev-skills__h2">Improve it with an agent</h2>
          <p class="dev-skills__sub">Pick a conversation that showed where this skill fell short. An agent reads that transcript, rewrites the skill, saves it for every workspace and commits it. It runs as a conversation in that workspace, so it can be watched and talked to.</p>
          <div class="dev-skills__improve-row">
            <select
              v-model="fromId"
              class="dev-skills__select"
            >
              <option value="">Conversation…</option>
              <option
                v-for="c in conversations"
                :key="`${ c.workspace }/${ c.id }`"
                :value="`${ c.workspace }/${ c.id }`"
              >{{ c.workspace }} · {{ c.title }}</option>
            </select>
            <input
              v-model="notes"
              type="text"
              class="dev-skills__filter"
              placeholder="What to look at (optional)"
            >
            <RcButton
              variant="secondary"
              :disabled="!!busy || !fromId"
              @click="improve"
            >
              <i
                v-if="busy === 'improve'"
                class="icon icon-spinner icon-spin"
              />
              Improve from this conversation
            </RcButton>
          </div>
        </div>
      </section>
      <section
        v-else
        class="dev-skills__editor dev-skills__sub"
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
  padding:        16px 24px;
  gap:            12px;

  &__columns {
    display:               grid;
    grid-template-columns: 300px minmax(0, 1fr);
    gap:                   16px;
    flex:                  1 1 auto;
    min-height:            0;
  }

  &__list {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    overflow:       auto;
    min-height:     0;
    padding-right:  4px;
  }

  &__filter, &__select {
    box-sizing:    border-box;
    width:         100%;
    height:        32px;
    padding:       0 10px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--input-bg);
    color:         var(--body-text);
    font:          inherit;
    margin-bottom: 6px;
  }

  &__item {
    display:        flex;
    flex-direction: column;
    gap:            2px;
    text-align:     left;
    padding:        6px 10px;
    border:         0;
    border-radius:  var(--border-radius);
    background:     transparent;
    color:          var(--body-text);
    font:           inherit;
    cursor:         pointer;

    &:hover { background: var(--box-bg); }
    &--current { background: var(--box-bg); box-shadow: inset 2px 0 0 var(--primary); }
  }

  &__item-name { font-weight: 700; display: flex; gap: 8px; align-items: center; }
  &__item-desc { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  &__edited {
    font-size:     10px;
    font-weight:   700;
    padding:       0 6px;
    border-radius: 8px;
    background:    rgba(255, 228, 122, .18);
    color:         var(--warning);
  }

  &__editor {
    display:        flex;
    flex-direction: column;
    gap:            10px;
    min-height:     0;
    min-width:      0;
  }

  &__head {
    display:         flex;
    align-items:     flex-start;
    justify-content: space-between;
    gap:             16px;
  }

  &__title { margin: 0; font-size: 20px; }
  &__sub { color: var(--muted); font-size: 13px; margin: 0; }
  &__actions { display: flex; gap: 8px; flex: 0 0 auto; }

  &__text {
    flex:          1 1 auto;
    min-height:    420px;
    width:         100%;
    box-sizing:    border-box;
    padding:       10px 12px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--input-bg);
    color:         var(--body-text);
    font-family:   ui-monospace, 'SFMono-Regular', Menlo, monospace;
    font-size:     12.5px;
    line-height:   1.5;
    resize:        vertical;
  }

  &__improve {
    display:        flex;
    flex-direction: column;
    gap:            8px;
    padding:        12px 14px;
    border:         1px solid var(--border);
    border-radius:  var(--border-radius);
    background:     var(--box-bg);
  }

  &__h2 { margin: 0; font-size: 14px; }

  &__improve-row {
    display:               grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 2fr) auto;
    gap:                   8px;
    align-items:           start;
  }
}
</style>
