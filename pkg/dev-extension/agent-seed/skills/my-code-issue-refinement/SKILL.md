---
name: my-code-issue-refinement
description: Refine a change against its issue using two subagents — one implements, one evaluates whether the change actually addresses the issue, simplifies the code, and follows this repo's patterns — looping until the evaluator is satisfied. Use when a fix exists but is not yet good enough, or when asked to refine, polish or iterate on a change until it is right.
---

Two agents, looping, until the evaluator says it is right.

Can you spin up two subagents, one agent is responsible for implementing any
fixes or changes required and the other is there to evaluate if the change
correctly addresses a point in the original issue, simplifies the code, makes
the code more consistent and follows our general patterns. Have these agents
loop until the evaluator thinks all of the changes are perfect.

## The two roles

**The implementer** makes changes. It gets the issue, the current diff, and —
after the first round — the evaluator's findings. It changes code and nothing
else: it does not grade its own work, and it does not argue with a finding it
disagrees with, it answers in the diff or leaves a one-line note saying why the
finding does not hold.

**The evaluator** never edits. It reads the diff against four questions, in this
order, because a change that fails an earlier one is not worth grading on a
later one:

1. **Does it address the issue?** Point at the specific claim in the issue and
   the specific hunk that answers it. An unaddressed point is the only finding
   that can fail a round on its own.
2. **Is it simpler than what it replaced?** A fix that adds a branch where
   deleting one would do is not finished. Special cases, flags and defensive
   copies are where this usually goes wrong.
3. **Is it consistent?** With the surrounding file first, then the package. Same
   naming, same error handling, same test style.
4. **Does it follow the repo's patterns?** Composition API and `<script setup>`,
   Vuex/Pinia where the neighbours use it, existing components rather than new
   ones, `@shell` imports, i18n keys rather than literals.

The evaluator's verdict is one of **PASS** or **CHANGES**, and CHANGES must come
with findings that name a file and a line. "Could be cleaner" is not a finding.

## The loop

Run it as an actual loop, not one pass with a review bolted on:

1. Implementer works. It reports what it changed and why.
2. Evaluator reads the resulting diff (`git diff`) with the issue in hand and
   returns PASS or CHANGES with findings.
3. On CHANGES, hand the findings straight back to the implementer and go again.
4. On PASS, stop and report.

Stop early and say so if the loop stops converging — the same finding surviving
two rounds means the two agents disagree about what the code should be, and that
is a decision for the person running this, not something to iterate at.

Cap it at **five rounds**. If it is not right by then, report where it stands,
what the outstanding findings are, and what you would do next.

## Running the agents

Spawn them with the Agent tool, one per role, and keep the roles apart —
the value here is entirely in the evaluator not being the author:

```
Agent(subagent_type: "general-purpose", description: "implement",
      prompt: "<issue> <current diff> <findings from the last round> …")

Agent(subagent_type: "general-purpose", description: "evaluate",
      prompt: "You are evaluating, not editing. <issue> … return PASS or
               CHANGES with findings that name a file and a line.")
```

Give the evaluator the issue text every round. An evaluator working from the
diff alone drifts into style review, and style was never the point of this.

## Finish

Report: how many rounds it took, what the evaluator's last verdict was, and the
findings that survived if you stopped short. Then the diff is ready for
`my-fix-verify` and a commit — this skill refines a change, it does not test it,
and a PASS here is not evidence that anything runs.
