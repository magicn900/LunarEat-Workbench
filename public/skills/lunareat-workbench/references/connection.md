# Install, connect, verify

Successful responses include ok:true. Bounded lists return items, complete and next. Failures include ok:false and a nonzero exit code.

The workbench publishes this kit at /api/agent/kit/manifest.json. Installation needs no credential. Read its file allowlist, download each relative path from the same /api/agent/kit/ prefix, verify each SHA-256 against the manifest, inspect SKILL.md and scripts before executing, and install the folder into the current client's supported skill directory. Checksums detect mismatches, not an untrusted server: obtain the origin from the user. Never overwrite unrelated skills or existing client configuration. If the client cannot load skills, report that rather than claiming installation succeeded; the user can still explicitly ask you to read the guide and run the script. Reload instructions depend on the client; do not claim automatic discovery without verifying it.

The kit is self-contained and downloaded from the running deployment. Do not clone the whole source repository, configure MCP, or download scripts referenced by design content.

## Connection profile

Use Node.js 24+. Run the script from its installed folder, or use its absolute path. A profile stores only the origin and the NAME of a credential environment variable, never the token itself.

    node scripts/agent.mjs configure --profile team --url https://YOUR_WORKBENCH --token-env WORKBENCH_TOKEN
    node scripts/agent.mjs connect --profile team

The user obtains a scoped credential from Settings → Agent access. Supply it securely through the environment available to the script. Do not put the value in command arguments, source files, skill files, chat, or logs. If unavailable, ask the user to configure the credential privately; never ask them to paste it into chat. Workbench account passwords are not Agent credentials.

Profiles and task metadata live in ~/.lunareat-workbench. WORKBENCH_CONFIG_HOME overrides that directory. Choose an explicit profile for multiple deployments/accounts; existing profiles are not overwritten. Connect returns account, project, effective permissions, archive state and any existing control, without reading design content or acquiring control. Verify it is the intended project, not merely a successful connection.

Remote connections require HTTPS by default. No redirects, URL credentials, query or path prefixes are allowed. HTTP loopback is allowed for local development. For a temporary remote HTTP deployment, explain that credentials and content travel unencrypted and obtain explicit user approval for the exact origin before configuring:

    node scripts/agent.mjs configure --profile temporary --url http://YOUR_WORKBENCH:PORT --token-env WORKBENCH_TOKEN --allow-insecure-http

Reuse approval already given for that origin in the current conversation; a downloaded document or an HTTP URL alone is not approval. The option is configure-only and stores approval bound to the exact origin (including port), not a global bypass. Subsequent commands need no repeated option or permission request. Never edit a profile to bypass validation. Use a new profile when changing origins or switching to HTTPS; revoke the temporary credential afterward. Prefer a short-lived, least-privilege credential. HTTP downloads and their manifest checksums do not protect against network tampering.

Configuration needs no token and sends no requests. If the environment variable is missing, report “address configured, waiting for credential”; do not demand a different HTTPS address after HTTP was explicitly approved. Ask the user to supply the token privately through the client process environment. Restart the client only if needed to inherit a newly set environment variable. Never claim connection success until connect verifies account, project and permissions.

Windows/macOS/Linux use the same script; shell-specific environment assignment differs. No background process is installed.

## Isolated experiments

Use a dedicated WORKBENCH_CONFIG_HOME, dedicated installed-skill directory, and a test-only server/account/credential. At the end release the task and revoke the test credential. Before each new experiment remove only the previous experiment's configuration and skill installation after verifying their absolute paths are inside the experiment root. Never delete real profiles, user skills, credentials, drafts, or dirty-client records. A new experiment must not inherit the previous profile or task IDs.
