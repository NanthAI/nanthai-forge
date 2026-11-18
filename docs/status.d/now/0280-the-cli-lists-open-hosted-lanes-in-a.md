The CLI lists open hosted Lanes in a single bounded page query (`agent ROOT lanes`),
records project friction without a Lane (`friction-list` pages it with its triage status; `x friction-triage` dismisses or links an Issue), diagnoses unaddressed roots and unavailable
cwd, queues local heavy commands first come, first served (waiters see their position and an estimate) and exposes holder and queue status by Lane without acquiring a slot.
