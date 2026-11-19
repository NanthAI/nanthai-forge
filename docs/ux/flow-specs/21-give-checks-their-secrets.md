# Flow Spec 21: Give checks the secrets they need

**Goal:** A project owner wants their checks and deploys to have the credentials they need, with no secret ever in the source, and to know who can read each one.
**Covers:** R20

---

## Entry Points

- **From Settings:** Secrets.
- **From a check that failed for a missing secret:** the cause links here.
- **From an agent's save that was refused:** the save named a credential it found.

---

## The Flow

### Step 1: See the secrets

**What they want:** To know what exists, without seeing values.

**What they see:** Secrets: names first, each with where it is used (which check or deploy), who can read it, and when it was last changed. Values are never shown.

**What they do:** Add a secret.

**What happens:** A form opens.

### Step 2: Add a secret

**What they want:** To store one value safely.

**What they see:** Name, value (hidden as typed), and where it may be used.

**What they do:** Fill it in and save.

**What happens:** The value is stored outside the source; the list shows the name and its use. The value cannot be read back, only replaced.

### Step 3: Use it in a check

**What they want:** The check to receive it.

**What they see:** For their CI, where the secret goes (the CI's own secret store for checks that run there) and the exact name to use; for Forge's runner, that it is passed to the named check only.

**What they do:** Follow the step for their CI.

**What happens:** The next check that needs it receives it.

### Step 4: When an agent saves a credential

**What they want:** The secret to never reach main.

**What they see:** On the Lane: the save was refused, with the file, line and kind of credential found (not its value), and what to do: rotate it if it was real, or add an allow entry for a test fixture.

**What they do:** Rotate it, or approve the allow entry.

**What happens:** The agent saves again without it, or the allow entry lands first and then the fixture.

---

## Edge Cases

| Scenario | What the user sees |
|---|---|
| No secrets yet | Secrets says none are stored and when checks need one. |
| A check failed for a missing secret | The cause names the secret and links to add it. |
| A scan override was used | The owner gets one alert naming who overrode it and where. |
| Saving the secret failed | Nothing was stored; the form keeps the name, not the value. |
| A secret's use is unknown | It reads "not used by any check yet". |
| Loading | Names load first; uses fill in after. |

---

## UX Notes

- Names first, values never shown.
- *(Pending Decision — journey 29 questions 1 and 3: scanning at save as well as landing, and whether Secret Objects are the store for checks.)*

---

## Prototype Scope

- Secrets with names, uses and readers.
- The add-secret form.
- The per-CI "where it goes" step.
- The refused save on a Lane with its two ways out.
- The empty state.
