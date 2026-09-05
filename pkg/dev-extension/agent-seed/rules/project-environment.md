# Project Environment

Things about this container that look like breakage but aren't. Check here before concluding the environment is broken.

## Env vars only exist in interactive shells

`PROJECT_NAME` is set on the container itself, so every shell sees it. Everything else (`HARNESS_PROJECT`, `HARNESS_API`, `CLAUDE_BROWSER_CDP`, `API`, `RANCHER_HOST_NAME`, `RANCHER_ADMIN_USER`, `RANCHER_ADMIN_PASS`) is appended to `~/.bashrc` by `init.sh`, and `~/.bashrc` returns early for non-interactive shells. So:

- `bash -c '...'` and `bash -lc '...'` see them **empty**. A login shell does not help, `~/.profile` still defers to `~/.bashrc`.
- `bash -ic '...'` sees them.

When a script or a detached wrapper needs them, source the env file explicitly instead of relying on the shell:

```bash
set -a; source /workspace/.env; set +a
```

Empty `$HARNESS_PROJECT` is the usual cause of a `curl` to the harness API silently posting the wrong thing. Echo the variable before you use it in a one-shot shell.

## Exec in as uid 1000, not root

From the global session, `docker exec claude-harness-<project>-1` lands you as `root`, whose `$HOME` is `/root` and who therefore has none of the above. Always pass `-u 1000:1000` so you get the `node` user's environment and file ownership:

```bash
docker exec -u 1000:1000 claude-harness-<project>-1 bash -ic '...'
```

Root also triggers git's "dubious ownership" refusal on `/workspace/dashboard`, since the tree belongs to uid 1000. If you genuinely need git as root, `git config --global --add safe.directory /workspace/dashboard` first. As uid 1000 it never comes up.

## `node_modules` may be owned by root

The container runs as uid 1000 and has no `sudo`. Reads and the normal fix workflow are unaffected, but `yarn install --check-files` and storybook builds fail with `EACCES`. The fix needs root, which only the global session has:

```bash
docker exec claude-harness-<project>-1 chown -R 1000:1000 /workspace/dashboard/node_modules
```

Don't burn time retrying the install from inside the project. It cannot succeed.

## Useful repo commands

`/workspace/dashboard` is the rancher/dashboard checkout. `yarn lint` and `yarn type-check` walk the whole repo and take minutes, so scope them while iterating:

```bash
./node_modules/.bin/eslint --max-warnings 0 <changed files>   # yarn lint is the full repo
npx jest --ci <path or pattern>                                # yarn test is --watch, don't use it unattended
yarn type-check                                                # no scoped form, run once before committing
```
