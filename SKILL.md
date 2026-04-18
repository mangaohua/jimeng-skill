---
name: jimeng
description: Generate JiMeng images or videos through a persistent headed-browser login. Use when the user needs to log in once, check a JiMeng session, or operate JiMeng web generation from Codex using a reusable Chrome profile.
---

# JiMeng Browser Generation

Use this skill when work should run through JiMeng web automation with a persistent browser session.

## Commands

From this skill directory:

```bash
node scripts/jimeng.mjs login --account <account_id>
node scripts/jimeng.mjs check --account <account_id>
node scripts/jimeng.mjs generate-image --account <account_id> --prompt <text> --output <file>
node scripts/jimeng.mjs generate-video --account <account_id> --prompt <text> --output <file>
```

Useful options:

- `--refs <file1,file2>` or repeated `--ref <file>` uploads reference images.
- `--mode text-to-video|image-to-video|agent-reference-video` selects video mode.
- `--duration <seconds>` and `--ratio <W:H>` select visible JiMeng options when present.
- `--headed` runs generation in a visible browser for debugging.
- `--profile-dir <dir>` overrides the default profile.
- `--state-dir <dir>` overrides the default `~/.jimeng-skill` state directory.
- `--home-url <url>` overrides the JiMeng entrypoint.
- `--timeout-ms <n>` adjusts generation/download wait time.

## Workflow

1. Run `login` once for the account and complete authentication in the visible Chrome window.
2. Run `check` before generation if the session may be stale.
3. Run `generate-image` or `generate-video`; the command reuses the same persistent profile.
4. Read stdout JSON for `success`, `needs_login`, or `waiting_human`.
5. If `waiting_human` is returned, inspect the recorded `manual-instructions.json`, screenshot, and HTML under the run artifact directory.

## Rules

- Default profile path is `~/.jimeng-skill/accounts/<account_id>/profile`, so login is reusable across projects.
- Reference images only work when you pass actual local file paths via `--ref`/`--refs`. A chat-side image description, sticker caption, or OCR summary is **not** a usable reference file.
- If the user says "按这张图生成" or wants likeness preservation, first make sure the attachment exists as a local file, then pass it through `--ref`; otherwise be explicit that generation is prompt-only.
- Do not extract cookies or call private JiMeng APIs. Operate through the browser UI.
- Treat long JiMeng queues as pause points. Do not immediately rerun a fresh generation for the same asset; wait for the queued result, download it to `expected_output_path`, then continue from that file.
- Selector drift, moderation, quota, and missing-download cases must return `waiting_human` with artifacts instead of pretending generation succeeded.
