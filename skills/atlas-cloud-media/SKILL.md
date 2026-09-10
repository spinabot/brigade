---
name: atlas-cloud-media
description: Generate images and videos with Atlas Cloud, poll asynchronous predictions, and download the resulting media.
metadata:
  {
    "brigade":
      {
        "emoji": "🦁",
        "requires": { "bins": ["python3"], "env": ["ATLASCLOUD_API_KEY"] },
        "primaryEnv": "ATLASCLOUD_API_KEY",
      },
  }
---

# Atlas Cloud Media

Use this skill when the user asks to generate an image or video with Atlas Cloud.

## Generate an image

```bash
{baseDir}/scripts/generate.py image \
  --prompt "A clean product photograph on a white background" \
  --out /tmp/atlas-image.png
```

Default image model: `qwen-image-3.0/text-to-image`.

## Generate a video

```bash
{baseDir}/scripts/generate.py video \
  --prompt "A paper airplane gliding through a sunlit studio" \
  --out /tmp/atlas-video.mp4
```

Default video model: `bytedance/seedance-2.0-fast/text-to-video`.

Use `--model` to select another compatible Atlas model. Use `--params-json`
for model-specific fields after checking that model's schema. The JSON must be
an object; `model` and `prompt` remain controlled by the corresponding flags.

```bash
{baseDir}/scripts/generate.py image \
  --model qwen-image-3.0/text-to-image \
  --prompt "Editorial portrait, soft daylight" \
  --params-json '{"size":"1024*1024"}' \
  --out /tmp/portrait.png
```

The command prints the saved path. Image generation can take tens of seconds;
video generation can take several minutes. Do not expose prediction URLs or the
API key in chat output. Confirm the destination before overwriting valuable
files.
