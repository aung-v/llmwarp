# Interaction Guidelines

> Follow the existing terminal interaction style.

## Output

- Use `ok`, `warn`, `fail`, `info`, `hint`, `dim`, and `bold` from `src/ui.ts`.
- Use `✓`, `!`, and `✗` status markers consistently through the existing helpers.
- Use `dim()` for secondary details such as URLs, hints, latency, and non-urgent notes.
- Use `bold()` for the primary value in a line, such as a provider or model name.

Example:

```ts
ok(`已切换到 ${bold(providerName)} / ${bold(model)}`);
info(dim(`客户端接入地址 ${endpointUrl(config)}`));
```

## Prompts

- Use prompt wrappers in `src/ui.ts` instead of importing Inquirer directly into command logic.
- Mark the currently selected provider/model with a green `(当前)` suffix where the choice list has enough context.
- Keep searchable lists non-looping and paginated, as `selectModel` and the custom checkbox prompt do.
- Provide a manual-entry escape hatch when a provider model list may be stale; `selectModel` uses `__manual__` for this.
- Mask API key input with visible `*` feedback while avoiding plaintext echo.

## Flow Composition

- Prefer short, numbered wizard steps with `hint()` explaining each field.
- When a refresh or optional operation fails, preserve user input and print a warning rather than restarting the flow.
- Return early after `fail()` only when the user has already received the actionable reason.
- Keep exit behavior consistent: `ExitPromptError` should be handled by the top-level `run()` boundary in `src/cli.ts`.

## TUI Keys

Current persistent-TUI key map, kept in `src/tui/index.ts` and surfaced in the footer:

| Key | Action |
|---|---|
| `↑`/`↓`, `j`/`k` | Move the selection (also cancels a pending confirmation) |
| `Enter` | Enter the "switch model" confirmation |
| `m` | Enter the "switch model routing mode" confirmation |
| `y` | Confirm whichever intent is pending |
| `n`, `Esc` | Cancel the pending confirmation |
| `r` | Refresh state and catalog |
| `q`, `Ctrl-C` | Quit the TUI (the daemon keeps running) |

- Confirmations are two-step and intent-scoped: the prompt must restate the consequence (`切换为「统一用当前模型」？客户端请求的模型将被忽略。`), not just the action.
- While an action is in flight (`state.switching`), navigation and other action keys are ignored.
- Never render the daemon token or provider API keys; sanitize anything that comes from config or daemon state.

## Copy

- Keep user-facing copy in Chinese.
- Name concrete next commands, for example `llmwarp init`, `llmwarp add`, `llmwarp use`, or `llmwarp reload`.
- Do not expose provider API keys in prompt defaults, output, or error messages.
