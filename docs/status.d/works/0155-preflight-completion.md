Standalone CLI preflight continues when its initiating shell closes. Its printed
local wait command wakes once on completion and recovers the run's exit status
and summary even when invoked after the run ends.
