---
name: letmecode-release
description: Prepare and publish a new letmecode npm release from /home/ivan/code/letmecode. Use when asked to bump the version, verify the package, smoke-test the TUI, check the live npm version, or publish letmecode.
---

# Letmecode Release

1. The release skill remains in this repo path, but its executable source of truth is `./release.sh`. Do not copy or maintain a second implementation under `~/.codex/skills`.
2. Run `./release.sh` from `/home/ivan/code/letmecode` whenever release work is requested.
3. If the script prints an npm approval hyperlink during `npm login` or `npm publish`, open it, finish the approval, and let the same terminal session continue.
4. Use the script's final summary when reporting the version, publish result, git tag result, and passed checks.
