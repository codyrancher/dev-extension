---
name: my-pr-create
description: Push a committed fix and open a draft pull request upstream to rancher/dashboard. Owns the mechanics: branch and push, uploading recorded videos and screenshots to GitHub user-attachments via the browser sidecar (Playwright + CDP) so they embed inline, creating the draft PR, and verifying the rendered body. Delegates the body's content to my-pr-fill-template. Use when a fix is committed and ready for review.
---

Mechanics only. This skill gets a committed fix onto a branch, gets its media hosted, opens the draft PR, and proves the result renders correctly. **What the body says is `my-pr-fill-template`'s job**, including the template itself, the word budgets, the setup block and the checklist policy. Do not compose a body here, and do not fine-tune the wording rules here; edit that skill instead.

The steps are in order. Step 3 needs a URL from step 1 or an existing PR, and step 4 needs the hrefs from step 3.

## 1. Branch and push

- Make a new branch with the changes named `issue-$(issueNumber)`.
- Push to origin. The pre-push hook runs a full-repo ESLint pass (~2 minutes); give the `git push` a generous timeout (~600000ms) so it isn't killed mid-lint. On an amended commit, use `git push --force-with-lease`.

## 2. Upload the media

Every recorded file goes to GitHub's `user-attachments` CDN through the **browser sidecar**. The sidecar has synced GitHub session cookies, so the upload's CSRF flow works correctly (HTTP proxies cannot reliably handle this). OAuth tokens cannot do user-attachments uploads either.

**Use the bundled script, do not rewrite this flow inline.** It is checked in next to this file and is known-good.

1. Ensure the browser sidecar is running: `wait-for-sidecars browser`

2. Pick a **pull request page** in the same repo to act as the upload host, and get its URL. GitHub's React issue UI renders no uploader at all, so an issue URL cannot work (see gotchas). Any open PR in the repo will do. The assets are *not* attached to it, the page only supplies the CSRF token and repository id:

   ```bash
   HOST_PR=$(gh pr list --repo rancher/dashboard --state open --limit 1 --json url -q '.[0].url')
   ```

   If you have already created your own PR, its URL works equally well.

3. Run the bundled script:

   ```bash
   node /workspace/.claude/skills/my-pr-create/upload-github-assets.mjs \
     "$HOST_PR" \
     /workspace/artifacts/reproduce/*.webm \
     /workspace/artifacts/verify/*.webm \
     /workspace/screenshots/*.png
   ```

   `my-issue-reproduce` writes the before video to `/workspace/artifacts/reproduce/` and `my-fix-demonstrate` writes the after video to `/workspace/artifacts/verify/`. Older runs put them in `/workspace/videos/`, so glob that too if the artifacts dirs are empty. Pass only paths that exist; the script does not tolerate an unmatched glob.

   Run `my-video-censor-ip` over the videos first if the dev IP is visible anywhere in frame. Once uploaded, an asset is public and cannot be revoked.

4. Parse the tab-separated output; each line is `filename\thref`. Keep those lines: they are an input to step 3.

5. Verify each href actually resolves before relying on it, since an unconfirmed asset returns 404 only later, once the PR is already published:

   ```bash
   curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -L "<href>"
   ```

**Gotchas, these cost a debugging session each, do not rediscover them:**

- **The CSRF token is a dedicated element, not the generic one.** `/upload/policies/assets` rejects `input[name="authenticity_token"]` and `meta[name="csrf-token"]` (they are scoped per-form: search feedback, reactions, and so on) and answers with an **HTML error page** rather than JSON. The correct token is `input.js-data-upload-policy-url-csrf`, which ships with the classic comment box. It is a hidden input, so wait on it with `state: 'attached'`; `visible` hangs forever.
- **Issue pages no longer have an uploader.** GitHub's new React issue UI renders no `file-attachment` element and no upload-policy token, so pointing this at `/issues/<n>` cannot work no matter what the selector is. Use a page that still uses the classic comment box, i.e. a pull request page.
- **The policy request is `FormData`, not JSON.** Send `Accept: application/json` and let `fetch` set the multipart `Content-Type` itself; don't set it by hand or the boundary is lost.
- **The confirmation PUT is required.** After the S3 `POST` succeeds, `PUT` to `pol.asset_upload_url` with `pol.asset_upload_authenticity_token`. Skip it and the asset stays unconfirmed and 404s later, which looks like a successful upload at the time.
- If you hit unexpected responses, save the raw error text and surface it to the user rather than guessing. The upload protocol is undocumented and changes. When it changes again, fix `upload-github-assets.mjs` and update this list; do not fork a private copy of the script.

**If the browser sidecar isn't running (or cookies aren't synced)**, hand `my-pr-fill-template` this placeholder block instead of hrefs, and tell the user to drag-drop manually:

```markdown
### Screenshot/Video

<!-- TODO(manual upload): browser sidecar was unavailable; drag-drop each file into this section. -->
- Before fix: `/workspace/videos/before-fix.webm`
- After fix: `/workspace/videos/after-fix.webm`
- Screenshots: `/workspace/screenshots/*.png`
```

**Last-resort fallback (only if the user explicitly asks for it and the sidecar isn't available)**: media can be hosted on the fork's releases and embedded with markdown image syntax. Videos must be converted to animated WebP first because GitHub's sanitizer strips `<video>` tags that don't point at `user-attachments`.

```bash
# 1. webm to animated WebP (~50 to 70% smaller than GIF at the same quality; drop fps to 10 or scale to 720 if >1 MB)
ffmpeg -y -i /workspace/videos/before-fix.webm \
  -vf 'fps=15,scale=960:-2:flags=lanczos' \
  -c:v libwebp -loop 0 -q:v 75 \
  /workspace/videos/before-fix.webp

# 2. Upload to a prerelease on the fork (idempotent, use `gh release upload <tag> <file>...` if the release already exists)
gh release create issue-$(issueNumber)-artifacts --repo <fork> \
  --prerelease --title "Issue $(issueNumber) artifacts" --notes "Artifacts for PR" \
  /workspace/videos/*.webp /workspace/screenshots/*.png

# 3. Reference via markdown image syntax in the PR body, GitHub renders animated WebP inline
# ![before](https://github.com/<fork>/releases/download/issue-$(issueNumber)-artifacts/before-fix.webp)
```

## 3. Fill the template

Invoke **`my-pr-fill-template`**. Give it the issue number, the branch diff, the `filename\thref` lines from step 2 (or the placeholder block), the jest paths covering the change, and the fixture you tested with. It writes the finished body to `/workspace/artifacts/pr-body.md`.

Do not shortcut this by writing a body yourself. The word budget, the reproducible setup block and the checklist policy all live there, and a hand-rolled body reliably misses at least one.

## 4. Create the draft PR

```bash
gh pr create --repo rancher/dashboard --draft \
  --title "<title>" --body-file /workspace/artifacts/pr-body.md
```

Always `--body-file`, never `--body` with a heredoc: a piped body mangles the fixture YAML's indentation and eats backticks, and you only find out once the PR is public.

**Draft, and it stays a draft.** Do not mark it ready for review; the user marks it ready themselves once they've reviewed the description.

## 5. Verify the published body

`grep -c` proves the source is right, not that GitHub renders it right. Do both.

Strays first. The CI checklist script greps the whole body for `\[.\]`, so a literal `[ ]` anywhere outside the 9 items fails the `Description` job:

```bash
gh pr view <PR> -R rancher/dashboard --json body -q .body > /tmp/pr-body.md
grep -n '\[.\]' /tmp/pr-body.md | grep -v '^[0-9]*:- \[[ x]\] '
```

Anything that prints is a stray outside the checklist. Reword it unless it is harmless: the script matches `\[.\]`, exactly one character between the brackets, so `[x]` and `[0]` match the grep but pass the job while `[abc]` never matches at all. Only a literal `[ ]` actually fails it.

Then render it through GitHub's own GFM endpoint and count the DOM:

```bash
node -e 'const fs=require("fs");fs.writeFileSync("/tmp/md.json",JSON.stringify({text:fs.readFileSync("/tmp/pr-body.md","utf8"),mode:"gfm",context:"rancher/dashboard"}))'
gh api --method POST /markdown --input /tmp/md.json > /tmp/rendered.html
node -e '
const h = require("fs").readFileSync("/tmp/rendered.html", "utf8");
const lists = h.match(/<ul class="contains-task-list">[\s\S]*?<\/ul>/g) || [];
lists.forEach((u, i) => console.log(`task list ${i}: li=${(u.match(/<li/g)||[]).length} p-wrapped=${(u.match(/<li[^>]*>\s*<p/g)||[]).length} checkboxes=${(u.match(/type="checkbox"/g)||[]).length}`));
console.log("videos:", (h.match(/<video/g) || []).length, "h3:", (h.match(/<h3[^>]*>/g) || []).length);
'
```

Expect exactly one task list with `li=9`, `p-wrapped=0` (a non-zero `p-wrapped` is the loose-list bug `my-pr-fill-template` warns about), `checkboxes=9`, `videos=2` for a before/after pair, and `h3=7`. Also run that skill's word count against `/tmp/pr-body.md` and confirm it is under 450.

Anything wrong here is a body problem: fix `/workspace/artifacts/pr-body.md` and `gh pr edit <PR> --body-file` it, rather than patching the live body by hand.

## 6. Hand over

`.github/workflows/valid-pr.yaml` runs a job named **`Description`** that executes `.github/workflows/scripts/pr-check-checklist.sh`, which fails the moment **any** box is `[ ]`:

```bash
CHECKBOXES=$(echo "$PR_BODY" | grep -o '\[.\]')
UNCHECKED=$(echo "$CHECKBOXES" | grep '\[ \]' || true)
if [ -n "$UNCHECKED" ]; then echo "Checklist has not been completed"; exit 1; fi
```

**`Description` staying red is the expected terminal state of a draft you hand over.** `The PR has a Milestone` and `The PR has a reviewer assigned` are the user's to set, so they stay unticked, so the job fails. That is correct. It goes green when the user sets the milestone and the reviewer and ticks those two boxes, and not before.

So your handover says: the PR URL, which checklist items you left unticked and why, that the red `Description` job is those items and not a bug, and that the PR is deliberately still a draft. Then run `my-pr-checklist` to work the items that are yours.
