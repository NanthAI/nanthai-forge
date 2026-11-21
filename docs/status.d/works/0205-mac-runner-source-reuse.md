The Mac runner copies source directly from its same-volume machine object cache
and verifies each copy before running the check. Every Candidate gets a fresh
writable tree, with a full private install if a cached copy fails verification.
Synthetic checkout measurements are recorded on Issue 0eead5d7. The shared-runner
comparison with GitHub Actions remains open.
