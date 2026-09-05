<script>
// The pull request a workspace is for, and the review of it.
//
// What the harness's PR review panel did, in the shape this product has: the PR's facts, the
// review agent's progress, the comments the review produced (or a person typed) held locally
// until each is marked good and the lot is submitted to GitHub as one review, and the buttons
// that end a review - approve, merge - with red CI spelled out beside them.
//
// Comments are local because a review is a draft until somebody says otherwise. The agent files
// them through the in-cluster API; a person edits, marks good ("approved") or deletes them here;
// Submit posts the approved ones as one GitHub review and stamps them submitted. See reviews.ts.
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import AsyncButton from '@shell/components/AsyncButton';
import {
  prDetail, listComments, addComment, updateComment, deleteComment, approvePr, submitReview, mergePr,
  ciFailures, ciFailureDetail, startPrReview, startCiTriage, reviewRun, DEFAULT_REPO
} from '../reviews';
import { linkedPullRequest } from '../github';
import { listApps } from '../apps';
import { previewState, deployPreview, removePreview, rebuildPreview } from '../previews';
import { DEFAULT_APP, DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE } from '../config/constants';

const REFRESH_MS = 8000;

export default {
  name: 'WorkspacePr',

  components: { Banner, RcButton, AsyncButton },

  props: {
    workspace: { type: Object, required: true },
    /** The PR number the workspace's name carries, or 0. */
    pr:        { type: Number, default: 0 },
    /** The issue number it carries instead, or 0. */
    issue:     { type: Number, default: 0 },
  },

  async fetch() {
    await this.load();
  },

  data() {
    return {
      number:     0,
      repo:       DEFAULT_REPO,
      detail:     null,
      comments:   [],
      run:        null,
      failures:   null,
      failureOpen: null,
      failureDetail: null,
      error:      '',
      notice:     '',
      loading:    false,
      draft:      '',
      draftPath:  '',
      draftLine:  '',
      editing:    0,
      editBody:   '',
      timer:      null,
      preview:    null,
      previewRancher: window.location.origin,
    };
  },

  computed: {
    meta() {
      return this.detail?.meta || null;
    },

    unsubmitted() {
      return this.comments.filter((c) => !c.submitted_at);
    },

    submitted() {
      return this.comments.filter((c) => !!c.submitted_at);
    },

    pendingCount() {
      return this.unsubmitted.filter((c) => c.status !== 'approved').length;
    },

    approvedCount() {
      return this.unsubmitted.filter((c) => c.status === 'approved').length;
    },

    canSubmit() {
      return this.unsubmitted.length > 0 && this.pendingCount === 0;
    },

    ci() {
      return this.meta?.ci || null;
    },

    conversationsTo() {
      return {
        name:   WORKSPACE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: this.workspace.name },
        hash:   '#conversations',
      };
    },

    runLabel() {
      if (!this.run) {
        return '';
      }

      return { starting: 'Review queued', running: 'Reviewing', idle: 'Waiting on you', complete: 'Review finished', failed: 'Review failed', cancelled: 'Review cancelled' }[this.run.state] || this.run.state;
    },
  },

  mounted() {
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    async resolveRepo() {
      const apps = await listApps(this.$store).catch(() => []);
      const own = apps.find((app) => app.id === this.workspace.app && app.repo);
      const fallback = apps.find((app) => app.id === DEFAULT_APP && app.repo) || apps.find((app) => !!app.repo);

      this.repo = (own || fallback)?.repo || DEFAULT_REPO;
    },

    async load() {
      this.loading = true;
      this.error = '';

      try {
        await this.resolveRepo();
        this.number = this.pr || (this.issue ? await linkedPullRequest(this.repo, this.issue) : 0);

        if (this.number) {
          await this.refresh();
        }
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    async refresh() {
      if (!this.number) {
        return;
      }

      try {
        const [detail, comments, run] = await Promise.all([
          prDetail(this.number, this.repo),
          listComments(this.number),
          reviewRun(this.number).catch(() => null),
        ]);

        this.detail = detail;
        this.comments = comments;
        this.run = run;
        this.preview = await previewState(this.$store, this.workspace.name, this.workspace.cluster).catch(() => this.preview);

        if (detail?.meta?.ci?.failing && !this.failures) {
          this.failures = await ciFailures(this.number, this.repo).catch(() => null);
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    tone(state) {
      return { OPEN: 'success', MERGED: 'info', CLOSED: 'error', DRAFT: 'warning' }[state] || 'info';
    },

    // ── the review agent ──
    async review(done) {
      this.error = '';

      try {
        await startPrReview(this.$store, { number: this.number }, this.repo);
        this.notice = 'Review conversation opened. Open the Conversations tab to watch it; it starts when its pane is attached.';
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async triage(done) {
      this.error = '';

      try {
        await startCiTriage(this.$store, { number: this.number }, this.repo);
        this.notice = 'CI triage conversation opened. It decides whether the failures are this PR\'s and fixes or re-runs accordingly.';
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    // ── comments ──
    async add(done) {
      if (!this.draft.trim()) {
        done(false);

        return;
      }

      try {
        const at = this.draftPath ? { path: this.draftPath, line: Number(this.draftLine) || null } : undefined;

        await addComment(this.number, this.draft.trim(), at, 'you');
        this.draft = '';
        this.draftPath = '';
        this.draftLine = '';
        this.comments = await listComments(this.number);
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async toggleGood(comment) {
      try {
        await updateComment(this.number, comment.id, { status: comment.status === 'approved' ? 'pending' : 'approved' });
        this.comments = await listComments(this.number);
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    async markAllGood() {
      for (const c of this.unsubmitted.filter((c) => c.status !== 'approved')) {
        await updateComment(this.number, c.id, { status: 'approved' }).catch(() => {});
      }
      this.comments = await listComments(this.number);
    },

    startEdit(comment) {
      this.editing = comment.id;
      this.editBody = comment.body;
    },

    async saveEdit(comment) {
      try {
        await updateComment(this.number, comment.id, { body: this.editBody });
        this.editing = 0;
        this.comments = await listComments(this.number);
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    async remove(comment) {
      try {
        await deleteComment(this.number, comment.id);
        this.comments = await listComments(this.number);
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    // ── GitHub ──
    async submit(done) {
      this.error = '';

      try {
        const r = await submitReview(this.number, this.repo);

        this.notice = `Posted ${ r.posted } comment${ r.posted === 1 ? '' : 's' } to GitHub as one review.`;
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async approve(done) {
      this.error = '';

      try {
        const r = await approvePr(this.number, '', this.repo);

        this.notice = r.discarded ? `Approved - ${ r.discarded } pending comment${ r.discarded === 1 ? '' : 's' } discarded.` : 'Approved.';
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async merge(done) {
      this.error = '';

      try {
        await mergePr(this.number, this.repo);
        this.notice = `#${ this.number } squashed and merged.`;
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    // ── the static preview ──
    async deploy(done) {
      this.error = '';

      try {
        await deployPreview(this.$store, this.workspace.name, {
          repo: this.repo, ref: `pull/${ this.number }/head`, rancherUrl: this.previewRancher.trim().replace(/\/$/, ''),
        }, this.workspace.cluster);
        this.notice = 'Preview deploying. The first build takes several minutes; the link appears here when nginx is serving.';
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async rebuild(done) {
      try {
        await rebuildPreview(this.workspace.name, this.workspace.cluster);
        this.notice = 'Rebuilding the preview at the PR\'s current head.';
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async dropPreview(done) {
      try {
        await removePreview(this.$store, this.workspace.name);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    // ── CI ──
    async openFailure(check) {
      if (this.failureOpen === check.id) {
        this.failureOpen = null;

        return;
      }

      this.failureOpen = check.id;
      this.failureDetail = null;
      this.failureDetail = await ciFailureDetail(this.number, check.id, this.repo).catch((e) => ({ error: e.message || String(e) }));
    },
  },
};
</script>

<template>
  <div class="workspace-pr">
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="notice"
      color="info"
      :closable="true"
      :label="notice"
      @close="notice = ''"
    />
    <Banner
      v-if="!loading && !number && issue"
      color="info"
      :label="`No pull request closes #${ issue } yet. One will show up here when it does.`"
    />

    <div
      v-if="meta"
      class="workspace-pr__grid"
    >
      <!-- The PR itself -->
      <section class="workspace-pr__card">
        <header class="workspace-pr__head">
          <span
            class="workspace-pr__state"
            :class="`workspace-pr__state--${ tone(meta.state) }`"
          >{{ meta.state }}</span>
          <a
            :href="meta.url"
            target="_blank"
            rel="noopener noreferrer"
            class="workspace-pr__title"
          >#{{ meta.number }} {{ meta.title }}</a>
        </header>
        <dl class="workspace-pr__facts">
          <dt>Branch</dt>
          <dd><code>{{ meta.headRef }}</code> into <code>{{ meta.baseRef }}</code></dd>
          <dt>Changes</dt>
          <dd>{{ meta.changedFiles }} files, +{{ meta.additions }} / -{{ meta.deletions }}</dd>
          <dt>Reviews</dt>
          <dd>
            <span v-if="meta.approved" class="workspace-pr__good">approved by {{ meta.approvedBy.join(', ') }}</span>
            <span v-else class="text-muted">not approved yet</span>
          </dd>
          <dt>Checks</dt>
          <dd>
            <span v-if="!ci" class="text-muted">none configured</span>
            <span v-else-if="ci.failing" class="workspace-pr__bad">{{ ci.failing }} failing</span>
            <span v-else-if="ci.pending" class="workspace-pr__pending">{{ ci.pending }} running</span>
            <span v-else class="workspace-pr__good">all {{ ci.total }} passing</span>
          </dd>
        </dl>

        <div class="workspace-pr__actions">
          <AsyncButton
            mode="apply"
            :action-label="run ? 'Review again' : 'Review with the agent'"
            waiting-label="Opening"
            success-label="Opened"
            size="sm"
            @click="review"
          />
          <AsyncButton
            v-if="ci && ci.failing"
            mode="apply"
            action-label="Fix CI with the agent"
            waiting-label="Opening"
            success-label="Opened"
            size="sm"
            @click="triage"
          />
          <AsyncButton
            mode="apply"
            action-label="Approve"
            waiting-label="Approving"
            success-label="Approved"
            size="sm"
            :disabled="meta.state !== 'OPEN'"
            @click="approve"
          />
          <AsyncButton
            mode="apply"
            action-label="Squash & merge"
            waiting-label="Merging"
            success-label="Merged"
            size="sm"
            :disabled="meta.state !== 'OPEN'"
            @click="merge"
          />
        </div>

        <p
          v-if="run"
          class="workspace-pr__run"
        >
          <b>{{ runLabel }}</b>
          <span v-if="run.note"> - {{ run.note }}</span>
          <router-link :to="conversationsTo">Open the conversation</router-link>
        </p>

        <!--
          A link a reviewer can open: the dashboard built at this PR's head, served on the node,
          pointed at a Rancher. Infrastructure and tools kept apart - the preview talks to the
          Rancher it is told to, and needs nothing but an account there.
        -->
        <div class="workspace-pr__preview">
          <h4>Static preview</h4>
          <template v-if="preview && preview.exists">
            <p>
              <span
                class="workspace-pr__status"
                :class="`workspace-pr__status--${ preview.state === 'serving' ? 'approved' : (preview.state === 'failed' ? 'error' : 'pending') }`"
              >{{ preview.state }}</span>
              <span class="text-muted"> {{ preview.detail }}</span>
            </p>
            <p v-if="preview.url && preview.state === 'serving'">
              <a
                :href="preview.url"
                target="_blank"
                rel="noopener noreferrer"
                class="workspace-pr__preview-link"
              >{{ preview.url }}</a>
              <span class="text-muted"> - built at {{ preview.ref }}, talking to {{ preview.rancherUrl }}. Share it; a reviewer logs in to that Rancher.</span>
            </p>
            <div class="workspace-pr__actions">
              <AsyncButton
                mode="apply"
                action-label="Rebuild at current head"
                waiting-label="Restarting"
                success-label="Rebuilding"
                size="sm"
                @click="rebuild"
              />
              <AsyncButton
                mode="delete"
                action-label="Remove preview"
                waiting-label="Removing"
                success-label="Removed"
                size="sm"
                @click="dropPreview"
              />
            </div>
          </template>
          <template v-else>
            <div class="workspace-pr__compose-row">
              <input
                v-model="previewRancher"
                class="workspace-pr__rancher"
                type="text"
                placeholder="https://rancher.example.com"
                aria-label="Rancher the preview talks to"
              >
              <AsyncButton
                mode="apply"
                action-label="Deploy static preview"
                waiting-label="Deploying"
                success-label="Deploying"
                size="sm"
                :disabled="!previewRancher.trim()"
                @click="deploy"
              />
            </div>
            <p class="text-muted workspace-pr__hint">
              Builds the dashboard at this PR's head and serves it on a link of its own, with the API proxied to that Rancher.
            </p>
          </template>
        </div>

        <!-- Red CI, spelled out -->
        <div
          v-if="failures && failures.checks && failures.checks.length"
          class="workspace-pr__ci"
        >
          <h4>Failing checks</h4>
          <div
            v-for="check in failures.checks"
            :key="check.id"
            class="workspace-pr__check"
          >
            <button
              type="button"
              class="workspace-pr__check-name"
              @click="openFailure(check)"
            >
              <i
                class="icon"
                :class="failureOpen === check.id ? 'icon-chevron-down' : 'icon-chevron-right'"
              />
              {{ check.name }}
              <span class="text-muted"> {{ check.conclusion }}</span>
            </button>
            <a
              :href="check.url"
              target="_blank"
              rel="noopener noreferrer"
            >log</a>
            <div
              v-if="failureOpen === check.id"
              class="workspace-pr__check-detail"
            >
              <span
                v-if="!failureDetail"
                class="text-muted"
              >Reading the job log</span>
              <p
                v-else-if="failureDetail.error"
                class="workspace-pr__bad"
              >{{ failureDetail.error }}</p>
              <template v-else>
                <p
                  v-for="(a, i) in failureDetail.annotations.slice(0, 6)"
                  :key="i"
                  class="workspace-pr__annotation"
                >
                  <code>{{ a.path }}:{{ a.line }}</code> {{ a.message }}
                </p>
                <pre
                  v-if="failureDetail.log"
                  class="workspace-pr__log"
                >{{ failureDetail.log.text }}</pre>
              </template>
            </div>
          </div>
        </div>
      </section>

      <!-- The review: local comments, marked good, then submitted -->
      <section class="workspace-pr__card">
        <header class="workspace-pr__head workspace-pr__head--between">
          <h3>Review comments</h3>
          <span class="text-muted">
            {{ approvedCount }} good · {{ pendingCount }} pending · {{ submitted.length }} submitted
          </span>
        </header>

        <div class="workspace-pr__compose">
          <textarea
            v-model="draft"
            class="workspace-pr__textarea"
            rows="3"
            placeholder="A comment on the PR, or on a file and line below"
          />
          <div class="workspace-pr__compose-row">
            <select
              v-model="draftPath"
              class="workspace-pr__select"
            >
              <option value="">Whole PR</option>
              <option
                v-for="file in (detail.files || [])"
                :key="file.path"
                :value="file.path"
              >{{ file.path }}</option>
            </select>
            <input
              v-model="draftLine"
              class="workspace-pr__line"
              type="number"
              min="1"
              placeholder="line"
              :disabled="!draftPath"
            >
            <AsyncButton
              mode="apply"
              action-label="Add comment"
              waiting-label="Adding"
              success-label="Added"
              size="sm"
              :disabled="!draft.trim()"
              @click="add"
            />
          </div>
        </div>

        <p
          v-if="!unsubmitted.length"
          class="text-muted workspace-pr__empty"
        >
          No comments yet. Review with the agent, or add your own above.
        </p>

        <article
          v-for="comment in unsubmitted"
          :key="comment.id"
          class="workspace-pr__comment"
          :class="{ 'workspace-pr__comment--good': comment.status === 'approved' }"
        >
          <header class="workspace-pr__comment-head">
            <span class="workspace-pr__where">
              <code v-if="comment.path">{{ comment.path }}<template v-if="comment.line">:{{ comment.line }}</template></code>
              <span v-else>Whole PR</span>
            </span>
            <span class="text-muted">{{ comment.author }}</span>
            <span
              class="workspace-pr__status"
              :class="`workspace-pr__status--${ comment.status }`"
            >{{ comment.status === 'approved' ? 'good' : 'pending' }}</span>
          </header>
          <textarea
            v-if="editing === comment.id"
            v-model="editBody"
            class="workspace-pr__textarea"
            rows="4"
          />
          <p
            v-else
            class="workspace-pr__body"
          >{{ comment.body }}</p>
          <div class="workspace-pr__comment-actions">
            <template v-if="editing === comment.id">
              <RcButton
                variant="primary"
                size="small"
                @click="saveEdit(comment)"
              >
                Save
              </RcButton>
              <RcButton
                variant="tertiary"
                size="small"
                @click="editing = 0"
              >
                Cancel
              </RcButton>
            </template>
            <template v-else>
              <RcButton
                :variant="comment.status === 'approved' ? 'tertiary' : 'secondary'"
                size="small"
                :left-icon="comment.status === 'approved' ? 'checkmark' : ''"
                @click="toggleGood(comment)"
              >
                {{ comment.status === 'approved' ? 'Good' : 'Mark good' }}
              </RcButton>
              <RcButton
                variant="tertiary"
                size="small"
                @click="startEdit(comment)"
              >
                Edit
              </RcButton>
              <RcButton
                variant="tertiary"
                size="small"
                @click="remove(comment)"
              >
                Delete
              </RcButton>
            </template>
          </div>
        </article>

        <div
          v-if="unsubmitted.length"
          class="workspace-pr__actions"
        >
          <RcButton
            v-if="pendingCount"
            variant="secondary"
            size="small"
            @click="markAllGood"
          >
            Mark all good
          </RcButton>
          <AsyncButton
            mode="apply"
            :action-label="`Submit ${ unsubmitted.length } to GitHub`"
            waiting-label="Posting"
            success-label="Posted"
            size="sm"
            :disabled="!canSubmit"
            :title="canSubmit ? 'Post the approved comments as one review' : 'Every comment has to be marked good first'"
            @click="submit"
          />
        </div>

        <details
          v-if="submitted.length"
          class="workspace-pr__submitted"
        >
          <summary>{{ submitted.length }} already submitted</summary>
          <p
            v-for="comment in submitted"
            :key="comment.id"
            class="workspace-pr__body text-muted"
          >
            <code v-if="comment.path">{{ comment.path }}:{{ comment.line }}</code> {{ comment.body }}
          </p>
        </details>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .workspace-pr {
    padding:    var(--dev-space-5);
    overflow-y: auto;

    &__grid {
      display:               grid;
      grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.2fr);
      gap:                   var(--dev-space-5);
      align-items:           start;
    }

    &__card {
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
      padding:       var(--dev-space-4);
    }

    &__head {
      display:       flex;
      align-items:   center;
      gap:           var(--dev-space-3);
      margin-bottom: var(--dev-space-4);

      h3 { margin: 0; }

      &--between { justify-content: space-between; }
    }

    &__state, &__status {
      padding:        1px 8px;
      border-radius:  12px;
      font-size:      11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background:     var(--info-banner-bg);
      color:          var(--info);

      &--success, &--approved { background: var(--success-banner-bg); color: var(--success); }
      &--error   { background: var(--error-banner-bg);   color: var(--error); }
      &--warning, &--pending { background: var(--warning-banner-bg); color: var(--warning); }
    }

    &__title { font-size: 16px; font-weight: 600; }

    &__facts {
      display:               grid;
      grid-template-columns: max-content 1fr;
      gap:                   var(--dev-space-2) var(--dev-space-4);
      margin:                0 0 var(--dev-space-4) 0;

      dt { color: var(--muted); }
      dd { margin: 0; }
    }

    &__actions {
      display:   flex;
      flex-wrap: wrap;
      gap:       var(--dev-space-3);
    }

    &__run {
      margin: var(--dev-space-4) 0 0 0;

      a { margin-left: var(--dev-space-3); }
    }

    &__ci {
      margin-top: var(--dev-space-4);

      h4 { margin: 0 0 var(--dev-space-2) 0; }
    }

    &__check {
      display:   flex;
      flex-wrap: wrap;
      gap:       var(--dev-space-3);
      padding:   var(--dev-space-2) 0;
      border-top: 1px solid var(--border);
    }

    &__check-name {
      background: none;
      border:     0;
      padding:    0;
      color:      var(--body-text);
      cursor:     pointer;
      text-align: left;
    }

    &__check-detail { flex-basis: 100%; }

    &__annotation { margin: var(--dev-space-1) 0; }

    &__log {
      max-height: 320px;
      overflow:   auto;
      font-size:  11px;
      padding:    var(--dev-space-3);
      background: var(--terminal-bg, var(--body-bg));
      border:     1px solid var(--border);
    }

    &__compose { margin-bottom: var(--dev-space-4); }

    &__compose-row {
      display:     flex;
      gap:         var(--dev-space-3);
      align-items: center;
      margin-top:  var(--dev-space-2);
    }

    &__select { flex: 1 1 auto; min-width: 0; }

    &__line { width: 90px; }

    &__textarea {
      width:       100%;
      font-family: inherit;
    }

    &__empty { margin: var(--dev-space-4) 0; }

    &__comment {
      border-top: 1px solid var(--border);
      padding:    var(--dev-space-3) 0;

      &--good { border-left: 3px solid var(--success); padding-left: var(--dev-space-3); }
    }

    &__comment-head {
      display:       flex;
      gap:           var(--dev-space-3);
      align-items:   center;
      margin-bottom: var(--dev-space-2);
    }

    &__where { flex: 1 1 auto; }

    &__body {
      white-space: pre-wrap;
      margin:      0 0 var(--dev-space-2) 0;
    }

    &__comment-actions {
      display: flex;
      gap:     var(--dev-space-2);
    }

    &__submitted {
      margin-top: var(--dev-space-4);
      color:      var(--muted);
    }

    &__preview {
      margin-top: var(--dev-space-4);
      border-top: 1px solid var(--border);
      padding-top: var(--dev-space-3);

      h4 { margin: 0 0 var(--dev-space-2) 0; }
    }

    &__preview-link { font-weight: 600; word-break: break-all; }

    &__rancher { flex: 1 1 auto; min-width: 0; }

    &__hint { margin: var(--dev-space-2) 0 0 0; font-size: 12px; }

    &__good    { color: var(--success); }
    &__bad     { color: var(--error); }
    &__pending { color: var(--warning); }
  }
</style>
