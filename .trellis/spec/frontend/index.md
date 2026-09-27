# Terminal Frontend Guidelines

> Conventions for the terminal UI (TUI), interactive prompts, and user-facing command output.

## Definition

The frontend of this project is a terminal interface built with Commander and Inquirer. It is not a browser or React application. Current TUI behavior consists of one-shot interactive command flows plus a default menu; a long-lived TUI dashboard is a separate planned task.

## Index

| Guide | Description |
|---|---|
| [Architecture](./architecture.md) | Where TUI code lives and how flows are composed |
| [Interaction Guidelines](./interaction-guidelines.md) | Prompt, output, navigation, and accessibility conventions |
| [State Management](./state-management.md) | Configuration, daemon, and interactive-flow state |
| [Quality Guidelines](./quality-guidelines.md) | Manual review and test expectations for terminal UX |
