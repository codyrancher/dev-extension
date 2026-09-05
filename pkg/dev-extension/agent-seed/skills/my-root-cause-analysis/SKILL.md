---
name: my-root-cause-analysis
description: Enumerate several plausible root causes for a reproduced bug, gather evidence for and against each, then pick the fix that either has the smallest blast radius or leaves the codebase more consistent and less special-cased. Produces a written plan naming every file to touch and the regression surface to check. Use after a bug reproduces and before any edit, or on its own when asked why something breaks or which of two fixes to take.
---

The first explanation that fits the symptom is usually a symptom-level explanation. This skill exists to stop you writing the fix you thought of in the first thirty seconds.

Do not start until the bug reproduces. An unreproduced bug cannot have its causes tested, and every candidate below is a hypothesis you have to be able to falsify.

## 1. Trace the symptom back to where the value goes wrong

Work backwards from what the user sees, one hop at a time, until the data or state is provably correct on one side of a boundary and provably wrong on the other. That boundary is where the bug lives. Everything downstream of it is a symptom.

Useful hops: rendered DOM, the component's computed or prop, the store getter, the model class, the normalizer, the API response. Check the API response early; a wrong value on the wire moves the whole investigation.

```bash
cd /workspace/dashboard
git log -L <start>,<end>:<file>     # who last changed the suspect lines and why
git log --oneline -20 -- <file>
```

If a recent commit touched exactly the failing code path, read it. Regressions are far more common than bugs that were always there, and the commit message usually names the case its author had in mind.

## 2. Write down at least two candidate causes, three if the code path is long

For each candidate, write:

| Field | What it means |
|---|---|
| **Cause** | One sentence, naming the file and the mechanism. Not "the component renders wrong", but "`ResourceTable` sorts on the raw field, so the display formatter is bypassed". |
| **Evidence for** | The specific observation that made you think this. |
| **Evidence against** | What you would expect to also be broken if this were true, and whether it is. |
| **Falsification test** | The single check that would prove this one wrong. Run it. |
| **Fix shape** | The files and roughly the change. |
| **Blast radius** | Everything else that reads the code you would change (`grep` for callers, do not guess). |

Do not skip **evidence against** and **falsification test**. A candidate you have not tried to kill is a guess wearing a table row.

If two candidates are both true, they are not competing. Say which one is the cause and which is a second bug, and note the second one for the PR description rather than fixing it here.

## 3. Choose

Rank the surviving candidates by these rules, in order:

1. **Reject any fix that adds a special case.** A conditional keyed on a specific resource type, route name, field value, cluster, or role, added so one screen behaves, is a disqualifier and not a tiebreaker. It hides the defect, it breaks the sibling view that reads the same data, and the next person hits the same bug one screen over. Special-casing at the wrong altitude is how this codebase accumulates its worst code.
2. **Prefer the fix that makes the code more consistent.** If the repo already has an established pattern for this shape of problem (models, formatters, sortable table columns, validators, modal flows), the fix that adopts it beats the fix that invents. Find two or three existing components solving the same shape and follow them. A fix that looks unlike its neighbours gets rejected on that alone.
3. **Among the remaining candidates, take the smallest blast radius.** Fewest files, fewest callers affected, most local to the reported behaviour.
4. **Keep the diff to the issue.** No opportunistic refactors, no reformatting untouched lines, no new dependencies.

**When the rules conflict** (the only small fix is a special case, and the general fix sits in shared code a dozen screens depend on), decide it this way and state the call explicitly:

- If the shared code is wrong for its other callers too, fix it there. Those other screens are also broken, and fixing them is the point rather than a risk. Add the other callers to your regression list and check every one.
- If the shared code is correct for its other callers and only this caller passes it something unusual, the defect is in the caller. Fix the caller, which is both narrower and more correct.
- If neither is true and you genuinely must fix narrowly in a shared file, do it, and write one sentence in the plan and in the PR description saying which general fix you passed on and why. A stated tradeoff survives review; an unstated one reads as a mistake.

## 4. Write the plan before editing

Name every file you intend to touch, one line each on what changes and why. Then, in the same plan:

- **The regression surface.** Every other caller of the code you are about to change, from the blast-radius column. This list is not optional and it becomes the verification checklist.
- **The test seam.** Where a test can observe this fix (a model getter, a formatter, a util, a component's rendered output). If there is no seam, say so now; that is a signal the fix is at the wrong altitude.
- **Assumptions.** If two readings of the issue lead to materially different fixes, pick the one the issue text supports best, state the assumption, and continue. Nobody is going to answer a question.

## Output

The candidate table, the chosen cause with its justification against the four rules above, the file-by-file plan, the regression surface, and the test seam. If you rejected a tempting smaller fix, say which and why, so the reviewer does not propose it back to you.
