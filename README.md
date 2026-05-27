# ZenProxy

A zero-dependency translation proxy that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) use **DeepSeek V4 Flash Free** model via [OpenCode Zen](https://opencode.ai).

Claude Code speaks Anthropic's Messages API. DeepSeek speaks OpenAI's Chat Completions API. **ZenProxy sits in the middle and translates.**

## Features

- **One executable, no dependencies** — compiled Node.js, runs on any Windows PC
- **Zero config** — prompts for API key on first run, writes Claude Code settings automatically
- **Live web dashboard** — real-time log streaming, restart/shutdown from browser
- **Auto-opens browser** — dashboard launches automatically as a standalone window
- **Fully self-contained** — no Python, no Node, no PowerShell required

## Quick Start

1. Download `ZenProxy.exe` from [Releases](https://github.com/NeoDevX72/zen-proxy/releases)
2. Double-click `ZenProxy.exe`
3. Enter your OpenCode Zen API key when prompted
4. Browser opens with the dashboard — proxy is running

In another terminal:
```bash
claude
```

Claude Code connects through `http://127.0.0.1:8080` automatically — settings are written for you.

## How It Works

```
Claude Code  ──HTTP──>  ZenProxy (:8080)  ──HTTPS──>  OpenCode Zen API
                            │
                            ├──  Translates Anthropic → OpenAI format
                            ├──  Manages API key from local file
                            └──  Serves web dashboard with live logs
```

## Dashboard

Visit `http://127.0.0.1:8080` (opens automatically):

- **Status** — green/gray indicator
- **Live logs** — real-time SSE streaming
- **Config** — API key, model, proxy URL
- **Restart / Shutdown** — full control from the browser

## Build from Source

Requires Node.js 18+ and `pkg`:

```bash
npm install -g pkg
git clone https://github.com/NeoDevX72/zen-proxy.git
cd zen-proxy
pkg proxy.js --targets node18-win-x64 --output ZenProxy.exe
```

## Files

| File | Purpose |
|------|---------|
| `ZenProxy.exe` | Standalone compiled proxy (36 MB, includes Node.js runtime) |
| `proxy.js` | Source code |
| `package.json` | Build configuration |
| `zen-key.txt` | Auto-created — your saved API key (keep secure) |
| `zen-proxy.log` | Auto-created runtime logs |

## License

MIT
