# mcp-gpt-image

[Português](README.pt-BR.md)

MCP server that lets Claude Code generate and edit images with GPT Image through your local Codex CLI. It uses your ChatGPT login, so no OpenAI API key is needed.

Claude writes the prompt, Codex passes it to its built-in `image_gen` tool, and the image is saved in your project and returned to Claude inline.

## Requirements

- Node.js 18.17 or newer
- git (npx downloads this package from GitHub)
- Codex CLI, signed in with a ChatGPT plan that includes image generation:

```bash
npm install -g @openai/codex
```

```bash
codex login
```

## Install

```bash
claude mcp add --scope user gpt-image -- npx -y github:Monayzera/mcp-gpt-image
```

Same command on macOS, Linux, WSL and Windows. Run `claude mcp list` to confirm it shows `gpt-image: ... Connected`.

If Claude Code on native Windows cannot start the server, add it through `cmd /c`:

```bash
claude mcp add --scope user gpt-image -- cmd /c npx -y github:Monayzera/mcp-gpt-image
```

## Use

Ask Claude for an image:

> Generate a 3:2 product photo of a matte black coffee grinder on a concrete counter, soft window light, using gpt-image.

> Edit `assets/logo.png`: keep the shape, make the background transparent.

## Tools

### generate_image

| Parameter | Default | Description |
| --- | --- | --- |
| `prompt` | required | The image prompt. |
| `count` | `1` | Images from the same prompt, 1 to 4. Each one uses your quota. |
| `transparent_background` | `false` | PNG with transparent background. |
| `reference_images` | none | Local images to edit or use as references (PNG, JPEG, WebP, GIF). Absolute or relative to the project. |
| `prompt_mode` | `exact` | `exact`: prompt reaches GPT Image unchanged. `enhance`: the Codex model rewrites it first. |
| `model` | Codex config | Codex model that relays the request. |
| `reasoning_effort` | `low` in exact mode | Reasoning effort for that model. |
| `output_path` | `<project>/generated-images/` | A `.png` file path or a directory. |

The result has the saved path, image size, the prompt that actually reached GPT Image, and your remaining 5-hour and weekly limits.

### codex_status

Shows the Codex path and version, sign-in state, usage limits with reset times, and the models with the reasoning efforts each one accepts.

## Prompt modes

In `exact` mode Codex is told to call `image_gen` with your text, character for character. The prompt that reached GPT Image is compared with yours and the result says whether they match.

The Codex model and reasoning effort do not draw the image. They only matter in `enhance` mode, where the model writes the final prompt. Use a stronger model and higher effort there for complex scenes.

## Files

- Default name: `generated-images/2026-10-14_120030_a-minimalist-flat-illustration-of-a.png`
- Several images get `_1`, `_2`, ...
- Existing files are never overwritten. A `-2`, `-3`, ... suffix is added.
- Codex also keeps its own copy in `~/.codex/generated_images/`.

## Settings

| Variable | Use |
| --- | --- |
| `CODEX_PATH` | Full path to the `codex` executable when it is not on `PATH`. |

Example:

```bash
claude mcp add --scope user gpt-image -e CODEX_PATH=/opt/codex/bin/codex -- npx -y github:Monayzera/mcp-gpt-image
```

## Troubleshooting

| Message | Fix |
| --- | --- |
| `Codex CLI was not found` | Install Codex, or set `CODEX_PATH`. |
| `Codex is not signed in` | Run `codex login`. |
| `usage limit reached` | Wait for the reset time shown by `codex_status`. |
| Tool call moved to background | Normal. Claude Code backgrounds MCP calls longer than 2 minutes and delivers the result when it finishes. |

## How it works

1. On the first call the server starts `codex app-server` (JSON-RPC over stdio) and keeps it running.
2. Each request opens an ephemeral, read-only Codex thread whose instructions are to call `image_gen` with the prompt.
3. Codex reports each `imageGeneration` item. The server writes the PNG to disk and returns it with the usage limits Codex reports.

## License

MIT
