#!/usr/bin/env python3
"""
preview_gif.py - render data.json as the 2D waveform preview, to an animated GIF.

Renders each band as a white bar mirrored across the centreline on a dark
background - the classic waveform silhouette. Decimates the 120 fps dataset
down to a GIF-friendly frame rate.

Usage:
    python preview_gif.py [data.json] [preview.gif]

Requires: Pillow.
"""
import json
import sys

from PIL import Image, ImageDraw

DATA_PATH = sys.argv[1] if len(sys.argv) > 1 else "data.json"
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "preview.gif"

W, H = 880, 360       # output size
SRC_FPS = 120         # data.json was baked at 120 fps
GIF_FPS = 30          # GIFs don't play smoothly much above this
BG = (10, 12, 20)
FG = (255, 255, 255)


def render(bands):
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    n = len(bands)
    bw = W / n
    mid = H / 2
    for i, v in enumerate(bands):
        h = v * mid
        x0 = i * bw
        draw.rectangle([x0, mid - h, x0 + bw - 1, mid + h], fill=FG)
    return img


def main():
    data = json.load(open(DATA_PATH))
    frames = [data[k] for k in sorted(data, key=int)]

    step = max(1, round(SRC_FPS / GIF_FPS))
    selected = frames[::step]
    imgs = [render(b) for b in selected]

    imgs[0].save(
        OUT_PATH,
        save_all=True,
        append_images=imgs[1:],
        duration=round(1000 / GIF_FPS),
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"{DATA_PATH}: {len(frames)} frames -> {len(imgs)} @ {GIF_FPS}fps -> {OUT_PATH}")


if __name__ == "__main__":
    main()
