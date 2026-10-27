# How Forge improves

Our north star is to build the best source control for multi-agent work: people
and agents changing the same code at the same time, with accepted work preserved
and the next action clear.

Continuous improvement is part of the product. We use Forge to build Forge every
day. When a task takes extra retries, needs a script outside Forge, or forces a
human to reconstruct what happened, that is evidence worth keeping.

1. **Dogfood daily.** Follow real work from an intended outcome to accepted code.
   Study where people and agents spend time, lose context or repeat effort.
2. **Capture friction as data.** Record the problem, its area, cost when known,
   evidence and any workaround. Group repeated reports so frequency and cost can
   guide what to study next. A missing report does not prove a smooth workflow.
3. **Study prior art.** Understand how other systems solve the same problem and
   where their assumptions fit or fail. Borrow what works and test it here.
4. **Design for agents and people.** Start from concurrent work and clear source
   identities. Git compatibility is useful, but legacy source-control conventions
   do not define what Forge can become.
5. **Ship small, measured slices.** Choose a concrete problem, make a complete
   useful change, test failure paths and link it to the friction it addresses.
6. **Measure again.** Compare the actual experience with the original problem.
   Separate observed results from assumptions. Keep studying what remains and
   change direction when the evidence calls for it.

The [improvement loop](agents/improvement-loop.md) connects everyday reports,
triage and fixing Lanes. Rankings help us decide where to look; they do not make
product decisions or authorize new restrictions.
