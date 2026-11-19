# Flow Spec 20: Control what acts for me

**Goal:** A person wants to see every device, sign-in and agent session acting for them, know what each may reach, and cut one off when it should stop.
**Covers:** R19, R27

---

## Entry Points

- **From the account:** Devices.
- **From a Lane:** the holder's session name opens its device and person.
- **From an alert:** an unfamiliar device approval links here.

---

## The Flow

### Step 1: See devices

**What they want:** A list of the machines that act for them.

**What they see:** Devices: each device by its name and stable short code, its reach (one project or all), its settings (for example agents on this machine may write), when it was last used, and its live sessions ("SESSION and 13 more" (draft copy) when many).

**What they do:** Open a device.

**What happens:** The device's page opens.

### Step 2: See sessions

**What they want:** To know which agents are working right now.

**What they see:** The device's live sessions: session name, app, how the name was derived (app thread id, declared, or process), and the Lane each holds. Sessions quiet for 30 minutes fold into Activity.

**What they do:** Stop a session.

**What happens:** The session's next call is refused with a reason; its Lane keeps its saves and has no holder; the stop is recorded.

### Step 3: Change a device

**What they want:** Less reach, or a clearer name.

**What they see:** Rename, change reach, change settings.

**What they do:** Change one.

**What happens:** The change applies at the device's next call and is recorded; settings survive a new sign-in on the same device.

### Step 4: Sign out or remove

**What they want:** To stop a device for now or for good.

**What they see:** Sign out this device (it returns only after the person signs in again) and Remove (its settings go and its sign-ins stop).

**What they do:** Press one.

**What happens:** The device is signed out or removed; Undo is offered for sign out only.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| A second session tries to write a Lane another session holds | It is told who holds it and must take over explicitly with a reason; the takeover is recorded. |
| A session resumes after dying | It keeps its name when its app keeps the thread id; otherwise it gets a new name and can take its Lane back, recorded as a hand-over. |
| A device idle past 30 days | Its sign-in has expired; one press in the browser brings it back with settings kept. |
| No devices yet | Devices says no terminal is signed in and shows the sign-in command. |
| The owner views another person's device | They see its short code and approval date, not its name. |
| Loading | Device rows keep their space while loading. |
| Stopping a session failed | The session stays and a notice offers to try again. |

---

## UX Notes

- Sign-ins hold access; sessions are live presence, not access rows.
- Work identity is the Lane: every change of holder is recorded.
- Who may stop a session: its own person; the project owner for any session on the project.

---

## Prototype Scope

- Devices with three devices and their settings.
- A device with 14 live sessions.
- A session stopped, and its Lane with no holder.
- The takeover prompt for a second session.
- The expired-device return.
