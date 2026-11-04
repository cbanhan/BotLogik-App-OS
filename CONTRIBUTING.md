# Contributing

Fork the repository, create a focused branch, and follow README.md to install and run the app. Describe the problem, resulting behavior, and validation in your pull request.

Run `npm test` and `npm run build`. For workspace or OpenRouter UI changes, also run the matching smoke test documented in README.md. These smoke tests use isolated fixtures; do not use real API keys or private projects in test data.

Keep source, assets, and tests self-contained. Do not submit generated packages, dependency folders, signing identities, credentials, local logs, conversations, or screenshots showing private information. Review `git diff --cached` before committing. An ignore rule does not remove an already tracked file.

Source contributions are made under this repository's MIT license. Dependency code and assets retain their original licenses; include required attribution for anything added.
