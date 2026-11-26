### Preflight completion

`nforge agent LANE preflight` prints its operation ID and a local `wait` command
before the checks run. The checks continue if the shell closes. Run the printed
command once for the outcome. It waits on a local filesystem event and exits
with a `preflight result:` line and the run's exit status. If a harness stops
that wait early, the same command can recover the result. Use
`wait {"operationIds":["ID"],"timeoutSeconds":0}` to read it without blocking.

Use `preflight --no-wait` to get the wake command immediately or
`preflight --wait` to follow live output. The CLI uses the background wake by
default on clients that advertise one. The foreground invocation also returns
the full plan and receipt with `--detail`. The saved operation keeps the Lane,
source head, outcome, test count and elapsed seconds. Runs on working files are
marked as such. A failure keeps a short diagnostic and any local recovery
command the run supplies. Batched waits include the local outcomes under
`preflights`. The wake and later reads of a local outcome make no hosted requests.
