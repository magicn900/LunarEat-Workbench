# Recovery and stopping conditions

All output is JSON. Nonzero exit means failure; inspect code, error, details and requiredAction. Never print environment values when diagnosing credentials.

| Result | Next action |
| --- | --- |
| CREDENTIAL_REQUIRED / HTTP 401 | Ask for private credential configuration or renewal. Do not try passwords, scrape secrets, or repeatedly retry. |
| HTTP 403 | Report missing permission or archived/deleted project. Do not request broader credentials automatically. |
| CONTROL_HANDOFF_PENDING | Script waits for at most about 10 seconds plus request time. Report waiting for Web save if still pending; retry identical input after the user resolves unsaved input. Never delete presence records. |
| WORKSPACE_LOCKED | Another editing task has control. Wait or ask user; do not release/revoke another task. |
| WRITE_SESSION_REVOKED / WRITE_SESSION_INTERRUPTED | Stop and report. Only after explicit user permission run agent resume --task ID, then read again before preparing new edits. |
| WRITE_SESSION_EXPIRED | Lease ended. Reread and reassess authorization; explicit resume is required before continuing, never auto-reacquire. |
| Conflict / stale preview / expected mismatch | Reread latest content and preserve human changes. Ask if intended resolution is unclear. A newly prepared edit needs a new requestId. |
| REQUEST_UNCERTAIN / HTTP 5xx | Do not assume nothing happened. Keep same task, command and input/requestId; retry exactly once, then stop and report uncertainty if unresolved. The script blocks a different controlled mutation while an uncertain one is pending. Read-only inspection remains available. |
| TASK_BUSY | Another local call owns this task. Wait; after a crashed process verify it exited before removing only that task's .lock. Never clean locks automatically by age. |
| TASK_CLOSED / TASK_IDENTITY_CHANGED | Do not reuse the task. Verify identity before creating a new task; this does not authorize bypassing server revocation. |
| CONFIG_EXISTS | Inspect non-secret profile or choose another name; do not silently replace. |

Release has no implicit new-session request. A release that fails because a human reclaimed control does not justify resume. At most a bounded retry for a genuinely uncertain request; never loop indefinitely. Report the last verified state and whether published content was affected.
