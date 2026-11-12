# Application context

BotLogik is a lightweight Mac workspace for AI-assisted development. It is an Electron application with an electron-vite renderer, node-pty/xterm terminals, Monaco editing, and a constrained IPC bridge. The current version is 1.1.0; package.json is the version source of truth.

## Scope and architecture

This repository is the standalone public application. All required source, tests, assets, and development scripts belong here. Do not introduce dependencies on a parent checkout, private website, personal workspace, credentials, or official release infrastructure.

Start with README.md. Main-process orchestration is in src/main/main.js; the IPC bridge is src/main/preload.js. Much of the renderer is in src/renderer/index.html, with supporting modules beside it. OpenRouter behavior and storage are documented in docs/openrouter.md.

The product is a focused workspace, not a full IDE or Git client. Keep Git operations read-only. Home is a dashboard for recent and scheduled activity. Preserve workspace boundaries, approval requirements for OpenRouter writes/commands, cancellation, and checks for unsaved edits and active sessions.

## Contribution policy

External contributions and pull requests are not accepted. Users who want modifications should fork the repository and maintain their own instance. See CONTRIBUTING.md.

## Working practices

- Use npm ci and the checked-in lockfile. Node.js 22 is the development baseline.
- Run npm test and npm run build for application changes. Run the appropriate Electron smoke test when changing workspace or OpenRouter UI behavior; use disposable workspaces and mock provider calls.
- Never commit credentials, real conversations, local attachments, user configuration, generated builds, or personal filesystem paths. Use synthetic fixtures.
- Keep context isolation and renderer IPC validation intact. Do not expose secrets to the renderer.
- Community packages must remain independent of official update feeds and signing credentials. Updates require an explicit package metadata opt-in from a separate official release configuration.
- Update user-facing documentation when behavior changes. Do not claim live provider or signed-release verification from mocked tests.
- Do not bump versions, publish releases, or push changes unless requested.
