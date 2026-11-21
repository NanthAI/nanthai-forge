# Devices, sign-ins and Lane holders

Your account has access. A device uses that access, a sign-in proves it, and a session records who is doing the work.

## Check the account and deployment

```sh
nforge auth status DEPLOYMENT_URL
```

Check the deployment as well as the account. Use the **Sign-in and devices** (`/-/account/devices`) for the rebuilt account flow and the [current status](../status.md) for capabilities that are still being rebuilt. The [sign-in steps](../quickstart.md#sign-in) cover terminal approval and reconnecting.

## Keep the three records separate

A device is the stable identity of a terminal or browser. A sign-in is its credential. A session is a live thread working for a person. Stopping a session, signing a device out and removing it have different effects; read the effect shown by the current control. A device name grants no access.

The design calls for one holder per Lane and a recorded Resume, Takeover or Handoff. Those are not permission to invent a CLI command. Use [the generated reference](../reference/cli.md) for supported commands and the Lane's current receipt for recovery. `whoami` and holder handover recommendations remain **Proposed** until their owning implementation and owner decision are recorded. Device/session Pass 1 and Pass 2 recommendations remain **Proposed** where not decided; they are not current access policy.

## Look at the recorded work

```sh
nforge agent ROOT status '{"laneId":"LANE_ID"}'
nforge agent ROOT lane-history '{"laneId":"LANE_ID"}'
```

A refusal should name what did not save and where the local changes remain. Keep those changes and follow the exact recovery command. See [agent identity and client detection](../agents/workflow.md#agent-runs-and-client-detection), [access](../security.md) and [the current sign-in implementation](../development.md).
