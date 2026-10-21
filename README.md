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
- The TUI's global `warp 模式` row on the 模型 page can force every request to the current model, ignoring whatever model name the client sends.

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

- Four pages - 模型 Models / 供应商 Providers / 统计 Stats / 运行 Runtime - selected with `<-` `->` at the top. `<-` `->` also moves focus between the page list and its detail area.
- `up` / `down` select within the current page's list. On the 模型 page the right-hand `选中模型设置` block is focusable: `<-` `->` switches between the list and the block, `up` / `down` picks a row, and `Enter` changes it. The stats and runtime pages have no selection.
- `Enter` acts on the highlighted item: switching model and changing 运行 controls ask for confirmation (`Enter` confirms, `Esc` cancels); on the providers page it opens an action menu (edit / remove, remove asks again). `[ + 添加供应商 ]` starts `llmwarp add`.
- The 模型 page's `选中模型设置` block carries the four input-filter toggles, the 思考强度 row (default 不修改), and the global `warp 模式` row. `warp 模式` is still the `useClientModel` switch - 按客户端请求 honours the client's model name (`warp` / empty means the active model, `provider/model` means that model), while 统一用当前模型 ignores it. The inline hints under the row explain this; the mode confirmation restates the consequence.
- The 运行 page shows the daemon panel (状态 / 供应商 / 模型 / 版本 / 接入地址 / 启动时间 / 配置文件, plus 重启 daemon while it runs and 启动 daemon when it is down), the 反馈 panel (recent action results, not cleared by auto-refresh), and the 请求活动 panel (last-60-second metrics plus recent requests with `img×2 aud×1` / `rsn medium→high` summaries). If the running daemon is an older build, the 版本 row is marked 旧版本 and a hint line appears. `<-` `->` moves focus onto the restart button. When the terminal is short, recent requests and older feedback are cut first and the hidden count is shown; the button and the three metric lines stay.
- The stats page has a range selector cycled with `h`: 最近10条 / 近1小时 / 今天 / 近7天 / 近30天. 「最近10条」means each provider/model/endpoint's own latest 10 requests, not the global latest 10, so a busy upstream cannot hide the others. The target table (request count, error rate, TTFT, tok/s per provider/model/endpoint) and the totals block below it are both recomputed for the selected range; the sparkline always shows the last 30 days of daily tokens, with min/max/current marked.
- Only requests actually forwarded upstream are counted; routing failures are reported separately as 未发出 N. Cancelled clients count as 中断 and stay out of the error-rate denominator. End-to-end latency is deliberately not shown per target - answer length dominates it, which makes cross-provider comparison misleading.
- `r` refreshes (auto-refresh runs every 3 seconds), `q` or `Ctrl-C` exits without stopping the daemon. The UI only uses arrow keys plus `Enter` / `Esc` / `h` / `r` / `q`; there are no single-letter action shortcuts.

History is stored as JSONL under `~/.config/llmwarp/stats/YYYY-MM-DD.jsonl` and survives daemon restarts (30 days by default; `stats.retentionDays` configures it, `stats.enabled=false` turns collection off entirely). Expired files are pruned once at daemon startup - nothing scans or reads the directory while running.

> The 请求活动 panel on the 运行 page is in-memory and realtime (last 60 seconds, plus totals since this daemon started) and resets on restart; the stats page is historical and range-based. They intentionally do not share a definition.

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
| `llmwarp start` / `llmwarp stop` | start / stop the daemon in the background; `start` restarts a daemon left over from an older build |
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
- After upgrading or rebuilding the CLI, a running daemon may still be an older build (it cannot read newly added config keys): `llmwarp status` / `reload` / `use` / `edit` / `remove` print a warning, and the TUI marks the version row as 旧版本. `llmwarp start` stops that old daemon and starts the current version; `llmwarp reload` only re-reads config and does not restart the process.

### Input filter

Relays often cap the request body (`413 Request Entity Too Large`) and some upstreams cannot take images or audio at all. Per target - provider, model, or model + endpoint - llmwarp can remove media parts from the body before forwarding:

```jsonc
"providers": {
  "ark": {
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKey": "${ARK_API_KEY}",
    "inputFilter": { "image": true },        // every model of this provider
    "targets": {
      "doubao-seed-1-6": {
        "inputFilter": { "image": false },   // this model keeps images
        "endpoints": { "/responses": { "inputFilter": { "image": true, "file": true } } }  // …this endpoint strips them again
      }
    }
  }
}
```

- Four switches: `image` / `audio` / `file` / `video`; all default to `false`, so nothing is touched unless you opt in.
- The most specific layer wins as a whole: endpoint > model > provider. Layers are never merged field by field.
- Removed parts leave one note per content array in the first removed position, e.g. `[llmwarp: removed 2 images, 1 file]`. The request is still forwarded - llmwarp never rejects or answers locally.
- Only unambiguous media parts are removed (Chat `image_url` / `input_audio` / `file`, Responses `input_image` / `input_audio` / `input_file`). Multipart uploads, `computer_call_output` screenshots and `code_interpreter_call.outputs` pass through untouched.
- The stats JSONL row and the TUI activity panel show what was removed (`img×2 aud×1`); nothing else about the request changes.
- In the TUI, select the model on the 模型 page and toggle 图片过滤 / 音频过滤 / 文件过滤 / 视频过滤 in the `选中模型设置` block (`<-` `->` to the block, `up` / `down` to the row, `Enter` to toggle). It writes `providers.<p>.targets.<m>.inputFilter` and reloads the daemon.

### Reasoning effort

Some upstreams want an explicit thinking level; others reject or ignore the one the client sends. With the same three layers as the input filter, llmwarp can rewrite it before forwarding:

```jsonc
"providers": {
  "ark": {
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKey": "${ARK_API_KEY}",
    "reasoning": "passthrough",              // default: leave the request untouched
    "targets": {
      "doubao-seed-1-6": {
        "reasoning": "high",                 // this model always asks for high
        "endpoints": { "/responses": { "reasoning": "none" } }  // …except here, thinking is disabled
      }
    }
  }
}
```

- Values: `passthrough` (default — the body is not even parsed), or one of `none` (thinking disabled) / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`.
- In the TUI, move to the `思考强度` row in the 模型 page's `选中模型设置` block and press `Enter`. The right column becomes a 9-item list (`不修改` / `关闭` / 7 levels); `↑↓` moves, `Enter` writes `providers.<p>.targets.<m>.reasoning` and reloads the daemon, and `Esc` returns. `关闭` is only the label — the config value is `none`.
- Layering matches the input filter: endpoint > model > provider, first layer that sets `reasoning` wins as a whole.
- `/chat/completions` gets top-level `reasoning_effort`; `/responses` gets `reasoning.effort`. The equivalent field is deleted on the way, so a request never carries two conflicting values; every other path is untouched.
- llmwarp does not probe what the upstream supports and never substitutes a value: an upstream error is passed through as-is.
- The TUI activity row shows the rewrite, e.g. `rsn medium→high`.

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
