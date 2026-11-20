- Hosted source steps that run longer than the 60 s worker lease keep it by renewing it
  from inside the step. A fenced or failed step schedules its own retry, and the
  desired-landing watchdog resumes a step whose worker died, so source preparation
  no longer waits for a client lookup. Preparing queue entries show the source step
  and its last progress time.
