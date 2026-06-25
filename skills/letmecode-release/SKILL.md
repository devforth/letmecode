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
5. If `npm whoami` returns `401`, run `npm login` and ask user to click the link to log in. npm login returns a link like Authenticate your account at:
https://www.npmjs.com/auth/cli/xxxx, you need to pass it and deliver to user. Also ensure you run npm login in interactive mode so npm understands you are a human. 

6. Publish with `npm publish`, send user link to congirm.
npm publish returns same link as npm login, do same.

7. In the final reply, state the version, whether publish succeeded, and which checks passed.
