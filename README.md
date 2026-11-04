# BotLogik

BotLogik is a lightweight macOS workspace for building apps and AI agents with Claude Code, Codex, and OpenRouter. It combines real terminals, project files, a focused editor, and read-only Git diffs in one window.

Current application version: **1.0.9**. This repository contains the standalone desktop application.

## Requirements

- An Apple silicon Mac. Other platforms and Intel packaging are not validated.
- Node.js 22 and npm (see `.node-version`).
- Git. Xcode Command Line Tools may be needed if native dependencies require compilation.
- For terminal agents, install and authenticate Claude Code (`claude`) and/or Codex (`codex`) separately. They must be on your shell's PATH.
- For OpenRouter, supply your own API key in Settings; no key is needed to build or run tests.

## Get started

```bash
git clone https://github.com/cbanhan/BotLogik-App-OS.git
cd BotLogik-App-OS
npm ci
npm run dev
```

Connect a disposable project folder first, then choose your agent provider. BotLogik uses your locally installed CLI tools and their authentication. The development command clears `ELECTRON_RUN_AS_NODE` to allow normal Electron startup.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the app in development mode |
| `npm test` | Run Node regression tests |
| `npm run build` | Compile Electron main, preload, and renderer code |
| `npm run test:workspace` | Build and run an isolated Electron workspace smoke test |
| `npm run test:openrouter` | Build and run an isolated OpenRouter UI smoke test with network requests blocked |
| `npm run dist` | Build unsigned Apple silicon community DMG and ZIP artifacts |

Packaging outputs go to `dist/`. Community packages use the **BotLogik Community** name and `com.botlogik.community` app identity. They are unsigned and not notarized, so macOS may block opening downloaded copies. Running from source with `npm run dev` is the supported contributor entry point. Signing credentials are not needed. Community builds have automatic updates disabled and never contact the official update feed.

## Features and permissions

- Workspace discovery, favorites, terminal sessions, and resumable provider conversations.
- File explorer, constrained text editor, image references, and Git status/diffs.
- Scheduled Claude/Codex runs and run history.
- OpenRouter chat with file mentions, tool approvals, and local conversation history.

**Scheduled runs bypass CLI permission prompts and run unattended with your user permissions.** Only schedule work in trusted workspaces. Manual CLI permissions are controlled by the provider. OpenRouter file writes and shell commands require approval, but approved commands are not sandboxed.

Configuration is stored in `~/.agent-logik/`. OpenRouter keys use Electron safeStorage encryption; conversation files contain plaintext messages and tool output. Development and community builds still share this application-managed configuration location with official builds. Use disposable workspaces for testing and back up existing configuration before experimenting. Provider requests may send prompts, referenced files, and tool results to the selected provider. See [OpenRouter details](docs/openrouter.md).

## Source layout

- `src/main/`: Electron main process, workspace services, PTY sessions, scheduling, updates, and OpenRouter tools.
- `src/main/preload.js`: constrained renderer IPC bridge.
- `src/renderer/`: application UI, styles, editor, and chat components.
- `src/shared/`: shared parsing and validation helpers.
- `tests/`: regression tests and isolated Electron smoke tests.
- `scripts/`: local build helpers; `assets/icon-source.png` is the macOS icon source.

Read [AGENTS.md](AGENTS.md) for contributor/AI coding context and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Vulnerability reporting guidance is in [SECURITY.md](SECURITY.md).

## License

Project source is provided under the [MIT License](LICENSE). Dependencies retain their own licenses. The license does not grant trademark rights in the BotLogik name or logo; identify modified distributions clearly and do not imply official endorsement.
