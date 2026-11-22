- Hosted source steps that run longer than the 60 s worker lease keep it by renewing it
  from inside the step. A fenced or failed step schedules its own retry, and a step
  whose worker died, or a fan-out batch queued past its lease, is repaired by its own
  wake at the lease end, so source preparation waits for neither a client lookup nor
  the desired-landing watchdog's backoff. Preparing queue entries show the source step,
  its last progress time and a failed attempt's cause; a stalled landing `wait` prints
  the stall, that cause and the replay. A runner source request answers slow object
  storage with 503 `reason: storage` inside the runner's 30 s timeout.
- `queue {submissionId}` reads earlier landing attempts and the current one, with
  retained phase durations and causes, including a source failure during recomposition.
  `queue {batchId}` shows a retained batch's phase and members.
  `queue {submissionId,attemptId}` shows the installed attempt's exact Candidate
  pins, a page of its retained Lane inputs, and stored check reuse proof or
  refusal evidence for that attempt. Each read is bounded and on demand.
