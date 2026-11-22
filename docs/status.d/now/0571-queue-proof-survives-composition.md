Queue proof survives composition onto a moved main (Item ec229a55). A refreshed replay proof
records the top-level units its replay ran. It still holds when main changes only other units of a
covered file. A proof that main's change made stale refuses before any test job, at preflight or
in the hosted planner. The refusal names the files and the offline refresh, which re-runs only the
affected registered replays.
