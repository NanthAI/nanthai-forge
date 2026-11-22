"""Project a retained provider job ledger into the offline refit input."""

import argparse
import csv
import json
from datetime import datetime, timedelta

START = datetime.fromisoformat("2026-11-14T22:18:00+00:00")
END = START + timedelta(days=7)
FOREGROUND = {
    "landing-first", "landing-main-race", "landing-scoped-recheck", "landing-cohort-fallback",
    "landing-flake-retry", "landing-retry", "landing-needs-fix", "landing-culprit", "pre-queue",
}
SEED_DAYS = {137: 0, 311: 2, 571: 5}


def background(file):
    windows = {str(seed): [] for seed in SEED_DAYS}
    for row in csv.DictReader(file):
        purpose = row["purpose"]
        if purpose in FOREGROUND:
            continue
        started_at = datetime.fromisoformat(row["start_utc"])
        minutes = float(row["runner_wall_minutes"])
        if not START <= started_at < END or minutes <= 0:
            continue
        for seed, offset in SEED_DAYS.items():
            release = (started_at - START).total_seconds() / 60 - offset * 1440
            if release < 1440 and release + minutes > 0:
                windows[str(seed)].append([max(0, release), minutes + min(0, release), purpose])
    return windows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ledger", type=argparse.FileType("r"))
    args = parser.parse_args()
    print(json.dumps(background(args.ledger), separators=(",", ":")))
