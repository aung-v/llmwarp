# llmwarp

> A local OpenAI-compatible router for LLM APIs. Point your client at `localhost` once, then switch providers and models with a single command.

Client base URLs and model names are usually hardcoded, so every provider change means editing config and restarting. llmwarp runs a small daemon on your machine that speaks the OpenAI protocol, and forwards each request to whichever provider you have currently selected.

[中文说明](https://github.com/aung-v/llmwarp/blob/master/docs/README.zh-CN.md)

![llmwarp TUI](https://raw.githubusercontent.com/aung-v/llmwarp/master/assets/llmwarp-tui.png)

## How it works

```
  OpenAI-compatible client            model rewritten,
  (Codex, SDKs, editor plugins)       provider key injected
              |                              |
              |  http://127.0.0.1:8787/v1    v
              +------------------------>  llmwarp daemon  ---------->  provider API
                                             ^      |
              <---- SSE streamed back -------+      |
                                             |
                                       loopback + token
                                             |
                                     llmwarp CLI / TUI
```

- The daemon binds `127.0.0.1` only, and never listens on external interfaces.
- The JSON body's `model` decides routing: `warp` (or omitted) uses your current selection, `{provider}/{model}` uses that provider's model. Anything else returns a local JSON error and is never forwarded.
- Upstream URL = `baseUrl` + the client path with its `/v1` prefix removed. `baseUrl` does not have to end in `/v1`: `https://api.deepseek.com/v1` with a request to `/v1/chat/completions` becomes `https://api.deepseek.com/v1/chat/completions`.
- Responses, including SSE, are streamed straight through - nothing is buffered.
- The provider and model are snapshotted when a request starts, so switching mid-flight never disturbs requests already running.
- The TUI's mode page can force every request to the current model, ignoring whatever model name the client sends.

## Install

Requires Node.js 20 or newer.

```bash
npm install -g llmwarp
npx llmwarp status       # no global install needed
```

From source:

```bash
npm install && npm run build && npm link   # global `llmwarp` from this checkout
npm run dev -- status                      # run the TypeScript sources directly
```

## Quick start

```bash
llmwarp init      # write a commented sample config
llmwarp add       # add a provider (presets: OpenAI, DeepSeek, OpenRouter, Ollama)
llmwarp use       # pick provider + model; starts the daemon if it is not running
llmwarp status    # show the current state
```

Then point your client at it:

| Client setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:<port>/v1` - see the address printed by `llmwarp status`; default port is `8787` |
| API Key | any non-empty string (e.g. `any`); llmwarp ignores it and uses the provider's key |
| Model | `warp` for your current selection, or any `{provider}/{model}` from `GET /v1/models` |

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"warp","messages":[{"role":"user","content":"hi"}]}'
```

The port is not hardcoded: the daemon uses `"port"` from the config file (`8787` if unset), and `llmwarp serve --port <n>` overrides it for a single foreground run. Starting the daemon and a successful `llmwarp use` both print the address actually in use.

## TUI

`llmwarp tui` opens the persistent management UI in the screenshot above.

- Four pages - 模型 Models / 模式 Mode / 供应商 Providers / 统计 Stats - selected with `<-` `->` at the top. `<-` `->` also moves focus between the left column and the daemon panel.
- `up` / `down` select within the current page's list. The stats page has no selection, only the `h` range switch.
- `Enter` acts on the highlighted item: switching model or mode and restarting the daemon all ask for confirmation (`Enter` confirms, `Esc` cancels); on the providers page it opens an action menu (edit / remove, remove asks again). `[ + 添加供应商 ]` starts `llmwarp add`.
- The mode page picks 按客户端请求 or 统一用当前模型, and the daemon panel always shows which one is active. The daemon panel also shows 重启 daemon while the daemon runs, and 启动 daemon when it is down.
- The stats page has a range selector cycled with `h`: 最近10条 / 近1小时 / 今天 / 近7天 / 近30天. 「最近10条」means each provider/model/endpoint's own latest 10 requests, not the global latest 10, so a busy upstream cannot hide the others. The target table (request count, error rate, TTFT, tok/s per provider/model/endpoint) and the totals block below it are both recomputed for the selected range; the sparkline always shows the last 30 days of daily tokens, with min/max/current marked.
- Only requests actually forwarded upstream are counted; routing failures are reported separately as 未发出 N. Cancelled clients count as 中断 and stay out of the error-rate denominator. End-to-end latency is deliberately not shown per target - answer length dominates it, which makes cross-provider comparison misleading.
- `r` refreshes (auto-refresh runs every 3 seconds), `q` or `Ctrl-C` exits without stopping the daemon. The UI only uses arrow keys plus `Enter` / `Esc` / `h` / `r` / `q`; there are no single-letter action shortcuts.

History is stored as JSONL under `~/.config/llmwarp/stats/YYYY-MM-DD.jsonl` and survives daemon restarts (30 days by default; `stats.retentionDays` configures it, `stats.enabled=false` turns collection off entirely). Expired files are pruned once at daemon startup - nothing scans or reads the directory while running.

> The 请求活动 panel on the right is in-memory and realtime (last 60 seconds, plus totals since this daemon started) and resets on restart; the stats page is historical and range-based. They intentionally do not share a definition.

## Commands

| Command | Purpose |
| --- | --- |
| `llmwarp` | interactive menu when run with no arguments |
| `llmwarp init [--force]` | write a commented sample config |
| `llmwarp add` | add a provider with a wizard |
| `llmwarp edit [provider] [--file]` | edit a provider, or open the config in `$EDITOR` |
| `llmwarp list` (`ls`) `[--offline]` | list providers and check availability |
| `llmwarp use [provider] [--model <m>] [--list] [--refresh]` | switch provider / model |
| `llmwarp status` (`st`) | config path, port, base URL, current provider and model |
| `llmwarp tui` | open the management UI |
| `llmwarp remove [provider]` (`rm`) | remove a provider |
| `llmwarp start` / `llmwarp stop` | start / stop the daemon in the background |
| `llmwarp serve [--port <n>]` | run the daemon in the foreground |
| `llmwarp reload` | make the daemon reload the config |

## Configuration

The config lives at `~/.config/llmwarp/config.jsonc` (XDG-aware: `$XDG_CONFIG_HOME/llmwarp` wins). It is JSONC, so `//` comments and trailing commas are allowed:

```jsonc
{
  "port": 8787,                      // listen port; defaults to 8787 when omitted
  "activeProvider": "deepseek",      // maintained by llmwarp use
  "activeModel": "deepseek-chat",
  "useClientModel": true,            // true: honor the model the client sends; false: always use the active one
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "${DEEPSEEK_API_KEY}", // ${ENV_VAR} interpolation keeps secrets off disk
      "models": ["deepseek-chat", "deepseek-reasoner"]
    }
  }
}
```

- After editing by hand, run `llmwarp reload`; `llmwarp edit --file` opens the file in `$EDITOR` and reloads on save.
- `models` is optional - without it, `llmwarp use` (or `--refresh`) fetches `<baseUrl>/models`.
- `GET /v1/models` returns `warp` plus every `{provider}/{model}`, and never exposes keys. Whatever the client sends must appear in that list, in either mode.
- Provider names cannot contain `/` (the first `/` is the routing separator), whitespace or control characters; model names cannot contain whitespace or control characters.
- The config file is written `0600` and its directory `0700`. Prefer `${ENV_VAR}` over plaintext keys.
- While the daemon runs: state in `~/.config/llmwarp/daemon.json` (holds the loopback admin token), logs in `~/.config/llmwarp/daemon.log`.

## Development

```bash
npm run dev        # run src/cli.ts through tsx
npm test           # node --test (test/*.test.ts)
npm run typecheck  # tsc --noEmit
npm run build      # bundle to dist/cli.js with tsup
```

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | command registration (Commander) |
| `src/commands.ts` | subcommand implementations |
| `src/config.ts` | config read/write, validation, paths |
| `src/server.ts` | daemon: proxy entrypoint + admin API |
| `src/proxy.ts` | forwarding, model rewriting, header handling |
| `src/daemon.ts` | daemon lifecycle and admin requests |
| `src/tui/` | the persistent TUI (state, rendering, keys) |
| `src/metrics.ts` | in-process realtime metrics (activity panel) |
| `src/stats/` | usage / performance / reliability stats: parsing, JSONL, aggregation |
| `src/health.ts`, `src/net.ts` | availability checks and port diagnostics |

Design and task notes live in `docs/` and `.trellis/`.

## Project status

A personal project that already does everything I need day to day. Without feedback, suggestions, or new requirements there will be no further releases - the code stays as it is. Issues and ideas are welcome; there is just no roadmap.
