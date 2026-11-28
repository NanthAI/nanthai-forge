# Agent recovery

Use the recorded outcome and the Lane or operation it names. Commands use the actual project or Lane
folder and any IDs Forge already has.

| Situation | What Forge knows | Action that makes progress | When to stop or ask |
| --- | --- | --- | --- |
| My change landed and I want to make a follow-up. | The original Lane completed, and its landing has a retained receipt. | Start a new Lane for the follow-up. | Stop when the receipt answers the original request. |
| I have edits in a completed Lane checkout. | The Lane ended and the local edits are still in that checkout. | Reopen the selected Lane from its checkout. | Continue with the existing edits once the Lane is active. |
| My landing is waiting behind a stalled landing. | The operation is live and its progress stopped. | Inspect the queue and observe the pinned operation. | Follow a recorded repair command if Forge names one. Ask the blocker’s owner for an update if it persists. Resume the pinned wait when progress resumes. |
| My landing was cancelled. | Its operation is terminal. The reply may lack evidence about which files main changed. | If main changed files the Lane touches, sync that Lane first. Otherwise submit a fresh landing with the original inputs. | Resolve any conflict reported by sync before resubmitting. |
| I ran a Lane action from the wrong folder. | The action needs the Lane checkout. Forge may know the Lane ID even when the checkout is missing. | Use the Lane checkout, or open the selected Lane from the project folder if it is missing. | Select a Lane if the reply cannot identify one. |
| I asked to start a Lane in an occupied checkout folder. | The folder already belongs to a Lane. Forge may already have a receipt for the new Lane. | Use the given start command with the default placement or the new location for its retained Lane. | Keep the existing checkout and continue in the folder the new start returns. |
| I requested urgent priority without the required authority. | The request was refused and the submission keeps its priority. | Observe the existing submission. | Ask an authorized project member if the work needs urgent priority. |
| My planning cursor no longer matches the read. | The cursor belongs to another selection or Work generation. | Restart planning with the current filters and omit the cursor. | Continue with the cursor from that new selection. |
| My planning Item version is stale. | The version pin no longer matches the recorded Item. | Read the selected Item to get its current pin. | Reassess the change against the returned Item before submitting it. |
| I tried to complete an abandoned Lane. | The Lane already ended as abandoned. | Read that Lane's status if its state is needed. | Stop trying to complete the abandoned Lane. |
| I tried to resolve a Lane without a pending resolution. | The selected Lane has no pending resolution to finish. | Read the selected Lane's status. | Resolve only the Lane that has a pending resolution. |
| I asked for an unknown help topic. | The topic has no help entry. | Open the agent help overview. | Choose a topic or action from the overview. |
| I need current context for an agent briefing. | The briefing has recorded IDs for the selected work. | Run the `records` or `status` command printed in the briefing. | Work from the returned context. |
| I received a Lane handoff. | The handoff or ownership is recorded for the selected Lane. | Read the Lane's board. Use `start --open` with `takeover:true` when an ownership transfer is needed. | Obtain any requested approval before taking ownership. |
| I want to land sibling Lanes together. | A selected Candidate identifies its participants. An Intent lists its Lanes. | Save the selected participants, then use `land --save` with their IDs in `inputs`. | Choose the participating Lanes if the selection is missing. Follow the Candidate's check and acceptance outcome. |
| I tried to observe without a target. | This machine may have retained an operation for the current Lane. | Observe that operation by ID. When none matches, choose from the listed IDs. | Stop when the selected operation has the outcome you need. |
| There is nothing to land. | The submission introduced no source change. | Inspect the selected Lane's diff. | Stop if the intended change is already on main. |
