# letmecode - Discover your detailed agent ussage Codex | Claude

Ussage:

```bash
npx -y letmecode
npx -y letmecode -- -h
npx -y letmecode -- --log-to log.txt
```

`--log-to` now records Claude binary discovery, session-root selection, parsed transcript file summaries, entrypoint matching, raw `/usage` output, and live-window event matching so zero-token windows are diagnosable.

<img width="2308" height="1491" alt="image" src="https://github.com/user-attachments/assets/f3f52d79-00e3-4ff5-bf2f-65f8be632aaa" />

## Controls

| Key | Action |
| --- | --- |
| `[` / `]` | Switch providers |
| `Tab` / `Shift+Tab` | Switch providers when supported by the terminal |
| `Up` / `Down` or `k` / `j` | Switch dashboard sections |
| `Left` / `Right` | Select the previous or next table row |
| `Enter` | Run the selected provider action |
| `1` | Select the Copilot VS Code setup action |
| `h` / `l` | Select a Copilot setup action |
| `q` or `Esc` | Quit |
| Mouse click | Click a provider tab or a section tab to switch to it. Hold `Shift` while dragging to select/copy text anywhere else. |

## Copilot

Copilot CLI usage is read from `~/.copilot/session-state`.

VS Code extension usage needs file OTEL logging first. Select the `Copilot` provider, choose `Start logging VS Code` with `1` or `h` / `l`, then press `Enter`; letmecode will update the current user's VS Code settings with:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.outfile": "~/.copilot/otel/vscode.jsonl",
  "github.copilot.chat.otel.captureContent": false
}
```

## Local development

```bash
pnpm install
pnpm start
```
