# Devices, sign-ins and Lane holders

Your account has access. A device uses that access, a sign-in proves it, and a session records who is doing the work.

## Check the account and deployment

```sh
nforge auth status DEPLOYMENT_URL
```

Check the deployment as well as the account. Open **Account → Sign-in and devices** (`/account/devices`) to see this account's devices and manage the reach of a specific device. The [sign-in steps](../quickstart.md#sign-in) cover terminal approval and reconnecting.

## Keep the three records separate

A device is the stable identity of a terminal or browser. A sign-in is its credential. A session is a live thread working for a person. Stopping a session, signing a device out and removing it have different effects; read the effect shown by the current control. A device name grants no access.

Use [the generated reference](../reference/cli.md) for supported Lane commands and the Lane's current receipt for recovery. Manage teammates in the project's **Settings → People and access**. Manage what a terminal can do from its device entry in **Account → Sign-in and devices**.

For the device that will manage a project's secrets, see [Sign in and check the device](secrets.md#sign-in-and-check-the-device).

## Look at the recorded work

```sh
nforge agent ROOT status '{"laneId":"LANE_ID"}'
nforge agent ROOT lane-history '{"laneId":"LANE_ID"}'
```

A refusal should name what did not save and where the local changes remain. Keep those changes and follow the exact recovery command. See [agent identity and client detection](../agents/workflow.md#agent-runs-and-client-detection), [access](../security.md) and [the current sign-in implementation](../development.md).

## Browse or share a public project

Open **Explore** to find public projects and browse a project's source and history. To find the project's address from a terminal, use:

```sh
nforge clone --find OWNER/PROJECT
```

To download the source with `nforge clone`, sign in first. Opening public pages in a browser works signed out.

A project owner changes visibility under **Settings → Project → Visibility**. Making the project public opens browsing to visitors. Under **Settings → Project → Plan**, choose **Members only** to keep Items, Initiatives and discussion within the project membership. Review the [public Plan rules](../planning.md#public-plan) and [project access](../access.md#what-each-role-may-do) before switching visibility.
