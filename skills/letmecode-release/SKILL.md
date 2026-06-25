---
name: letmecode-release
description: Prepare and publish a new letmecode npm release from /home/ivan/code/letmecode. Use when asked to bump the version, verify the package, smoke-test the TUI, check the live npm version, or publish letmecode.
---

# Letmecode Release

1. The source of truth for this skill is this repo path: `skills/letmecode-release/`. Do not edit or create the release skill under `~/.codex/skills` when changing this project.
2. Check npm auth first with `npm whoami`. If it returns `401`, run `npm login` in a PTY with `BROWSER=true` and finish auth before doing any other release work.
3. Check the live version with `npm view letmecode version`.
4. Read the local version from `package.json`.
5. Verify in this order before changing the version:
   - `pnpm test`
   - `npm pack --dry-run`
   - `pnpm start` in a PTY, wait for the dashboard, then quit with `q`
6. After auth and verification pass, bump `package.json` patch version to one patch above the higher of the live npm version and the current local version. Never publish the current version unchanged. Keep `bin.letmecode` as `./bin/letmecode.js`.
7. Commit after bump with `git commit -am "Bump version to $VERSION"`.
8. If `npm login` or `npm publish` prints an approval URL like `https://www.npmjs.com/auth/cli/...`, keep the PTY session alive and return it to the user as a clickable Markdown link such as `[Approve npm publish](https://www.npmjs.com/auth/cli/...)`. Never return the URL as plain text only. Ask the user to confirm when done, then resume the same session.
9. Publish with `BROWSER=true npm publish` in a PTY.
10. After a successful publish, create a git tag for the released version with `git tag v$VERSION`.
11. In the final reply, state the version, whether publish succeeded, whether the git tag was created, and which checks passed.
