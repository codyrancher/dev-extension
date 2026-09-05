# GitHub Links

When creating links to GitHub files (in PR descriptions, review comments, commit messages, or anywhere else), always use **absolute URLs pinned to the commit SHA**, not relative paths or branch-name URLs.

Format: `https://github.com/<owner>/<repo>/blob/<sha>/<path>#Lxx`

Get the current HEAD SHA:
```bash
gh api repos/<owner>/<repo>/commits/<branch> --jq .sha
```

Why: relative paths resolve against the page URL (which varies by context), and branch-name URLs rot as the branch advances — the linked line numbers shift or the file disappears after merge.
