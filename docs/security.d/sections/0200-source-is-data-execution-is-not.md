## Source is data, execution is not

Capture and analysis read untrusted repository bytes. They never run imports, hooks, manifests or package scripts. Source text, comments, Markdown and provider metadata stay data, including text written to address an agent. Rendered Markdown omits raw HTML and runs no JavaScript.

A check or Playbook runs repository code under your OS account. Lanes, Git worktrees, MCP credentials do not confine the file system, processes, network or other agent tools. There is no sandbox. Checks use the clean environment described below, and logs can contain anything the command prints. Local run records and exit codes are observations. Code with your OS authority can forge them.
