# Sidecars (Rancher, Browser, Figma)

Your project's sidecar containers may not be running yet — the harness can create projects without them to keep batch creation cheap. When you need one (to reproduce an issue, test a fix, drive the browser), start them and wait until they're actually reachable:

```bash
# Idempotent: starts sidecars if needed, then blocks until endpoints answer.
# Without args, waits for both browser (CDP) and rancher.
wait-for-sidecars

# Or wait for just one:
wait-for-sidecars browser
wait-for-sidecars rancher
```

`wait-for-sidecars` is the right tool any time you're about to drive the browser (`browser.mjs` / playwright), hit the Rancher API, or visit `https://localhost:8443`. **Always call it before attempting to capture screenshots or videos** — the browser takes several seconds to boot after the sidecar container starts, and CDP will refuse connections until it's fully up.

Do not stop the sidecars as cleanup. The harness owns their lifecycle, and a person may be watching this project through the browser sidecar while you work. The stop endpoint (`POST $HARNESS_API/sidecars/stop/$HARNESS_PROJECT`) takes the browser, Rancher, and Figma sidecars down together, so calling it when you finish a task or amend a commit yanks the live browser view out from under whoever is watching. Leave the sidecars running. When you tidy up, only kill the processes you started yourself (for example `pkill -f "vite preview"` for a dev server); the harness stops the sidecars for you when the project itself is stopped.

Under the hood `wait-for-sidecars` calls `POST $HARNESS_API/sidecars/start/$HARNESS_PROJECT` which also runs `on-sidecars-up.sh` (socat forward + Rancher bootstrap — users, cloud creds).

## Changing what the sidecars ARE

The version of Rancher, its branding, and its auth provider are per-project
settings, not fixed by the image. This matters most when a bug only reproduces
on the version the reporter runs: reproducing against `head` when the report
says 2.13.7 wastes the whole attempt.

The portal shows these on the project's **Sidecars** tab, and the same API is
open to you. Use **`$CLAUDE_HARNESS_API`** for these — it carries your
credentials, while the bare `$HARNESS_API` is anonymous and these endpoints
answer it with `401`:

```bash
P="$HARNESS_PROJECT"

# What's running, what each container WOULD launch as, and the current settings
curl -s $CLAUDE_HARNESS_API/projects/$P/sidecars | jq

# Released Rancher versions to choose from (cached hourly)
curl -s "$CLAUDE_HARNESS_API/github-releases/rancher/rancher?limit=20" | jq -r '.tags[]'

# Reproduce against a specific version — recreates the rancher container
curl -s -X PUT $CLAUDE_HARNESS_API/projects/$P/sidecars/config \
  -H 'Content-Type: application/json' -d '{"rancherTag":"v2.13.7"}'

# Rancher Prime branding (SUSE look)
curl -s -X PUT $CLAUDE_HARNESS_API/projects/$P/sidecars/config \
  -H 'Content-Type: application/json' -d '{"prime":true}'

# Auth providers: "none", "keycloak-oidc", "keycloak-saml".
# Selecting one starts the Keycloak sidecar and points Rancher at it.
curl -s -X PUT $CLAUDE_HARNESS_API/projects/$P/sidecars/config \
  -H 'Content-Type: application/json' -d '{"authProvider":"keycloak-oidc"}'

# Accessibility tooling in the browser sidecar: "off", "atspi", "speech", "orca".
# Installs the AT stack and launches Chromium with --force-renderer-accessibility.
# Use the `a11y tier` wrapper instead of this — it waits for the rebuild.
curl -s -X PUT $CLAUDE_HARNESS_API/projects/$P/sidecars/config \
  -H 'Content-Type: application/json' -d '{"a11y":"speech"}'
```

## Running something inside a sidecar

This container has no docker socket and no sudo, so anything that has to happen
*inside* a sidecar — installing a package, starting a service, reading state
that only exists in that container's session — goes through the exec endpoint:

```bash
curl -s -X POST $CLAUDE_HARNESS_API/projects/$P/sidecars/browser/exec \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"ps -eo args | grep -m1 chromium","timeout":30000}' | jq -r .stdout
```

It answers with `{ok, status, stdout, stderr, timedOut}` and runs as root by
default; pass `"user":"abc"` for the desktop session's own user, which is who
anything talking to X, the session bus or PulseAudio has to be. This is how the
accessibility tooling works — see `accessibility.md`, and prefer the `a11y`
wrapper over hand-rolling exec calls.

Per-container lifecycle, when you need one specifically rather than all of them:

```bash
curl -s -X POST $CLAUDE_HARNESS_API/projects/$P/sidecars/rancher/restart
curl -s -X POST $CLAUDE_HARNESS_API/projects/$P/sidecars/keycloak/start
curl -s -X POST $CLAUDE_HARNESS_API/projects/$P/sidecars/rancher/recreate   # picks up a new image/env
```

Four things to know before you use them:

- **A version or auth change recreates the container**, because image tags and
  env are fixed when a container is created — a restart would keep the old
  ones. Rancher then takes several minutes to come back; `wait-for-sidecars
  rancher` afterwards, and say what you're doing in the conversation so nobody
  wonders why Rancher vanished. The PUT answers with what it did:
  `{"config":…,"recreated":["rancher"],"started":[],"stopped":[]}` — an empty
  `recreated` means nothing changed, so check the tag you sent is spelled the
  way the releases list spells it (`v2.14.2`, not `2.14.2`).
- **`runningImage` vs `image`** in the GET tells you whether a setting has
  actually landed. If they differ, the container predates the setting:

  ```bash
  curl -s $CLAUDE_HARNESS_API/projects/$P/sidecars \
    | jq '.sidecars[] | select(.name=="rancher") | {image, runningImage, status}'
  wait-for-sidecars rancher
  ```
- **A version change starts Rancher from an empty cluster.** The persisted k3s
  database was written by a different Rancher, and a downgrade in particular
  leaves data the new binary can't open — so the harness wipes it and re-runs
  the bootstrap (users, cloud credentials, the socat forward). Anything you set
  up inside the old Rancher — clusters, users, an OIDC app — is gone. Do the
  version swap **first**, then build the scenario.
- **The state is per project and persists.** Changing the version for a
  reproduction leaves it changed; set it back if the project is meant to track
  head, and mention it in your summary either way.

If a reproduction fails and the report names a version, check the version
before concluding the bug doesn't reproduce.
