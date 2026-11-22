"""Derive publication service draws from optional locally retained API responses."""

import json
from collections import Counter
from datetime import datetime
from pathlib import Path

from run import nearest


def interval(start, end):
    if start and end:
        a, b = datetime.fromisoformat(start).timestamp(), datetime.fromisoformat(end).timestamp()
        if a < b:
            return a, b
    return None


def response(directory, kind, ident):
    path = directory / kind / f"{ident}.json"
    return json.loads(path.read_text()).get("result") or {} if path.is_file() else {}


def service_samples(rows, directory):
    """Keep clean settlement and final moved-head composition; cap observed tails at p90."""
    commit, recompose = [], []
    coverage = Counter()
    for row in rows:
        coverage["receipts"] += 1
        ident = row.get("submissionId")
        submission = response(directory, "landing", ident).get("submission") if ident else None
        if not submission:
            coverage["missing_submission"] += 1
            continue
        timing = submission.get("timing")
        elapsed = interval(row.get("submittedAt"), row["committedAt"])
        if not timing or not elapsed:
            coverage["missing_submit_or_end_timing"] += 1
            continue
        a, b = elapsed
        compose = interval(timing.get("composeStartedAt"), timing.get("composedAt"))
        if row.get("mainMoved") and row.get("recomposeCount"):
            if compose and a <= compose[0] <= compose[1] <= b:
                recompose.append(compose[1] - compose[0])
            else:
                coverage["missing_move_timing"] += 1
        settle = interval(timing.get("settlementStartedAt"), row["committedAt"])
        if not settle or not a <= settle[0] <= b:
            coverage["missing_settle_timing"] += 1
            continue
        held = [interval(h["from"], h["to"]) for h in row.get("heldAfterCheck") or ()]
        blocked = any(lo < settle[1] and hi > settle[0] for lo, hi in filter(None, held))
        if not (blocked or row.get("orderWaits") or row.get("mainRedHolds")) and (
            not compose or compose[1] <= settle[0]
        ):
            commit.append(settle[1] - settle[0])
        else:
            coverage["blocked_settlement"] += 1
    service = {}
    for name, samples in (("commit", commit), ("recompose", recompose)):
        coverage[name + "_samples"] = len(samples)
        cap = nearest(samples, .9)
        if cap is None:
            raise ValueError(f"No {name} service samples in retained data. Coverage {dict(coverage)}")
        service[name + "_seconds"] = sorted(round(min(x, cap), 3) for x in samples)
    return {"service": service, "coverage": dict(coverage)}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("publisher", type=Path, help="directory containing retained landing responses")
    parser.add_argument("landings", nargs="+", type=Path, help="retained CLI landing pages")
    args = parser.parse_args()
    rows_by_id = {}
    for path in args.landings:
        for row in json.loads(path.read_text())["result"]["landings"]:
            rows_by_id[row["receiptId"]] = row
    print(json.dumps(service_samples(rows_by_id.values(), args.publisher), indent=2))
