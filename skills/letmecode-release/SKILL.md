---
name: letmecode-release
description: Prepare and publish a new letmecode npm release from /home/ivan/code/letmecode. Use when asked to bump the version, verify the package, smoke-test the TUI, check the live npm version, or publish letmecode.
---

# Letmecode Release

1. Verify in this order:
   - `pnpm test`
   - `npm pack --dry-run`
   - `pnpm start` in a PTY, wait for the dashboard, then quit with `q`
2. Check the live version first with `npm view letmecode version`.
3. Bump `package.json` to the next version. Keep `bin.letmecode` as `./bin/letmecode.js`.
4. Commit after bump with `git commit -am "Bump version to $VERSION"`.
5. If `npm whoami` returns `401`, run `npm login` and ask user to click the link to log in. npm login returns a link to authenticate user account at.

Important: ensure you run npm login in interactive mode so npm understands you are a human, otherwise it will quately fail with EOTP. You need to connect to interactive terminal. ALso SET Browser environment variable to your browser path, e.g. `export BROWSER=/dump`.
Attach to PTY, read a link https://www.npmjs.com/auth/cli/xxxx, from STDOUT and attach it in agent message to user (clickable markdown link), ask user to click the link to log in. 

6. Publish with `npm publish`, send user link to congirm.
npm publish returns same link as npm login, do same.

Important: ensure you run npm publish in interactive mode so npm understands you are a human, otherwise it will quately fail with EOTP. You need to connect to interactive terminal. ALso SET Browser environment variable to your browser path, e.g. `export BROWSER=/dump`.
Attach to PTY, read a link https://www.npmjs.com/auth/cli/xxxx, from STDOUT and attach it in agent message to user (clickable markdown link), ask user to click the link to log in. 

7. In the final reply, state the version, whether publish succeeded, and which checks passed.
