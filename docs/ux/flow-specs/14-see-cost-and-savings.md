# Flow Spec 14: See cost and savings

**Goal:** A project owner wants to know what their agents' work costs in landings and CI minutes, whether it is getting better or worse, and what Forge saved against a plain one-full-run-per-change workflow.
**Covers:** R15, R10

---

## Entry Points

- **From Stats:** the project's place for figures.
- **From the account's Billing:** landings used against the plan's limit.
- **From an alert:** a speed or cost budget that broke links to Stats.

---

## The Flow

### Step 1: See the month

**What they want:** To know where they stand against the plan.

**What they see:** Billing in the account: landings this month against the plan's limit, as one figure and a bar of days, what counts (each Lane landed counts once; held, refused, failed and reverted landings count none), and the extra-landing limit they set.

**What they do:** Read it.

**What happens:** Nothing changes.

### Step 2: See the project's figures

**What they want:** The few numbers that tell them if work is healthy.

**What they see:** Stats: CI minutes per landing, share landed on the first check, median time to main, and minutes thrown away (with why: redone checks, cancelled checks), each with a trend over recent weeks.

**What they do:** Change the window, or open one figure.

**What happens:** The figure opens with its breakdown by week and the landings behind it.

### Step 3: See what was saved

**What they want:** To know what Forge saved them.

**What they see:** Saved: CI minutes against a stated baseline (one full check run per landing), and time to main, with the baseline and method one disclosure away.

**What they do:** Open the method.

**What happens:** The method explains the baseline and what is not counted.

### Step 4: Act on a high cost

**What they want:** To bring a cost down.

**What they see:** When another plan would cost less for their usage, a one-line note in Billing that says so; in Stats, the largest source of thrown-away minutes with a link to the checks behind it.

**What they do:** Open the checks, or change the plan.

**What happens:** The checks open in Lanes History; a plan change follows the billing flow.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| The first landings arrive before the first hourly summary | Stats shows today's live landing count. It says when the first figures usually appear and when the reporting day ends. A range trend needs figures for the selected period and the same number of days before it. |
| No CI minutes reported (own CI without timings) | Minutes read "not reported by your CI"; savings in minutes are not shown. |
| At the plan's limit | Billing says landings wait in the queue and saves carry on; nothing is checked until the limit changes. |
| Figures still loading | Each figure keeps its space and fills in once. |
| A read failed | The figure says it could not be read and keeps the last value with its time. |
| A window with no landing figures | Stats says there are no figures and offers a longer range if available. If today's live count reports zero and the window is today only, Stats says no landings were reported today. |

---

## UX Notes

- Numbers always carry a baseline and a window; nothing is a bare total.
- *(Pending Decision — Item 581bd373 questions 25 and 28: showing money beyond billing, and a GitHub comparison in the product.)*
- Tokens are not claimed until they can be measured.

---

## Prototype Scope

- Billing with landings against the limit.
- Stats with the four figures and trends.
- Saved with its baseline and method disclosure.
- The first-day, empty-window and not-reported states.
- The at-limit state in Billing.
