# Security

Do not post credentials, private workspace contents, or unredacted logs in public issues or pull requests.

If GitHub's private vulnerability reporting is enabled, use the repository's Security tab to report a vulnerability privately. If it is unavailable, open an issue requesting a private reporting channel without disclosing vulnerability details.

BotLogik runs local tools with the user's permissions. Scheduled runs bypass CLI permission prompts. OpenRouter command approvals are not an operating-system sandbox. Use trusted workspaces and review proposed commands.

OpenRouter API keys are encrypted at rest through Electron safeStorage. Conversation files and tool output are stored locally without encryption. See README.md and docs/openrouter.md for storage and provider data flows.
