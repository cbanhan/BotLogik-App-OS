# OpenRouter in BotLogik

OpenRouter is a third, manual agent option alongside the existing Claude Code and Codex terminals. It uses native text chat and local tools; no additional CLI or dependency is installed.

## Use

1. In Settings → OpenRouter, choose **Create API key**, create a key on OpenRouter, and paste it into **API key**. **Connect key** validates it before saving. The key field is cleared after submission.
2. Open a connected workspace and choose **OpenRouter**. Click the model picker and type a model name or provider/model ID to filter it. Choose a result with the mouse or arrow keys and Enter. The selection is saved for this connected workspace and preselected on future launches, including after restarting BotLogik. Only models advertising tools and text output appear.
3. Type **@** in the message box to search text/code files in the connected workspace. Select with the mouse or ↑/↓ and Enter/Tab; Escape dismisses the picker. Full relative paths distinguish duplicate filenames. Mentions such as `@src/main.js` or `@"docs/My notes.md"` add removable file chips. On send, BotLogik reads the saved disk contents and includes them with the prompt. Unsaved editor changes are flagged, and sending those disk versions requires confirmation. Missing, ignored, binary, invalid UTF-8, or oversized files block the send and preserve the draft. Sent file snapshots can be expanded in conversation history.
4. Review each file replacement or command and choose **Allow once** or **Deny**. Reading/searching permitted workspace files does not prompt. Commands explicitly show that they run with the user's permissions, without a sandbox.
5. **Stop** cancels the request, resolves pending approvals, and kills the running command's process group. Completed writes remain on disk. **New Chat** and **End Session** are always visible in the chat header. **New Chat** starts fresh with the agent’s saved model; during a run it becomes **Stop & New Chat**. **End Session** stops the active run and returns to the agent choices. Both keep saved conversations in history and ask before discarding an unsent draft. Choosing a different model while viewing a conversation starts a new chat and keeps the original in history. Opening OpenRouter after an app restart starts a new chat with the saved model; the conversation dropdown reopens older chats explicitly. Unavailable saved models are identified and require a new selection.

Conversations are separate from the Claude/Codex Recent Chats list. This implementation supports text chat and manual runs; image attachments, scheduled OpenRouter runs, MCP integrations, token streaming, and automatic context compaction are not included. Existing terminal attachment controls are disabled while the OpenRouter panel is open. Responses appear after each model request completes; tool requests/results appear as the loop progresses.

## Runtime and storage

- `src/main/openrouter.js`: API client, encrypted key storage, model catalogue, conversation persistence, agent loop, approval ownership, usage totals, and cancellation. No automatic API retries, including failed writes or billed model requests.
- `src/main/openrouter-tools.js`: list/read/search/write tools and shell execution. File paths must be relative, stay within the canonical workspace, and cannot traverse symlinks. Secrets/dependency directories such as `.env`, `.ssh`, `.agent-logik`, `.git`, and `node_modules` are excluded from file tools (`.env.example` remains readable). These exclusions are not a shell sandbox.
- `src/main/openrouter-ipc.js`: main-window checks, connected-workspace checks, sender-scoped approvals and cancellation, and window-destruction cleanup.
- `src/renderer/openrouter-chat.js` and `openrouter.css`: native chat, settings, saved conversation selection, approvals, and usage display. `openrouter-mentions.js` provides file autocomplete and attachment chips; `src/main/openrouter-files.js` validates and reads disk snapshots. Model content is rendered as text, never HTML.

The API key is encrypted through Electron `safeStorage`, stored in `~/.agent-logik/openrouter/key.json` with mode 0600, and never returned to the renderer. Plaintext Linux fallback encryption is rejected. The workspace’s selected model is stored in `preferences.json` alongside its conversations. Chat files are local JSON, mode 0600, under a hash of the canonical workspace path in that directory; they include messages and tool output and are not encrypted. Writes use temporary files and atomic rename. Interrupted tool calls are repaired with an explicit uncertainty message on resume, so the model must inspect the workspace rather than assume success or repeat an action.

Messages, relevant file contents, tool results, and model reasoning metadata are sent to OpenRouter/the selected provider. The API key is supplied only in the authorization header to the fixed OpenRouter API origin; redirects are rejected. Shell processes receive a limited system environment, not the app's full environment or the saved OpenRouter key.

## Bounds and conflicts

- Default 12 model requests per user turn; selectable from 1–30. This is a request limit, not a dollar budget. Use OpenRouter account/key spending limits for a financial cap.
- Up to 4,096 output tokens per request (or the model's lower limit). Actual token usage and available reported cost accumulate per conversation; provider-specific fees can vary.
- Network requests time out; shell commands stop after 120 seconds, retain up to 30,000 output characters, and clean up their process group. Long-lived servers are unsupported.
- File mentions: up to 8 files, 50 KB per file and 100 KB total (and within the conversation context bound). The main process resolves the paths and revalidates them at send time. The picker respects BotLogik’s global file ignores plus the local tool exclusions; searches scan at most 5,000 entries, 12 folder levels, and return up to 50 matches with a limited-results indicator. It does not parse repository `.gitignore` rules.
- Read/write tools support files up to 100 KB. Existing writes require the SHA-256 from a prior read, checked again after approval; hard-linked files cannot be overwritten. Users still need to consider unsaved editor drafts when approving edits; the existing editor conflict flow remains in place.
- Searches inspect up to 1,000 entries and return up to 100 matches. Directory listings return up to 500 entries.
- A bounded conversation size stops the run and asks for a new chat rather than silently dropping context. Smaller provider context limits can still produce a provider error.
- Only one OpenRouter run per canonical workspace. Existing terminal sessions must be stopped before an OpenRouter run. Terminal launches and scheduled runs cannot start in a workspace with an active OpenRouter run. Active OpenRouter runs block update restart and participate in sleep prevention.

## Validation

From `botlogik-app/`:

- `npm test`: runtime/tool tests include encrypted key handling, model filtering, API errors, reasoning metadata continuity, history/usage, request limits, concurrent runs, approval ownership, denial, cancellation, path restrictions, stale writes, and command cleanup.
- `npm run test:openrouter`: builds and runs an isolated Electron renderer smoke test with a simulated API. Covers model selection, approval, workspace switching, history, cancellation, safe content rendering, and key clearing; spends no credits.
- `npm run test:workspace`: existing workspace/editor/terminal regression smoke test.

Before release, connect a real OpenRouter key in a signed build and verify one model can read a disposable project, propose an edit, run a test after approval, and resume the saved conversation after relaunch. Real provider billing, provider-specific tool behavior, and signed-app Keychain persistence require that live check.

## References

- [OpenRouter client tools](https://openrouter.ai/docs/guides/features/tool-calling)
- [OpenRouter model catalogue](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

## History retention and response formatting

OpenRouter history has a searchable conversation dropdown with Pin/Unpin and Delete icons on each saved chat row. Manage any thread without opening it; pinned chats appear in a dedicated Pinned section above Recent chats. Delete asks for confirmation and permanently removes the thread, including its saved file snapshots. It does not delete workspace files or the agent's saved model preference.

Unpinned conversations expire after 30 days since their last activity (`updatedAt`). Cleanup scans all OpenRouter workspace stores at application startup and hourly while BotLogik runs. Pinned chats and workspaces with active runs are skipped. Pinning does not reset the inactivity clock; an already-stale chat becomes eligible at the next cleanup after unpinning. This policy does not affect Claude or Codex history.

Assistant responses render Markdown headings, emphasis, nested lists, quotes, code blocks, tables, and HTTP(S) links. User messages, attachments, tool results, and approval proposals remain literal text. Rendering uses [Marked](https://marked.js.org/using_advanced) followed by a narrow [DOMPurify](https://github.com/cure53/DOMPurify) allowlist; remote images, scripts, styling, and form controls are excluded. Links open in the system browser through a validated IPC handler.
