# Permission modes

Permission modes request the provider's sandbox and approval settings. Choose a mode in the
message composer; it applies to that thread. The permission status alongside it shows the
provider's last reported settings, which can differ from the requested mode.

On Codex, changing a thread's mode saves it without interrupting its current work or stopping its
agents. The native sandbox and approval policy change on the next turn.

On Codex, **Full access** also approves pending and later command, file and permission requests
for the current turn. **Auto-accept edits** does this for file changes only. **Supervised** stops
these automatic approvals. Choosing a different mode clears remembered approvals for the current
work. Questions and requests for information still wait for your answer.

**Auto** switches new approval reviews to Codex's automatic reviewer where its version supports
live changes. Already pending native reviews keep their original reviewer. Provider limits still
apply, and the last reported sandbox can differ from the mode chosen for the next turn.

Set the default for new threads in **Settings → General → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Requests unrestricted access with approval prompts disabled.                          |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

## Reported permissions and blocked approvals

Codex reports its sandbox, network access, approval policy and approval reviewer. T3 displays
these native settings separately from the selected mode and updates them when Codex reports a
change. **Permissions not reported** means no native report is available for the selected
provider; the mode alone does not confirm access. Providers that do not report their settings
also show this state.

Command rules, permission profiles and external restrictions can still block actions. For
example, a rule that requires approval for `git commit` blocks it while approval prompts are
disabled, even in **Full access**. The permission details explain this conflict. Enabling
prompts requires a mode that allows them.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, and Grok; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. On Grok, commands its review blocks come
to you for approval.

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Claude can still ask in **Full access** when its settings disable bypass permissions or require
approval for an action.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
