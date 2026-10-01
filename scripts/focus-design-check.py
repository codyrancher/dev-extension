"""Check what we added to the Focus view against the rules the POC set for itself.

Not a linter for CSS in general: it knows four things the prototype is consistent about, and
every one of them is something that reads as "off" when it is broken.
"""
import re, sys, pathlib

MINE = [
  'components/focus/WeightsChart.vue',
  'components/focus/CardGallery.vue',
  'components/focus/FocusChatBar.vue',
  'components/focus/FocusCard.vue',
  'pages/Focus.vue',
]
ROOT = pathlib.Path('/tmp/claude-1000/dev-extension/pkg/dev-extension')

# What the prototype allows itself: its scale, its control sizes, its ornament values.
SCALE = {'--s1','--s2','--s3','--s4','--s5','--s6','--s7','--s8'}
OK_PX = {0,1,2,3,4,5,6,8,9,10,14,16,18,20,22,24,26,28,30,32,34,38,40,44,48,56,64}
MIN_HIT = 30          # .btn--sm is 30px; nothing clickable in the POC is smaller
CONTROL_RE = re.compile(r'^\.(?:[a-z0-9_-]*(?:btn|button|tab|edit|undo|pin|close|send|tool|peek|kind|track|row)[a-z0-9_-]*)\b', re.I)

issues = []
for rel in MINE:
    text = (ROOT / rel).read_text()
    css = text[text.index('<style'):] if '<style' in text else ''
    for block in re.finditer(r'(^\.[^\n{]*)\{([^}]*)\}', css, re.M):
        sel, body = block.group(1).strip(), block.group(2)
        line = css[:block.start()].count('\n') + text[:text.index('<style')].count('\n') + 1
        # 1. A hand-rolled colour where a token exists.
        for hit in re.finditer(r':\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))', body, re.I):
            if rel.endswith('FocusChatBar.vue') or 'rgba(0, 0, 0' in hit.group(0) or 'rgba(6, 8, 14' in hit.group(0):
                continue  # shadows, veils and the bar are the prototype's own, literals included
            issues.append((rel, line, sel, f'literal colour {hit.group(1)}'))
        # 2. A length off the scale.
        for hit in re.finditer(r'(?:padding|margin|gap|border-radius)(?:-[a-z]+)?:\s*([^;]+);', body):
            for px in re.findall(r'(\d+)px', hit.group(1)):
                if int(px) not in OK_PX and 'clamp(' not in hit.group(1):
                    issues.append((rel, line, sel, f'{px}px off the scale in "{hit.group(0).strip()}"'))
        # 3. Something you press that is too small to press.
        if CONTROL_RE.match(sel) and 'cursor: pointer' in body:
            h = re.search(r'(?:^|\s)height:\s*(\d+)px', body)
            mh = re.search(r'min-height:\s*(\d+)px', body)
            pad = re.search(r'padding:\s*(\d+)px', body)
            tall = max(int(h.group(1)) if h else 0, int(mh.group(1)) if mh else 0,
                       (int(pad.group(1)) * 2 + 16) if pad else 0)
            if tall and tall < MIN_HIT:
                issues.append((rel, line, sel, f'{tall}px tall; the smallest control in the POC is {MIN_HIT}px'))
            if not tall and 'place-items: center' in body and not h:
                issues.append((rel, line, sel, 'pressable with no height set'))

for rel, line, sel, what in issues:
    print(f'{rel}:{line}  {sel}\n    {what}')
print(f'\n{len(issues)} to fix' if issues else '\nnothing to fix')
