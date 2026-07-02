# LetMeCode

Terminal AI real-money value usage dashboard for Codex, Claude, Copilot, and Antigravity.

See your real $ usage data, inspect limits, see daily activity, and model-level token totals in a terminal UI.

## Quick start

```bash
npx -y letmecode@latest
```

## Privacy and anonymous reporting

By default, `letmecode` sends an anonymous usage summary which powers [aggregated real-world plans comparison](https://devforth.io/agents-for-code/).

The report includes aggregated limit-window percentages, token counts, plan/window metadata, the `letmecode` version, and a hashed user identifier when a provider exposes one. It does not send prompt content, usernames, email addresses, company names, or other directly identifiable personal information.

To disable anonymous usage reporting:

```bash
npx -y letmecode@latest -- --no-usage
```

## Options

```bash
npx -y letmecode@latest -- --help
npx -y letmecode@latest -- --log-to ./letmecode.log
```

`--log-to` records provider discovery details and raw usage parsing diagnostics so empty or unexpected windows are easier to debug.

## Providers

- Codex
- Claude
- Copilot
- Antigravity

## Preview

<img width="2301" height="1397" alt="letmecode preview" src="https://github.com/user-attachments/assets/c37d6847-9926-4977-8592-5cab8346a86f" />

## Local development

```bash
pnpm install
pnpm test
pnpm start
```
