# JiMeng Skill

Browser automation skill for JiMeng image and video generation.

The skill opens JiMeng once in a headed Chrome browser for login, saves the
session in a persistent Chrome profile, then reuses that profile for later
image or video generation.

## What This Provides

- One-time headed JiMeng login.
- Reusable persistent browser profile.
- Image generation and video generation through the JiMeng web UI.
- Local reference image upload with `--ref` or `--refs`.
- JSON output for automation.
- Manual-takeover artifacts when JiMeng queues, changes UI selectors, blocks
  generation, or hides download actions.

## Requirements

- Node.js 20 or newer.
- Google Chrome installed.
- A JiMeng account that can use the web generator.
- Network access to `https://jimeng.jianying.com/ai-tool/home`.

Install dependencies from the skill directory:

```bash
npm install --omit=dev
```

For development or tests:

```bash
npm install
npm test
```

## Install For Hermes Agent

Hermes loads skills from `~/.hermes/skills`.

Clone or copy this repository into:

```bash
~/.hermes/skills/jimeng
```

Then install runtime dependencies:

```bash
cd ~/.hermes/skills/jimeng
npm install --omit=dev
```

Restart or refresh Hermes so it reloads skills.

Quick verification:

```bash
cd ~/.hermes/skills/jimeng
node scripts/jimeng.mjs
node --check scripts/jimeng.mjs
```

The first command should print JSON usage.

## Install For Codex

Codex commonly loads skills from `~/.codex/skills`.

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/mangaohua/jimeng-skill.git ~/.codex/skills/jimeng
cd ~/.codex/skills/jimeng
npm install --omit=dev
```

Restart Codex to pick up the new skill.

## One-Time Login

Run a headed login for the account name you want to reuse:

```bash
node scripts/jimeng.mjs login --account main
```

Complete login in the Chrome window. The command waits until the page is
stably logged in.

Check the saved session later:

```bash
node scripts/jimeng.mjs check --account main
```

Expected ready output:

```json
{
  "status": "ready",
  "account_id": "main",
  "needs_login": false
}
```

By default, the browser profile is stored at:

```text
~/.jimeng-skill/accounts/<account_id>/profile
```

This makes the login reusable across projects and agents.

## Generate An Image

Prompt-only image:

```bash
node scripts/jimeng.mjs generate-image \
  --account main \
  --prompt "A warm realistic indoor fireplace portrait, no text, no watermark" \
  --output ./output/fireplace.png
```

Image with a reference file:

```bash
node scripts/jimeng.mjs generate-image \
  --account main \
  --prompt "Use the uploaded portrait as the character reference. Generate the same woman warming her hands beside an indoor fireplace, realistic phone photo, warm firelight, no text, no watermark." \
  --ref /absolute/path/to/reference.png \
  --output ./output/fireplace-reference.png
```

Multiple references:

```bash
node scripts/jimeng.mjs generate-image \
  --account main \
  --prompt "Use the uploaded references for identity and product details." \
  --refs /absolute/path/person.png,/absolute/path/product.png \
  --output ./output/result.png
```

## Generate A Video

Text-to-video:

```bash
node scripts/jimeng.mjs generate-video \
  --account main \
  --prompt "9:16 realistic product seeding video, warm indoor light" \
  --output ./output/video.mp4
```

Image-to-video:

```bash
node scripts/jimeng.mjs generate-video \
  --account main \
  --mode image-to-video \
  --prompt "Animate the uploaded reference into a warm 9:16 fireplace scene" \
  --ref /absolute/path/reference.png \
  --duration 10 \
  --ratio 9:16 \
  --output ./output/video.mp4
```

Agent reference video mode:

```bash
node scripts/jimeng.mjs generate-video \
  --account main \
  --mode agent-reference-video \
  --prompt "Use the uploaded product and portrait references to create a 10 second vertical lifestyle video." \
  --refs /absolute/path/person.png,/absolute/path/product.png \
  --duration 10 \
  --ratio 9:16 \
  --output ./output/agent-reference.mp4
```

## Important Reference Image Rule

Reference images only work when the command passes a real local file path with
`--ref` or `--refs`.

This does not upload a reference image:

```text
Prompt: "Use the image above as reference"
```

This does upload a reference image:

```bash
--ref /absolute/path/to/the-image.png
```

If Hermes, Codex, or another agent receives an image in chat, it must first
save or locate that attachment as a local file, then pass the local file path
to `--ref`. If it only describes the image in the prompt, JiMeng will run as
prompt-only generation.

When checking whether a run actually used a reference image, open the generated
`success.png` artifact. The JiMeng prompt area should show a visible uploaded
image thumbnail, not only a grey `+` placeholder.

## Useful Options

```text
--account <id>             Required account profile name.
--prompt <text>            Required generation prompt.
--output <file>            Required output path.
--ref <file>               Upload one reference file. Can be repeated.
--refs <file1,file2>       Upload comma-separated reference files.
--mode <mode>              text-to-video, image-to-video, or agent-reference-video.
--duration <seconds>       Select visible duration option when present.
--ratio <W:H>              Select visible aspect ratio when present.
--headed                   Run generation in visible Chrome for debugging.
--profile-dir <dir>        Override the account profile directory.
--state-dir <dir>          Override ~/.jimeng-skill.
--home-url <url>           Override JiMeng entrypoint, useful for tests.
--timeout-ms <n>           Override result wait timeout.
--overwrite true           Replace an existing output file.
```

## Output JSON

Successful run:

```json
{
  "status": "success",
  "account_id": "main",
  "output_path": "/absolute/path/output.png",
  "artifact_dir": "/Users/you/.jimeng-skill/runs/<run-id>/artifacts",
  "artifact_paths": [
    "/Users/you/.jimeng-skill/runs/<run-id>/artifacts/download.json",
    "/Users/you/.jimeng-skill/runs/<run-id>/artifacts/success.png"
  ]
}
```

If the session needs login:

```json
{
  "status": "needs_login",
  "account_id": "main",
  "needs_login": true
}
```

If automation needs manual help:

```json
{
  "status": "waiting_human",
  "waiting_human_reason": "download_not_available",
  "manual_instructions_path": ".../manual-instructions.json"
}
```

## Manual-Takeover Artifacts

When the script cannot complete safely, it writes artifacts under:

```text
~/.jimeng-skill/runs/<run-id>/artifacts
```

Common files:

- `manual-instructions.json`: account, prompt, references, expected output path,
  and resume guidance.
- `success.png`: final page screenshot for successful runs.
- `<reason>.png`: screenshot for manual-takeover runs when available.
- `<reason>.html`: page HTML or fallback body text.
- `download.json`: media URL or browser download metadata.
- `queue-state.json`: queue text when JiMeng enters a provider queue.

## Troubleshooting

### The output does not look like the reference image

Check `success.png`. If the prompt area shows only a grey `+` placeholder, the
reference file was not uploaded. Make sure the command includes `--ref` with an
absolute path to an existing image file.

### `check` says `needs_login`

Run:

```bash
node scripts/jimeng.mjs login --account main
```

Finish login in the headed Chrome window, then run `check` again.

### The run returns `waiting_human`

Open `manual-instructions.json`. If the reason is `provider_queue_wait`, do not
start a fresh generation immediately. Wait for the queued JiMeng task or reopen
JiMeng history with the same profile, then save the finished asset to the
recorded `expected_output_path`.

### The script downloads the wrong media

Open `success.png` and `download.json`. The script ignores media that existed
before clicking generate and waits while JiMeng shows generation-in-progress
text, but JiMeng UI changes can still break selectors. Run with `--headed` to
debug:

```bash
node scripts/jimeng.mjs generate-image \
  --account main \
  --headed \
  --prompt "..." \
  --ref /absolute/path/reference.png \
  --output ./output/debug.png
```

## Development

```bash
npm install
npm run check
npm test
```

Tests use a local mock JiMeng server. They do not require a live JiMeng account.

## Safety Notes

- This skill operates through the browser UI.
- It does not extract cookies.
- It does not call private JiMeng APIs.
- It stores browser profiles locally under `~/.jimeng-skill` by default.
