# mcp-gpt-image

[Português](README.pt-BR.md)

MCP server and skill that let Claude Code generate and edit images with GPT Image through your local Codex CLI. Uses your ChatGPT login. No OpenAI API key.

Claude writes the prompt. Codex passes it to its built-in `image_gen` tool. The image is saved to disk and returned to Claude inline. The skill makes Claude ask a short round of questions first (at most 4, only what changes the image), then review every image against a strict checklist and regenerate (up to 3 attempts) until it passes.

## Requirements

- Node.js 20 or newer
- git (npx downloads this package from GitHub)
- Claude Code
- Codex CLI, signed in with a ChatGPT plan that includes image generation:

```bash
npm install -g @openai/codex
```

```bash
codex login
```

## Install

```bash
npx -y github:Monayzera/mcp-gpt-image setup
```

This does three things:

1. Copies the skill (`SKILL.md` and `styles.md`) to `~/.claude/skills/gpt-image/` (or `$CLAUDE_CONFIG_DIR/skills/gpt-image/`).
2. Registers the MCP server in Claude Code at user scope, as `npx -y github:Monayzera/mcp-gpt-image` (on Windows, wrapped in `cmd /c`). If `CODEX_PATH` is set, it is passed to the server. An existing `gpt-image` entry at user scope is left unchanged; one in another scope is reported so you can remove it.
3. Checks that Codex is installed and signed in.

Restart Claude Code afterwards. `claude mcp list` should show `gpt-image` as connected.

Running `setup` again replaces the skill file with the latest version, including any local edits. npx fetches the newest commit on each start, so the server updates by itself.

To register only the MCP server, without the skill:

```bash
claude mcp add --scope user gpt-image -- npx -y github:Monayzera/mcp-gpt-image
```

## Uninstall

```bash
npx -y github:Monayzera/mcp-gpt-image uninstall
```

Removes the skill and runs `claude mcp remove gpt-image --scope user`.

## Use

Ask Claude for an image. The skill takes over: questions, prompt, generation, review, retries.

Questions come in one round of at most 4, each with a recommended option first. Claude skips anything your request already answers, and skips the round entirely when the request is complete or you say "no questions" / "sem perguntas".

> Make a 16:9 hero image for the landing page: a matte black coffee grinder on a concrete counter, soft window light.

> Edit assets/logo.png: keep the shape, make the background transparent.

To use a real logo, product or photo, paste or attach the image in the chat. Claude Code gives Claude its file path, and Claude passes it in `reference_images`.

`styles.md` holds prompt recipes for photo and illustration styles (phone snapshot, editorial, film, product, documentary, cinematic, flat vector, 3D, watercolor, comic, logo, poster, and more). Each one is tagged with how it was verified: tested here, OpenAI documentation, or community sources.

Size and aspect ratio are not parameters. They go in the prompt: "16:9" returned 1672x941 in testing.

## Tools

### generate_image

| Parameter | Default | Description |
| --- | --- | --- |
| `prompt` | required | The image prompt. |
| `count` | `1` | Images from the same prompt, 1 to 4. Each one uses your quota. Codex may return fewer. |
| `transparent_background` | `false` | Asks for a transparent background. The result reports whether the PNG has an alpha channel. |
| `reference_images` | none | Up to 16 local images to edit or use as references (PNG, JPEG, WebP, GIF). Absolute, relative to the project, or starting with `~`. Do not put these paths in `prompt`. |
| `prompt_mode` | `exact` | `exact`: Codex is told to pass the prompt to GPT Image unchanged; the result reports any difference. `enhance`: the Codex model rewrites it first. |
| `model` | Codex config | Codex chat model that relays the request. It does not choose the image model. |
| `reasoning_effort` | `low` in exact mode, if the model supports it | Reasoning effort for that model. |
| `output_path` | `<project>/generated-images/` | A directory, or a file path. The name is kept; the extension follows the returned format (PNG). |
| `background` | `false` | Return a job id at once and keep generating; collect it with `get_image_result`. |

The result lists each saved path with its size, the prompt that reached GPT Image (when Codex reports it), the alpha check when transparency was requested, and the usage limits Codex reports (5-hour and weekly windows).

### get_image_result

Returns the result of a `background: true` job: the same text and images as a normal call, or its status while it runs. `wait_seconds` (0-600) waits at most that long and returns as soon as the job finishes. Images are returned on the first successful collection only. At most 4 jobs run at once; finished jobs are kept for 1 hour and are lost if the server restarts.

Claude Code can also move any long MCP call to the background by itself. To make that happen after 10 seconds instead of 2 minutes, add `"CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "10000"` to the `env` block of `~/.claude/settings.json`.

### codex_status

Shows the Codex path and version, sign-in state, usage limits with reset times, the Codex config default model, the models with the reasoning efforts each one accepts, and the save folder.

## Prompt modes

In `exact` mode Codex is told to call `image_gen` with your text, character for character. The prompt that reached GPT Image is compared with yours, and the result says whether they match.

The Codex model and reasoning effort do not draw the image. The model matters most in `enhance` mode, where it writes the final prompt.

## Files

- `<project>`: `CLAUDE_PROJECT_DIR` if set, else the workspace root reported by Claude Code, else the current directory.
- Default name: date, time and the first six words of the prompt, e.g. `generated-images/2026-10-14_120030_a-minimalist-flat-illustration-of-a.png`.
- Several images get `_1`, `_2`, ...
- Existing files are never overwritten. A `-2`, `-3`, ... suffix is added.
- Codex also keeps its own copy in `~/.codex/generated_images/`.

## Settings

| Variable | Purpose |
| --- | --- |
| `CODEX_PATH` | Full path to the `codex` executable. Replaces the automatic search. |
| `GPT_IMAGE_MODEL` | Default Codex model for every call, e.g. `gpt-6-astra`. A `model` argument in the call wins. |
| `GPT_IMAGE_EFFORT` | Default reasoning effort, e.g. `max`. A `reasoning_effort` argument in the call wins. |

The automatic search checks `PATH`, then common install folders: the official installer folder (`~/.local/bin`, or `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` on Windows), npm global, nvm, pnpm, Volta, Bun, asdf and Homebrew.

```bash
claude mcp add --scope user gpt-image -e GPT_IMAGE_MODEL=gpt-6-astra -e GPT_IMAGE_EFFORT=max -- npx -y github:Monayzera/mcp-gpt-image
```

`setup` passes `CODEX_PATH`, `GPT_IMAGE_MODEL` and `GPT_IMAGE_EFFORT` to the server when they are set in your shell.

In `exact` mode the Codex model only relays the prompt. In testing, the same prompt with `gpt-6-astra` and effort `max` used about 4% of the 5-hour window, against about 1% with the default model and effort `low`, and the image was not better.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `Codex CLI was not found` | Install Codex, or set `CODEX_PATH`. |
| `CODEX_PATH is set but no executable file exists at:` | Fix the path, or remove `CODEX_PATH` to use the automatic search. |
| `Codex is not signed in` | Run `codex login`. |
| `Your ChatGPT/Codex usage limit was reached.` or `Image generation usage limit reached` | Wait for the reset time shown by `codex_status`. |
| `Codex finished without generating an image.` | The lines after it give the reason. |
| `spawn git ENOENT` during install | Install git. |
| Tool call moved to background | Normal. Claude Code can move long MCP calls to the background and delivers the result when they finish. |

## How it works

1. On the first call the server starts `codex app-server` (JSON-RPC over stdio) and keeps it running.
2. Each request opens an ephemeral, read-only Codex thread whose instructions are to call `image_gen` with the prompt.
3. Codex reports each `imageGeneration` item. The server writes each image to disk and returns it with the usage limits Codex reports.

## License

MIT
