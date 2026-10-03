"""Check what we added to the Focus view against the rules the POC set for itself.

Not a linter for CSS in general: it knows four things the prototype is consistent about, and
every one of them is something that reads as "off" when it is broken.
"""
import re, sys, pathlib

# Every file in the view that draws a control, which is not the same list as the files somebody
# happened to be editing when this was written. It said "nothing to fix" while four kinds of
# pressable thing sat under the floor on nearly every card - the pin and the workspace tag at 24px
# on 26 and 22 of 26 cards, `See the whole file` at 22px on 24 of them, and 753 code rows at 20px -
# because none of those four lived in the five files it was looking at.
MINE = [
  'components/focus/WeightsChart.vue',
  'components/focus/CardGallery.vue',
  'components/focus/FocusChatBar.vue',
  # The chat the bar is made of.
  #
  # The bar used to embed the drawer's whole conversation pane and restyle it from
  # design/focus-chat.css, so none of what it drew was in a file this ever read - a 4,137-line
  # component in components/ and a stylesheet keyed on a class. It is these five components now,
  # every one of which draws something pressable: a tool row's disclosure, a turn's `send again`,
  # the composer's send, the typeahead's rows, a question's options.
  'components/chat/ChatTurns.vue',
  'components/chat/ChatTurn.vue',
  'components/chat/ChatToolRow.vue',
  'components/chat/ChatQuestion.vue',
  'components/chat/ChatComposer.vue',
  'components/focus/FocusCard.vue',
  'components/focus/AppButton.vue',
  'components/focus/CardAgent.vue',
  'components/focus/CardBumps.vue',
  'components/focus/CardChecks.vue',
  'components/focus/CardComments.vue',
  'components/focus/CardEvidence.vue',
  'components/focus/CardFacts.vue',
  'components/focus/CardPool.vue',
  'components/focus/CardReviewers.vue',
  'components/focus/ChangeSet.vue',
  'components/focus/FocusDeck.vue',
  'components/focus/FocusDock.vue',
  'components/focus/MediaViewer.vue',
  'components/focus/ReviewPass.vue',
  'components/focus/SectionHead.vue',
  'components/focus/StatPill.vue',
  'components/focus/TextModal.vue',
  'components/code/CodeView.vue',
  'components/code/FileModal.vue',
  'pages/Focus.vue',
  # The stylesheet the whole view is built out of, which was the one file not being read.
  #
  # It said "nothing to fix" while 15 of 26 cards carried a pressable under the 30px floor, and it
  # could not have said otherwise: `.ev__go` declares `cursor: pointer` in CardEvidence and takes
  # its height from `.dev-focus .u-pill { height: var(--pill-h) }` in here, so the two halves of
  # one violation sat in two files and only one of them was ever opened. A control's height is as
  # likely to be written in the shared sheet as in the component, and a checker that reads only
  # components is a checker that can be satisfied by moving a declaration.
  'design/focus.css',
]
ROOT = pathlib.Path('/tmp/claude-1000/dev-extension/pkg/dev-extension')

# What the prototype allows itself: its scale, its control sizes, its ornament values.
SCALE = {'--s1','--s2','--s3','--s4','--s5','--s6','--s7','--s8'}
OK_PX = {0,1,2,3,4,5,6,8,9,10,14,16,18,20,22,24,26,28,30,32,34,38,40,44,48,56,64}
MIN_HIT = 30          # `--control-h` is 32px and the smallest hit area in the view is 30
# The heights the view names. A control that says `height: var(--control-h)` is the point of having
# the token, and the check went blind to every one of them the moment they stopped being literals -
# which would have let the next 22px control through under a token's name.
TOKEN_PX = {
    '--control-h': 32, '--primary-h': 44, '--pill-h': 26, '--head-h': 32, '--ws-dot': 7,
}
# What counts as a control: `cursor: pointer`, and nothing about its name.
#
# It was a list of fourteen words a control's class might contain - btn, button, tab, pin, close,
# row and so on - which is a guess about naming rather than a test for pressability, and it let
# `.cv__expand` through at 22px on 24 of the deck's 26 cards because nobody had thought of
# "expand". A declaration saying the pointer turns into a hand is the thing itself.

issues = []
for rel in MINE:
    text = (ROOT / rel).read_text()
    # A plain stylesheet is all style; a component's is what follows its `<style`.
    sheet = not rel.endswith('.vue')
    css = text if sheet else (text[text.index('<style'):] if '<style' in text else '')
    before = 0 if sheet else text[:text.index('<style')].count('\n') if '<style' in text else 0
    for block in re.finditer(r'(^\.[^\n{]*)\{([^}]*)\}', css, re.M):
        sel, body = block.group(1).strip(), block.group(2)
        line = css[:block.start()].count('\n') + before + 1
        # 1. A hand-rolled colour where a token exists.
        #
        # Not in `design/focus.css`, which is where the tokens are *declared*: every literal in it
        # is the definition of the thing the rule is asking the components to use, so running this
        # rule there would report the palette as sixty violations of itself. The other two rules -
        # the space scale and the floor under anything pressable - apply there like anywhere else,
        # and the floor is the reason the file is in this list at all.
        for hit in () if sheet else re.finditer(r':\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))', body, re.I):
            if rel.endswith('FocusChatBar.vue') or 'rgba(0, 0, 0' in hit.group(0) or 'rgba(6, 8, 14' in hit.group(0):
                continue  # shadows, veils and the bar are the prototype's own, literals included
            issues.append((rel, line, sel, f'literal colour {hit.group(1)}'))
        # 2. A length off the scale.
        for hit in re.finditer(r'(?:padding|margin|gap|border-radius)(?:-[a-z]+)?:\s*([^;]+);', body):
            for px in re.findall(r'(\d+)px', hit.group(1)):
                if int(px) not in OK_PX and 'clamp(' not in hit.group(1):
                    issues.append((rel, line, sel, f'{px}px off the scale in "{hit.group(0).strip()}"'))
        # 3. Something you press that is too small to press.
        pressable = 'cursor: pointer' in body or 'cursor: ew-resize' in body or 'cursor: grab' in body
        if pressable:
            def px(prop):
                hit = re.search(rf'(?:^|\s){ prop }:\s*([^;]+);', body)
                if not hit:
                    return 0
                literal = re.match(r'\s*(\d+)px', hit.group(1))
                if literal:
                    return int(literal.group(1))
                named = re.search(r'var\((--[a-z-]+)', hit.group(1))
                return TOKEN_PX.get(named.group(1), 0) if named else 0

            h, mh = px('height'), px('min-height')
            pad = re.search(r'padding:\s*(\d+)px', body)
            tall = max(h, mh, (int(pad.group(1)) * 2 + 16) if pad else 0)
            if tall and tall < MIN_HIT:
                issues.append((rel, line, sel, f'{tall}px tall; the smallest control in the POC is {MIN_HIT}px'))
            square = re.search(r'(?:^|\s)width:\s*var\(--(?:head-h|control-h)\)', body) or re.search(r'aspect-ratio', body)
            if not tall and not square and 'place-items: center' in body:
                issues.append((rel, line, sel, 'pressable with no height set'))

for rel, line, sel, what in issues:
    print(f'{rel}:{line}  {sel}\n    {what}')
print(f'\n{len(issues)} to fix' if issues else '\nnothing to fix')
