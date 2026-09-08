#!/usr/bin/env python3
"""Dump Chromium's accessibility tree as AT-SPI exposes it.

This is the tree a Linux screen reader consumes, not the DOM and not axe's
model of the DOM. That difference is the whole point: an `aria-controls` whose
IDREF does not resolve simply does not exist as a relation here, so "the
relation is missing" stops being a lint opinion and becomes something you can
show. Same for a name that never made it out of the DOM, or a role the
platform mapped differently than you expected.

Runs inside the browser sidecar, as the desktop session user. Reach it from the
project container with `a11y tree` rather than calling it directly.

Usage:
  ax-dump.py [--role ROLE] [--name TEXT] [--relations] [--json] [--depth N]

  --role       only nodes whose AT-SPI role matches (substring, case folded)
  --name       only nodes whose accessible name matches (substring)
  --relations  print the relation set (controller-for, labelled-by, ...)
  --depth      how deep to walk from the browser frame (default 25)
  --json       machine-readable, for diffing two runs
"""
import argparse
import json
import sys

try:
    import pyatspi
except ImportError:
    sys.exit("pyatspi is not installed: this needs the 'atspi' tier or higher "
             "(PUT sidecars/config {\"a11y\":\"atspi\"})")

# pyatspi ships its own value->name map; fall back to deriving one from the
# RELATION_* constants (skipping the map itself, which is not hashable).
RELATION_NAMES = {
    value: str(name).replace('RELATION_', '').lower().replace('_', '-')
    for value, name in (getattr(pyatspi, 'RELATION_VALUE_TO_NAME', None) or {}).items()
} or {
    getattr(pyatspi, name): name.replace('RELATION_', '').lower().replace('_', '-')
    for name in dir(pyatspi)
    if name.startswith('RELATION_') and isinstance(getattr(pyatspi, name), int)
}


def node_info(node, want_relations):
    out = {
        'role': node.getRoleName(),
        'name': node.name or '',
    }
    states = node.getState()
    # Not every name exists in every pyatspi (there is no STATE_DISABLED, for
    # one), and an AttributeError here would take the whole node out.
    flags = []
    for name in ('SELECTED', 'FOCUSED', 'FOCUSABLE', 'EXPANDED', 'CHECKED',
                 'PRESSED', 'SENSITIVE', 'INVALID', 'BUSY'):
        state = getattr(pyatspi, 'STATE_' + name, None)
        if state is not None and states.contains(state):
            flags.append(name)
    if flags:
        out['states'] = flags
    try:
        attrs = dict(a.split(':', 1) for a in node.getAttributes() if ':' in a)
    except Exception:
        attrs = {}
    # The ARIA attributes that survived into the platform layer. `xml-roles` is
    # the role attribute as authored, which is worth seeing next to the mapped
    # AT-SPI role.
    for key in ('xml-roles', 'id', 'level', 'haspopup', 'live'):
        if attrs.get(key):
            out[key] = attrs[key]
    if want_relations:
        rels = {}
        for relation in node.getRelationSet():
            kind = RELATION_NAMES.get(relation.getRelationType(), 'unknown')
            targets = []
            for i in range(relation.getNTargets()):
                target = relation.getTarget(i)
                targets.append(f'{target.getRoleName()}:{target.name or ""}')
            rels[kind] = targets
        # An empty relation set is the finding, not the absence of one — say so
        # explicitly rather than omitting the key.
        out['relations'] = rels
    return out


def walk(node, depth, max_depth, args, acc):
    try:
        info = node_info(node, args.relations)
    except Exception as err:  # a node can vanish mid-walk as the page updates
        # Say so on stderr rather than dropping a subtree in silence — a walk
        # that quietly returns nothing looks exactly like a page with no
        # accessible content.
        print(f'[ax-dump] skipped a node at depth {depth}: {err}', file=sys.stderr)
        return
    keep = True
    if args.role and args.role.lower() not in info['role'].lower():
        keep = False
    if args.name and args.name.lower() not in info['name'].lower():
        keep = False
    if keep:
        info['depth'] = depth
        acc.append(info)
    if depth >= max_depth:
        return
    try:
        children = [node.getChildAtIndex(i) for i in range(node.childCount)]
    except Exception:
        children = []
    for child in children:
        if child is not None:
            walk(child, depth + 1, max_depth, args, acc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--role')
    ap.add_argument('--name')
    ap.add_argument('--relations', action='store_true')
    ap.add_argument('--depth', type=int, default=25)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    desktop = pyatspi.Registry.getDesktop(0)
    apps = [desktop.getChildAtIndex(i) for i in range(desktop.childCount)]
    browsers = [a for a in apps if a is not None and 'chrom' in (a.name or '').lower()]
    if not browsers:
        names = ', '.join(sorted(a.name for a in apps if a is not None and a.name)) or '(none)'
        sys.exit('Chromium is not on the accessibility bus. Applications seen: '
                 f'{names}. Run `a11y enable`: it announces an AT on the bus, '
                 'starts the registry, and restarts the browser if it started '
                 'before either existed.')

    found = []
    for app in browsers:
        walk(app, 0, args.depth, args, found)

    if args.json:
        print(json.dumps(found, indent=2))
        return
    for info in found:
        indent = '  ' * info.pop('depth')
        role = info.pop('role')
        name = info.pop('name')
        rels = info.pop('relations', None)
        extra = ' '.join(f'{k}={v}' for k, v in info.items())
        print(f'{indent}{role}  "{name}"  {extra}'.rstrip())
        if rels is not None:
            for kind, targets in sorted(rels.items()):
                print(f'{indent}    {kind}: {targets}')
            if not rels:
                print(f'{indent}    (no relations)')


if __name__ == '__main__':
    main()
