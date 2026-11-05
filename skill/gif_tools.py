import argparse
import math
import re
import sys
from pathlib import Path

try:
    from PIL import Image, ImageSequence
except ImportError:
    sys.exit("Pillow is required: python3 -m pip install pillow")

MIN_MS = 20


def ease(t, kind):
    t = min(max(t, 0.0), 1.0)
    if kind == "linear":
        return t
    if kind == "cubic":
        return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2
    return 0.5 - 0.5 * math.cos(math.pi * t)


def snap(ms):
    return max(MIN_MS, int(round(ms / 10)) * 10)


def frame_ms_arg(value):
    try:
        ms = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a whole number: {value}")
    if ms < MIN_MS or ms % 10:
        raise argparse.ArgumentTypeError("must be a multiple of 10 and at least 20 (GIF stores delays in 1/100 s; browsers slow down shorter ones)")
    return ms


def positive_int_arg(value):
    try:
        n = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a whole number: {value}")
    if n < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return n


def non_negative_int_arg(value):
    try:
        n = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a whole number: {value}")
    if n < 0:
        raise argparse.ArgumentTypeError("must be 0 or more")
    return n


def seconds_arg(value):
    try:
        s = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {value}")
    if not 0 <= s <= 600:
        raise argparse.ArgumentTypeError("must be between 0 and 600 seconds")
    return s


def scale_arg(value):
    try:
        s = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {value}")
    if not 0 < s <= 1:
        raise argparse.ArgumentTypeError("must be above 0 and at most 1")
    return s


def color_arg(value):
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", value.strip())
    if not match:
        raise argparse.ArgumentTypeError(f"must be #RRGGBB, got {value}")
    hex_value = match.group(1)
    return tuple(int(hex_value[i:i + 2], 16) for i in (0, 2, 4))


def canvas_arg(value):
    match = re.fullmatch(r"(\d+)[xX](\d+)", value.strip())
    if not match or int(match.group(1)) < 1 or int(match.group(2)) < 1:
        raise argparse.ArgumentTypeError(f"must be WIDTHxHEIGHT, for example 1080x1080, got {value}")
    return int(match.group(1)), int(match.group(2))


def fit(image, max_side):
    if max_side and max(image.size) > max_side:
        image = image.copy()
        image.thumbnail((max_side, max_side), Image.LANCZOS)
    return image


def load_frames(path):
    path = Path(path)
    if path.is_dir():
        files = sorted(p for p in path.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif"})
        if not files:
            raise ValueError(f"no images in {path}")
        frames = []
        for p in files:
            with Image.open(p) as im:
                if getattr(im, "n_frames", 1) > 1:
                    raise ValueError(f"{p.name} is animated; a keyframe folder needs still images")
                frames.append((im.convert("RGBA"), None))
        return frames
    with Image.open(path) as im:
        return [(frame.convert("RGBA"), frame.info.get("duration")) for frame in ImageSequence.Iterator(im)]


def save_gif(frames, durations, out, dither, shared_palette):
    rgb = [f.convert("RGB") for f in frames]
    mode = Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE
    if shared_palette:
        samples = rgb[:: max(1, len(rgb) // 12)][:12]
        w, h = samples[0].size
        strip = Image.new("RGB", (w, h * len(samples)))
        for i, s in enumerate(samples):
            strip.paste(s, (0, i * h))
        palette = strip.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
        out_frames = [f.quantize(palette=palette, dither=mode) for f in rgb]
    else:
        out_frames = [f.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=mode) for f in rgb]
    out_frames[0].save(
        out,
        save_all=True,
        append_images=out_frames[1:],
        duration=durations,
        loop=0,
        disposal=1,
        optimize=False,
    )
    with Image.open(out) as written:
        total = sum(frame.info.get("duration", 0) for frame in ImageSequence.Iterator(written))
        return written.n_frames, total


def cmd_fade(a):
    art = fit(Image.open(a.image).convert("RGBA"), a.max_side)
    canvas_size = a.canvas or art.size
    if canvas_size[0] < art.width or canvas_size[1] < art.height:
        raise ValueError(f"--canvas {canvas_size[0]}x{canvas_size[1]} is smaller than the image {art.width}x{art.height}; use a bigger canvas, or --max-side to shrink the image (resamples)")
    fps = 1000 / a.frame_ms
    phases = [("in", a.fade_in), ("hold", a.hold), ("out", a.fade_out), ("gap", a.gap)]
    frames = []
    for name, seconds in phases:
        n = max(1, round(seconds * fps)) if seconds > 0 else 0
        for i in range(n):
            t = (i + 1) / n if name == "in" else i / n
            if name == "in":
                k = ease(t, a.ease)
            elif name == "hold":
                k = 1.0
            elif name == "out":
                k = 1 - ease(t, a.ease)
            else:
                k = 0.0
            scale = a.scale_from + (1 - a.scale_from) * k
            layer = art
            if scale != 1:
                size = (max(1, round(art.width * scale)), max(1, round(art.height * scale)))
                layer = art.resize(size, Image.LANCZOS)
            faded = layer.copy()
            faded.putalpha(faded.getchannel("A").point(lambda v: round(v * k)))
            frame = Image.new("RGBA", canvas_size, a.bg + (255,))
            frame.alpha_composite(faded, ((canvas_size[0] - faded.width) // 2, (canvas_size[1] - faded.height) // 2))
            frames.append(frame)
    if not frames:
        raise ValueError("at least one of --fade-in, --hold, --fade-out, --gap must be above 0")
    count, total = save_gif(frames, [a.frame_ms] * len(frames), a.out, a.dither, a.shared_palette)
    print(f"{a.out}: {len(frames)} frames written as {count} GIF frames (repeats merged), {total} ms loop")


def cmd_smooth(a):
    keys = [(fit(f, a.max_side), d) for f, d in load_frames(a.source)]
    if len(keys) < 2:
        raise ValueError("need at least 2 keyframes")
    size = keys[0][0].size
    if any(k.size != size for k, _ in keys):
        raise ValueError("all keyframes must have the same size; resizing them would blur the result")
    pairs = list(zip(keys, keys[1:] + (keys[:1] if a.loop else [])))
    frames, durations = [], []
    for (start, held), (end, _) in pairs:
        total = held or a.frame_ms * a.steps
        step = min(a.frame_ms, snap(total / a.steps))
        key = snap(max(step, total - (a.steps - 1) * step))
        for j in range(a.steps):
            frames.append(start if j == 0 else Image.blend(start, end, ease(j / a.steps, a.ease)))
            durations.append(key if j == 0 else step)
    if not a.loop:
        last, held = keys[-1]
        frames.append(last)
        durations.append(snap(held or a.frame_ms))
    count, total = save_gif(frames, durations, a.out, a.dither, a.shared_palette)
    print(f"{a.out}: {len(frames)} frames from {len(keys)} keyframes written as {count} GIF frames (repeats merged), {total} ms loop")


def cmd_sheet(a):
    frames = [f for f, _ in load_frames(a.source)]
    rows = math.ceil(len(frames) / a.cols)
    max_w = max(f.width for f in frames)
    max_h = max(f.height for f in frames)
    scale = min(1.0, a.cell / max(max_w, max_h))
    cw, ch = max(1, round(max_w * scale)), max(1, round(max_h * scale))
    sheet = Image.new("RGB", (a.cols * cw, rows * ch), (128, 128, 128))
    for i, f in enumerate(frames):
        thumb = f.convert("RGB")
        thumb.thumbnail((cw, ch), Image.LANCZOS)
        x = (i % a.cols) * cw + (cw - thumb.width) // 2
        y = (i // a.cols) * ch + (ch - thumb.height) // 2
        sheet.paste(thumb, (x, y))
    sheet.save(a.out)
    print(f"{a.out}: {len(frames)} frames in a {a.cols}x{rows} grid")


def main():
    p = argparse.ArgumentParser(description="Smooth GIF helpers for the gpt-image skill.")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fade", help="Loop a still image in and out over a solid background.")
    f.add_argument("image")
    f.add_argument("out")
    f.add_argument("--bg", type=color_arg, default="#0B0B0F")
    f.add_argument("--canvas", type=canvas_arg, help="WIDTHxHEIGHT, at least the image size; default is the image size")
    f.add_argument("--fade-in", type=seconds_arg, default=1.0)
    f.add_argument("--hold", type=seconds_arg, default=1.0)
    f.add_argument("--fade-out", type=seconds_arg, default=1.0)
    f.add_argument("--gap", type=seconds_arg, default=0.4)
    f.add_argument("--scale-from", type=scale_arg, default=1.0, help="start size while fading in; below 1 resamples the image")
    f.add_argument("--frame-ms", type=frame_ms_arg, default=40)
    f.add_argument("--ease", choices=["sine", "cubic", "linear"], default="sine")
    f.add_argument("--max-side", type=non_negative_int_arg, default=0, help="shrink the image first; resamples")
    f.add_argument("--dither", action="store_true")
    f.add_argument("--shared-palette", action="store_true")
    f.set_defaults(fn=cmd_fade)

    s = sub.add_parser("smooth", help="Add eased in-between frames to a GIF or a folder of same-size still keyframes.")
    s.add_argument("source")
    s.add_argument("out")
    s.add_argument("--steps", type=positive_int_arg, default=4)
    s.add_argument("--frame-ms", type=frame_ms_arg, default=40, help="duration of each in-between frame; GIF keyframes keep their own timing")
    s.add_argument("--ease", choices=["sine", "cubic", "linear"], default="sine")
    s.add_argument("--max-side", type=non_negative_int_arg, default=0, help="shrink the frames first; resamples")
    s.add_argument("--no-loop", dest="loop", action="store_false")
    s.add_argument("--dither", action="store_true")
    s.add_argument("--shared-palette", action="store_true")
    s.set_defaults(fn=cmd_smooth)

    c = sub.add_parser("sheet", help="Contact sheet of every frame, for review.")
    c.add_argument("source")
    c.add_argument("out")
    c.add_argument("--cols", type=positive_int_arg, default=6)
    c.add_argument("--cell", type=positive_int_arg, default=220)
    c.set_defaults(fn=cmd_sheet)

    a = p.parse_args()
    try:
        a.fn(a)
    except Exception as err:
        sys.exit(f"error: {err}")


if __name__ == "__main__":
    main()
