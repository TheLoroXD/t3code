# Slack and Outlook in a persistent work browser

T3 agents can search and read Slack and Microsoft 365 mail, send plain text,
and inspect the Outlook day view through the browser UI. Each work account
uses one existing persistent profile. All its agents share one queued tab per
app, preserving both saved logins and Outlook's tab-local state.

This feature requires a T3 build containing the work-browser tools. The first
version needs its controls checked against your organization's current Slack
and Outlook pages before relying on it. If a control, sender, destination, date,
or time zone cannot be verified, the tool fails instead of guessing.

1. Open each work account in its own T3 browser profile on the server that will
   run the agents. Complete SSO manually. Obtain its profile ID from
   `preview_status`. An existing Edge profile on another machine is a separate
   session and is not imported.
2. Call `work_browser_configure` once for each account. Supply an account name,
   its persistent `profileId`, `slackUrl` containing the workspace name
   (for example `verato`) or URL, and that account's Microsoft 365 email.
   `outlookUrl` is optional and defaults to `https://outlook.office.com/mail/`.
   Slack follows its normal workspace and SSO redirects, then remembers the
   resulting workspace ID. Later pages must match that ID, including after a
   server restart. One profile cannot serve two work accounts.
3. Every subsequent tool call selects `account` explicitly. For example:

   ```json
   { "account": "verato", "query": "in:engineering release", "limit": 20 }
   ```

`work_slack_search` and `work_outlook_search` return references for
`work_slack_read` and `work_outlook_read`. References are bound to the configured
account and expire when the server restarts or old references are evicted.
Search again to refresh them. Results include their source, observation time,
and `partial`; rendered or truncated results are not a complete export.
Opening Outlook mail can mark it read. Composing can autosave a draft.
`browserThreadId` identifies the thread containing the shared work tab. Use
the work tools for agent actions; the human can open that thread to inspect it.

When authentication expires, tools return `auth_required`. The first response
has `notify: true`; later calls stay on hold without opening tabs or retrying
login. `authThreadId` identifies the thread containing the login tab. Complete
SSO there and release browser control, then call `work_browser_resume` with
the account and app. Login holds are held in memory; after a server restart the
first request checks the app again. Company SSO expiration still applies.

Send tools require an `operationId` that stays the same across retries of one
authorized send. The server records intent before clicking Send. `confirmed`
means the web UI showed a new Slack message or a fresh Outlook sent notification
with the composer closed. `send_unknown` means the result is ambiguous; inspect
the app manually. Repeating the operation returns its receipt without clicking
again. Do not use a different ID to retry an ambiguous send. Different content
with the same ID is rejected. Receipts contain hashes and status metadata;
message bodies and credentials are not stored in them.

The calendar tool reads one visible day and requires an ISO date and an IANA
time zone. It reports partial labels and fails if those cannot be checked. This
version does not create meetings, handle attachments, or export whole accounts.

Work-account configuration and send receipts live in the server's
`userdata/work-browser` directory with private permissions. Browser cookies
remain in T3's existing profile storage. These tools are exposed through T3's
MCP to its thread agents; they do not use Slack API tokens or Microsoft Graph.
