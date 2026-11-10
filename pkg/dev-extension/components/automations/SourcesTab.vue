<script>
/**
 * Where events come from, and how each source is doing.
 *
 * All of it is dev-api's: GitHub is read there every three minutes (it has no push channel short of
 * a webhook on every repository), the stage store and the resources automations name are watched
 * there, and the statuses are what it last said - so this page reads the same answer the Events tab
 * does and draws the half about the sources. Muting is here too: it is a setting on where events
 * come from, not a filter on a list.
 */
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { watch } from '../../events';
import {
  EVENTS_PATH, pollNow, setMutes, near, stamp
} from '../../automations';

const SET_WORDS = [
  ['assigned', 'assigned to you', 'issues and pull requests'],
  ['requested', 'asking for your review', 'directly, as My Work counts it'],
  ['reviewed', 'reviewed by you and still open', 'so a push or a reply after your review is seen'],
  ['authored', 'yours and open', 'your own pull requests'],
  ['workspaces', 'only a workspace is about', 'watched for that workspace\'s stage'],
];

export default {
  name: 'SourcesTab',

  components: { Banner, RcButton },

  data() {
    return {
      data:      null,
      now:       Date.now(),
      reading:   false,
      error:     '',
      muteDraft: '',
      unwatch:   null,
      clock:     null,
    };
  },

  computed: {
    github() {
      return this.data?.sources?.github || {};
    },

    stages() {
      return this.data?.sources?.workspace || {};
    },

    kubernetes() {
      return this.data?.sources?.kubernetes || { watches: [], unresolved: [] };
    },

    mutes() {
      return this.data?.mutes || [];
    },

    /** The four sets and how many items each holds, in words. */
    sets() {
      const counts = this.github.counts || {};

      return SET_WORDS
        .filter(([key]) => typeof counts[key] === 'number' && (key !== 'workspaces' || counts[key] > 0))
        .map(([key, what, why]) => ({
          key, n: counts[key], what, why
        }));
    },

    /** Workspaces the log has seen, for the mute picker, the noisiest first. */
    knownWorkspaces() {
      const counts = new Map();

      for (const e of this.data?.events || []) {
        if (e.workspace && !this.mutes.includes(e.workspace)) {
          counts.set(e.workspace, (counts.get(e.workspace) || 0) + 1);
        }
      }

      return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
    },
  },

  mounted() {
    this.unwatch = watch(EVENTS_PATH, (value) => {
      this.data = value;
    }, { every: 5000 });
    this.clock = setInterval(() => {
      this.now = Date.now();
    }, 15000);
  },

  beforeUnmount() {
    this.unwatch?.();
    clearInterval(this.clock);
  },

  methods: {
    near,
    stamp,

    async readNow() {
      this.reading = true;
      this.error = '';
      try {
        await pollNow();
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.reading = false;
      }
    },

    async changeMutes(next) {
      this.error = '';
      try {
        const saved = await setMutes(next);

        if (this.data) {
          this.data = { ...this.data, mutes: saved };
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    mute(name) {
      if (name && !this.mutes.includes(name)) {
        this.changeMutes([...this.mutes, name]);
      }
      this.muteDraft = '';
    },

    unmute(name) {
      this.changeMutes(this.mutes.filter((m) => m !== name));
    },
  },
};
</script>

<template>
  <div
    class="sources"
    data-testid="automation-sources"
  >
    <Banner
      v-if="error"
      color="error"
      :label="error"
      :closable="true"
      @close="error = ''"
    />

    <section
      class="source"
      :class="{ 'source--bad': github.ok === false }"
      data-testid="source-github"
    >
      <header class="source__head">
        <span class="source__dot" />
        <h3>GitHub</h3>
        <span
          v-if="github.login"
          class="source__who"
        >@{{ github.login }}</span>
        <RcButton
          variant="tertiary"
          size="small"
          class="source__action"
          :left-icon="reading ? 'spinner' : 'refresh'"
          :disabled="reading"
          data-testid="automation-poll"
          @click="readNow"
        >
          {{ reading ? 'Reading' : 'Read now' }}
        </RcButton>
      </header>
      <p class="source__what">
        The open issues and pull requests you are part of, read every three minutes: GitHub has no push channel for them short of a webhook on every repository. A cheap search says what moved, and only that is read in full - which is also what tells the workspaces their pull request moved.
      </p>
      <Banner
        v-if="github.ok === false"
        color="warning"
        :label="github.error"
      />
      <ul
        v-if="sets.length"
        class="source__sets"
      >
        <li
          v-for="set in sets"
          :key="set.key"
        >
          <strong>{{ set.n }}</strong> {{ set.what }} <span class="text-muted">- {{ set.why }}</span>
        </li>
      </ul>
      <dl class="source__facts">
        <div>
          <dt>Last read</dt>
          <dd>{{ github.at ? `${ stamp(github.at) } (${ near(github.at, now) })` : 'not yet' }}</dd>
        </div>
        <div>
          <dt>Next</dt>
          <dd>{{ github.next ? near(github.next, now) : '-' }}</dd>
        </div>
        <div v-if="typeof github.read === 'number'">
          <dt>That read</dt>
          <dd>{{ github.read }} read in full{{ github.full ? ' (the regular full pass)' : '' }}, {{ github.found || 0 }} event{{ github.found === 1 ? '' : 's' }}</dd>
        </div>
        <div v-if="github.rate">
          <dt>Rate limit</dt>
          <dd>{{ github.rate.remaining }} left, resets {{ near(github.rate.resetAt, now) }}</dd>
        </div>
      </dl>
    </section>

    <section
      class="source"
      :class="{ 'source--live': stages.live, 'source--bad': !stages.live && stages.error }"
      data-testid="source-stages"
    >
      <header class="source__head">
        <span class="source__dot" />
        <h3>Workspace stages</h3>
        <span class="source__who">{{ stages.live ? 'live' : 'read every minute' }}</span>
      </header>
      <p class="source__what">
        The in-cluster API works out every workspace's stage itself - from the pull request, which it reads again when GitHub says it moved, and the agent's state - and stores it. The store is watched, so a stage moving is an event the moment it is stored, whether or not a dashboard is open.
      </p>
      <dl class="source__facts">
        <div v-if="stages.since">
          <dt>Watching since</dt>
          <dd>{{ stamp(stages.since) }}</dd>
        </div>
        <div v-if="stages.at">
          <dt>Last read</dt>
          <dd>{{ near(stages.at, now) }}</dd>
        </div>
        <div v-if="!stages.live && stages.error">
          <dt>Watch</dt>
          <dd>{{ stages.error }}</dd>
        </div>
      </dl>
    </section>

    <section
      class="source"
      :class="{ 'source--live': kubernetes.watches.length && kubernetes.watches.every((w) => w.live), 'source--bad': (kubernetes.unresolved || []).length }"
      data-testid="source-kubernetes"
    >
      <header class="source__head">
        <span class="source__dot" />
        <h3>Kubernetes</h3>
        <span class="source__who">{{ kubernetes.watches.length ? `${ kubernetes.watches.length } watched` : 'nothing watched' }}</span>
      </header>
      <p class="source__what">
        The resources an automation's "When a resource changes" trigger names, listed and then watched live by the in-cluster API. A change that fires an automation is an event in the log.
      </p>
      <ul
        v-if="kubernetes.watches.length || (kubernetes.unresolved || []).length"
        class="source__watches"
      >
        <li
          v-for="w in kubernetes.watches"
          :key="w.path"
        >
          <code>{{ w.path }}</code>
          <span :class="w.live ? 'source__ok' : 'source__err'">{{ w.live ? 'live' : (w.error || 'connecting') }}</span>
          <span class="text-muted">for {{ w.automations.join(', ') }}</span>
        </li>
        <li
          v-for="u in kubernetes.unresolved || []"
          :key="`${ u.automation }-${ u.type }`"
        >
          <code>{{ u.type }}</code>
          <span class="source__err">{{ u.error }}</span>
          <span class="text-muted">for {{ u.automation }}</span>
        </li>
      </ul>
    </section>

    <section
      class="source source--plain"
      data-testid="source-mutes"
    >
      <header class="source__head">
        <h3>Muted workspaces</h3>
      </header>
      <p class="source__what">
        A muted workspace's events are still recorded, but they are hidden on the Events tab unless you ask for them, and they start no automation.
      </p>
      <div class="source__mutes">
        <span
          v-if="!mutes.length"
          class="text-muted"
        >None muted.</span>
        <span
          v-for="m in mutes"
          :key="m"
          class="source__muted"
        >
          {{ m }}
          <a
            href="#"
            class="source__unmute"
            :aria-label="`Unmute ${ m }`"
            title="Unmute"
            @click.prevent="unmute(m)"
          >&times;</a>
        </span>
        <select
          v-if="knownWorkspaces.length"
          v-model="muteDraft"
          class="source__select"
          aria-label="Mute a workspace"
          data-testid="automation-mute-pick"
          @change="mute(muteDraft)"
        >
          <option value="">
            Mute a workspace&hellip;
          </option>
          <option
            v-for="w in knownWorkspaces"
            :key="w.name"
            :value="w.name"
          >
            {{ w.name }} ({{ w.n }} event{{ w.n === 1 ? '' : 's' }})
          </option>
        </select>
      </div>
    </section>
  </div>
</template>

<style lang="scss" scoped>
.sources {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-3);
}

/* The Tools page's panel: a bordered block with its name on the first line and its facts below. */
.source {
  display:        flex;
  flex-direction: column;
  gap:            var(--dev-space-3);
  padding:        var(--dev-space-4);
  border:         1px solid var(--border);
  border-radius:  var(--r-sm, 4px);

  &__head {
    display:     flex;
    align-items: center;
    gap:         var(--dev-space-2);
    flex-wrap:   wrap;

    h3 { margin: 0; font-size: 15px; font-weight: 600; }
  }

  &__dot {
    flex:          0 0 auto;
    width:         8px;
    height:        8px;
    border-radius: 50%;
    background:    var(--success);
  }

  &--live &__dot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 25%, transparent); }
  &--bad &__dot { background: var(--error); }

  &__who { color: var(--muted); font-size: 13px; }
  &__action { margin-left: auto; }

  &__what { margin: 0; color: var(--muted); font-size: 13px; max-width: 900px; }

  &__sets, &__watches {
    list-style:     none;
    margin:         0;
    padding:        0;
    display:        flex;
    flex-direction: column;
    gap:            var(--dev-space-1);
    font-size:      13px;

    code { border: 0; padding: 0; overflow-wrap: anywhere; }
  }

  &__watches li { display: flex; flex-wrap: wrap; gap: 0 var(--dev-space-3); }

  &__ok { color: var(--success); }
  &__err { color: var(--error); }

  &__facts {
    display:               grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap:                   var(--dev-space-2) var(--dev-space-4);
    margin:                0;
    font-size:             13px;

    dt { color: var(--muted); font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; }
    dd { margin: 2px 0 0; overflow-wrap: anywhere; }
  }

  &__mutes { display: flex; flex-wrap: wrap; align-items: center; gap: var(--dev-space-2); font-size: 13px; }

  &__muted {
    display:       inline-flex;
    align-items:   center;
    gap:           var(--dev-space-1);
    padding:       0 var(--dev-space-1) 0 var(--dev-space-2);
    border:        1px solid var(--border);
    border-radius: var(--r-md, 12px);
    font-family:   monospace;
    font-size:     12px;
  }

  &__unmute { padding: 0 4px; color: var(--muted); text-decoration: none; &:hover { color: var(--error); } }

  &__select {
    width:         auto;
    max-width:     100%;
    min-height:    0;
    padding:       4px 8px;
    font-size:     13px;
    color:         var(--input-text);
    background:    var(--input-bg);
    border:        1px solid var(--border);
    border-radius: var(--dev-r-ctl, 4px);
  }
}
</style>
