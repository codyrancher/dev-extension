#!/usr/bin/env python3
"""scripts/prune-pages.py [keep=20] [--push]: prune codyrancher/dev-extension's gh-pages to the newest N versions.

GitHub Pages refuses sites over 1 GB: the deploy sits in syncing_files and times out. Each version
adds ~32 MB (extensions/dev-extension/<v>/ plus its .tgz), so the site needs pruning every ~15
versions. Removes older versions' directories and .tgz files and their index.yaml entries in one
commit made through the Git Data API (no checkout); the files stay in the branch's history.
Without --push it only prints the plan.
"""
import base64, json, re, subprocess, sys
from collections import Counter

REPO = 'repos/codyrancher/dev-extension'
CLONE = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, cwd=__import__('os').path.dirname(__import__('os').path.abspath(__file__))).stdout.strip()
keep_n = int(next((a for a in sys.argv[1:] if a.isdigit()), 20))
push = '--push' in sys.argv


def api(method, path, body=None):
    out = subprocess.run(['gh', 'api', '-X', method, path] + (['--input', '-'] if body is not None else []),
                         input=json.dumps(body) if body is not None else None, capture_output=True, text=True)
    if out.returncode:
        raise SystemExit(f'{method} {path} failed: {out.stderr[:400]} {out.stdout[:400]}')
    return json.loads(out.stdout)


def git(*args):
    return subprocess.run(['git', '-C', CLONE, *args], capture_output=True, text=True, check=True).stdout


head = api('GET', f'{REPO}/git/ref/heads/gh-pages')['object']['sha']
git('fetch', '-q', 'origin', 'gh-pages')
assert git('rev-parse', 'origin/gh-pages').strip() == head, 'fetched gh-pages is not the remote head'
base = api('GET', f'{REPO}/git/commits/{head}')['tree']['sha']
paths = git('ls-tree', '-r', '--name-only', head).split('\n')

ver = lambda v: tuple(map(int, v.split('.')))
vs = sorted({m.group(1) for p in paths for m in [re.search(r'dev-extension[/-](\d+\.\d+\.\d+)', p)] if m}, key=ver)
keep = set(vs[-keep_n:])
drop = set(vs) - keep
found = {}
for p in paths:
    parts = p.split('/')
    for i, part in enumerate(parts):
        m = re.fullmatch(r'(?:dev-extension-)?(\d+\.\d+\.\d+)(\.tgz)?', part)
        if m and m.group(1) in drop:
            q = '/'.join(parts[:i + 1])
            kind = 'blob' if i == len(parts) - 1 else 'tree'
            found[q] = 'tree' if found.get(q) == 'tree' else kind
            break
top = sorted(found)
final = [p for p in top if not any(p != q and p.startswith(q + '/') for q in top)]
print(f'head {head[:10]} versions {len(vs)}: keep {len(keep)} ({min(keep, key=ver)}..{max(keep, key=ver)}), drop {len(drop)}, paths {len(final)}')
print(Counter((p.split('/')[0], found[p]) for p in final))
if not drop:
    raise SystemExit('nothing to drop')

index = base64.b64decode(api('GET', f'{REPO}/contents/index.yaml?ref={head}')['content'])
import yaml  # noqa: E402
doc = yaml.safe_load(index)
before = len(doc['entries']['dev-extension'])
doc['entries']['dev-extension'] = [e for e in doc['entries']['dev-extension'] if e['version'] in keep]
print(f"index.yaml entries {before} -> {len(doc['entries']['dev-extension'])}; kept but unindexed: {sorted(keep - {e['version'] for e in doc['entries']['dev-extension']}, key=ver)}")
if not push:
    raise SystemExit('dry run: pass --push to commit')

assert api('GET', f'{REPO}/git/ref/heads/gh-pages')['object']['sha'] == head, 'gh-pages moved; run again'
blob = api('POST', f'{REPO}/git/blobs', {'content': base64.b64encode(yaml.safe_dump(doc, sort_keys=False, default_flow_style=False, width=1000).encode()).decode(), 'encoding': 'base64'})['sha']
entries = [{'path': p, 'mode': '040000' if found[p] == 'tree' else '100644', 'type': found[p], 'sha': None} for p in final]
entries.append({'path': 'index.yaml', 'mode': '100644', 'type': 'blob', 'sha': blob})
tree = api('POST', f'{REPO}/git/trees', {'base_tree': base, 'tree': entries})['sha']
kept = sorted(keep, key=ver)
msg = (f'Prune Pages to the newest {keep_n} versions ({kept[0]} to {kept[-1]})\n\n'
       f'The site was back over GitHub Pages\' 1 GB limit ({len(vs)} versions), so deploys timed out in\n'
       f'syncing_files. Removes the {len(drop)} older versions\' extension files and charts and their\n'
       'index.yaml entries; the files stay in this branch\'s history.\n\n'
       'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n')
commit = api('POST', f'{REPO}/git/commits', {'message': msg, 'tree': tree, 'parents': [head], 'author': {'name': 'Cody Jackson', 'email': 'claude@cjackson.dev'}})['sha']
assert api('GET', f'{REPO}/git/ref/heads/gh-pages')['object']['sha'] == head, 'gh-pages moved; run again'
print('ref', api('PATCH', f'{REPO}/git/refs/heads/gh-pages', {'sha': commit, 'force': False})['object']['sha'])
