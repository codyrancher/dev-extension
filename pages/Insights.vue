<script>
// Insights: what this person's agents have recorded, and a box to ask about it.
//
// It is one SQLite database per person rather than one per workspace, because the question it
// answers spans them: what have my agents been running into. It lives in dev-system beside the
// secret store, is created the first time this page is opened, and is written to over HTTP by
// anything in a workspace - `INSIGHTS_URL` is set on every workspace's pod, which is the same
// name the harness's own agents post to.
//
// Schema on write, so there is nothing to declare. An agent that posts a JSON object to
// `/api/insights/missing-tool` creates the table and the columns it implies, which is what lets a
// shell script in a conversation record something nobody planned for. See insights-server.ts.
//
// The query box is SELECT only, and that is enforced in the pod rather than here: a page can be
// edited from the console, and the thing holding the database is the only place a rule about it
// can actually hold.
import SortableTable from '@shell/components/SortableTable';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import {
  ensureInsights, insightsTables, insightsQuery, insightsServiceUrl
} from '../api';

/** How long to wait for a database that has just been created to start answering. */
const READY_TRIES = 20;
const READY_MS = 3000;

export default {
  name: 'DevInsights',

  components: { SortableTable, Banner, RcButton },

  async fetch() {
    await this.start();
  },

  data() {
    return {
      tables:  [],
      table:   '',
      sql:     '',
      columns: [],
      rows:    [],
      error:   '',
      /** Where a workspace posts to, which is the one thing this page tells rather than asks. */
      address: '',
      /** True while the database is being created, which is a pull and a start. */
      starting: false,
      running:  false,
    };
  },

  computed: {
    /**
     * The table's columns, as SortableTable wants them.
     *
     * Built from the result rather than declared, because the whole point of the page is that the
     * shape is whatever was asked for. Everything is a string by the time it is here (see the
     * server: only the id is not TEXT), so there is nothing to format.
     */
    headers() {
      return this.columns.map((name) => ({
        name, label: name, value: name, sort: [name],
      }));
    },
  },

  beforeUnmount() {
    this.stopped = true;
  },

  methods: {
    /**
     * Make sure there is a database, then read what is in it.
     *
     * The first visit creates a Deployment and waits for an image pull, so this polls rather than
     * asking once and reporting that nothing is answering. Later visits find it running and the
     * first ask succeeds.
     */
    async start() {
      this.error = '';
      this.address = await insightsServiceUrl().catch(() => '');

      await ensureInsights().catch(() => {});

      for (let attempt = 0; attempt < READY_TRIES && !this.stopped; attempt++) {
        try {
          this.tables = await insightsTables();
          this.running = true;
          this.starting = false;

          if (this.tables.length) {
            await this.open(this.tables[0].name);
          }

          return;
        } catch (e) {
          this.starting = true;
          this.error = e.message || String(e);
          await new Promise((resolve) => setTimeout(resolve, READY_MS));
        }
      }

      this.starting = false;
    },

    /** A tab: the table's own rows, most recent first, which is the order they are written in. */
    open(name) {
      this.table = name;
      this.sql = `SELECT * FROM ${ name } ORDER BY id DESC LIMIT 200`;

      return this.run();
    },

    async run() {
      this.error = '';

      try {
        const result = await insightsQuery(this.sql);

        this.columns = result.columns;
        this.rows = (result.rows || []).map((row, i) => ({ ...row, _key: row.id ?? i }));

        // The counts move as rows are added, and running a query is the moment this page is
        // being looked at, so it is the moment to ask again.
        this.tables = await insightsTables().catch(() => this.tables);
      } catch (e) {
        this.columns = [];
        this.rows = [];
        this.error = e.message || String(e);
      }
    },
  },
};
</script>

<template>
  <div class="dev-insights">
    <header>
      <h1>Insights</h1>
      <p class="subheader">
        What your agents have recorded, across every workspace you have.
      </p>
      <RcButton
        variant="tertiary"
        size="small"
        left-icon="refresh"
        @click="run"
      >
        Run
      </RcButton>
    </header>

    <Banner
      v-if="starting"
      color="info"
      label="Starting the insights database. The first time is an image pull, so it is a minute or two."
    />
    <Banner
      v-else-if="error"
      color="warning"
      :label="error"
    />

    <label class="dev-insights__label">SQL query</label>
    <textarea
      v-model="sql"
      class="dev-insights__sql"
      rows="3"
      spellcheck="false"
      @keydown.ctrl.enter="run"
      @keydown.meta.enter="run"
    />

    <!--
      A tab per table, with its row count, which is the harness's own shape. They come from the
      database rather than from a list here, because nothing declares them: a table exists because
      something posted to it.
    -->
    <div class="dev-insights__tables">
      <button
        v-for="entry in tables"
        :key="entry.name"
        type="button"
        class="dev-insights__table"
        :class="{ 'dev-insights__table--current': entry.name === table }"
        @click="open(entry.name)"
      >
        {{ entry.name }}
        <span class="dev-insights__rows">{{ entry.rows }}</span>
      </button>
      <span
        v-if="running && !tables.length"
        class="dev-insights__empty"
      >
        Nothing has been recorded yet.
      </span>
    </div>

    <SortableTable
      v-if="columns.length"
      :headers="headers"
      :rows="rows"
      key-field="_key"
      :table-actions="false"
      :row-actions="false"
      :search="false"
      :rows-per-page="50"
    />
    <p
      v-else-if="running && !error"
      class="dev-insights__empty"
    >
      That query returned no rows.
    </p>

    <!--
      The address, because the page is only half of this: the other half is an agent posting to
      it, and an agent cannot be told where to post from a page it never sees. It is on every
      workspace's pod as INSIGHTS_URL, so this is the copy for a person writing the command.
    -->
    <p
      v-if="address"
      class="dev-insights__note"
    >
      Anything in a workspace can record something here, and every workspace has this address as
      <b>INSIGHTS_URL</b>:
      <code>curl -s -X POST $INSIGHTS_URL/api/insights/missing-tool -H 'content-type: application/json' -d '{"tool":"jq","project":"expo"}'</code>
      The table and its columns are made by the first row that needs them, so there is nothing to
      declare first. Reading is SELECT only.
    </p>
  </div>
</template>

<style lang="scss" scoped>
  .dev-insights {
    overflow-y: auto;
    padding:    var(--dev-space-5);

    header {
      display:       flex;
      align-items:   center;
      gap:           var(--dev-space-4);
      margin-bottom: var(--dev-space-5);

      h1 {
        margin-bottom: 0;
      }

      .subheader {
        flex:   1 1 auto;
        margin: 0;
        color:  var(--muted);
      }
    }

    &__label {
      display:        block;
      margin-bottom:  var(--dev-space-2);
      color:          var(--muted);
      font-size:      12px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    // Monospace and full width: what goes in here is SQL, and it wraps rather than scrolling
    // sideways because a query is read as a whole.
    &__sql {
      display:       block;
      width:         100%;
      padding:       var(--dev-space-3) var(--dev-space-4);
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
      background:    var(--body-bg);
      color:         var(--body-text);
      font-family:   monospace;
      font-size:     13px;
      resize:        vertical;
    }

    &__tables {
      display:   flex;
      flex-wrap: wrap;
      gap:       var(--dev-space-3);
      margin:    var(--dev-space-4) 0;
    }

    // A tab, not a button: quiet until it is the current one, which is the only state worth
    // drawing attention to.
    &__table {
      display:       flex;
      align-items:   center;
      gap:           var(--dev-space-3);
      min-height:    0;
      padding:       var(--dev-space-2) var(--dev-space-4);
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
      background:    transparent;
      color:         var(--body-text);
      font-family:   monospace;
      font-size:     12px;
      cursor:        pointer;

      &:hover {
        background: var(--nav-hover, var(--accent-btn));
      }

      &--current {
        border-color: var(--primary);
        font-weight:  600;
      }
    }

    &__rows {
      color:     var(--muted);
      font-size: 11px;
    }

    &__empty {
      color:     var(--muted);
      font-size: 12px;
    }

    &__note {
      max-width:  100ch;
      margin-top: var(--dev-space-5);
      color:      var(--muted);
      font-size:  12px;

      code {
        display:     block;
        overflow-x:  auto;
        margin:      var(--dev-space-3) 0;
        padding:     var(--dev-space-3) var(--dev-space-4);
        border:      1px solid var(--border);
        border-radius: var(--border-radius);
        font-size:   11px;
        white-space: pre;
      }
    }
  }
</style>
