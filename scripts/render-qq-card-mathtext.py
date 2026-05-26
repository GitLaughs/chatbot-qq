import argparse
import io
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

try:
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib.font_manager import FontProperties
    from matplotlib.mathtext import math_to_image
except Exception as exc:  # pragma: no cover - exercised by caller fallback.
    print(f"mathtext unavailable: {exc}", file=sys.stderr)
    sys.exit(2)


INK = (23, 32, 51, 255)
BG = (244, 247, 251, 255)
CARD = (255, 255, 255, 255)
BORDER = (207, 217, 232, 255)
CODE_BG = (237, 242, 247, 255)


def main():
    args = parse_args()
    render_card(args.text, args.out, width=max(720, int(args.width or 1200)))


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", "-TextPath", dest="text", required=True)
    parser.add_argument("--out", "-OutPath", dest="out", required=True)
    parser.add_argument("--title", "-Title", dest="title", default="QQ Bot")
    parser.add_argument("--width", "-Width", dest="width", default=1200)
    return parser.parse_args()


def render_card(text_path, out_path, width=1200):
    with open(text_path, "r", encoding="utf-8") as fh:
        text = fh.read()

    body_font = load_font(23)
    mono_font = load_font(20, mono=True)
    max_height = int(os.environ.get("ONEBOT_RENDER_MAX_HEIGHT") or "680")
    if max_height <= 480:
        max_height = 680
    outer = 22
    pad = 48
    max_width = width - (outer + pad) * 2
    rows = layout_rows(text, max_width, body_font, mono_font)

    pages = paginate(rows, max_height - ((outer + pad) * 2))
    if not pages:
        pages = [[blank_row()]]

    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)
    stem, ext = os.path.splitext(out_path)
    if not ext:
        ext = ".png"

    for page_index, page_rows in enumerate(pages):
        page_path = out_path if page_index == 0 else f"{stem}-{page_index + 1}{ext}"
        page_height = min(max_height, max(420, outer + pad + sum(row["height"] for row in page_rows) + outer + pad))
        img = Image.new("RGBA", (width, page_height), BG)
        draw = ImageDraw.Draw(img)
        draw.rectangle((outer, outer, width - outer, page_height - outer), fill=CARD, outline=BORDER, width=2)

        x = outer + pad
        y = outer + pad
        for row in page_rows:
            draw_row(img, draw, row, x, y, max_width, body_font, mono_font)
            y += row["height"]

        img.convert("RGB").save(page_path, "PNG")


def layout_rows(text, max_width, body_font, mono_font):
    rows = []
    for raw in re.split(r"\r?\n", text):
        line = raw.rstrip()
        if not line:
            rows.append(blank_row())
            continue
        if line.startswith("    ") or line.startswith("Code:"):
            rows.extend(wrap_text_rows(line, max_width, mono_font, kind="code"))
            continue
        if is_formula_line(line):
            rows.append(display_math_row(line, max_width))
            continue
        rows.extend(wrap_inline_rows(line, max_width, body_font))
    return rows


def blank_row():
    return {"kind": "blank", "height": 20}


def text_size(text, font):
    box = ImageDraw.Draw(Image.new("RGB", (1, 1))).textbbox((0, 0), text, font=font)
    return max(0, box[2] - box[0]), max(0, box[3] - box[1])


def wrap_text_rows(text, max_width, font, kind="text"):
    rows = []
    current = ""
    for ch in text:
        candidate = current + ch
        if current and text_size(candidate, font)[0] > max_width:
            rows.append({"kind": kind, "segments": [{"type": "text", "text": current}], "height": 42})
            current = ch
        else:
            current = candidate
    if current:
        rows.append({"kind": kind, "segments": [{"type": "text", "text": current}], "height": 42})
    return rows


def wrap_inline_rows(line, max_width, font):
    segments = inline_segments(line, font)
    rows = []
    current = []
    width = 0
    height = 42
    for seg in segments:
        parts = split_wide_text_segment(seg, max_width, font) if seg["type"] == "text" else [seg]
        for part in parts:
            part_width = part["width"]
            if part["type"] == "math" and part_width > max_width:
                part = scaled_segment(part, max_width / part_width)
                part_width = part["width"]
            if current and width + part_width > max_width:
                rows.append({"kind": "inline", "segments": current, "height": height})
                current = []
                width = 0
                height = 42
            current.append(part)
            width += part_width
            height = max(height, part.get("height", 42) + 8)
    if current:
        rows.append({"kind": "inline", "segments": current, "height": height})
    return rows or [blank_row()]


def split_wide_text_segment(seg, max_width, font):
    if seg["width"] <= max_width:
        return [seg]
    parts = []
    current = ""
    for ch in seg["text"]:
        candidate = current + ch
        if current and text_size(candidate, font)[0] > max_width:
            w, h = text_size(current, font)
            parts.append({"type": "text", "text": current, "width": w, "height": max(32, h)})
            current = ch
        else:
            current = candidate
    if current:
        w, h = text_size(current, font)
        parts.append({"type": "text", "text": current, "width": w, "height": max(32, h)})
    return parts


def display_math_row(line, max_width):
    math = render_math(line, size=25, display=True)
    if math.width > max_width:
        ratio = max_width / math.width
        math = math.resize((max(1, int(math.width * ratio)), max(1, int(math.height * ratio))), Image.Resampling.LANCZOS)
    return {"kind": "display_math", "image": math, "height": max(54, math.height + 22)}


def inline_segments(line, font):
    parts = []
    for chunk in split_cjk_ascii_runs(line):
        if is_math_chunk(chunk):
            img = render_math(chunk.strip(), size=23, display=False)
            parts.append({"type": "math", "image": img, "width": img.width, "height": img.height})
        else:
            w, h = text_size(chunk, font)
            parts.append({"type": "text", "text": chunk, "width": w, "height": max(32, h)})
    return merge_text(parts)


def split_cjk_ascii_runs(line):
    chunks = []
    current = ""
    current_ascii = None
    for ch in line:
        asciiish = ord(ch) < 128 or ch in "≤≥≈≠∞∑√∫"
        if current and asciiish != current_ascii:
            chunks.append(current)
            current = ch
        else:
            current += ch
        current_ascii = asciiish
    if current:
        chunks.append(current)
    return chunks


def merge_text(parts):
    merged = []
    for part in parts:
        if part["type"] == "text" and merged and merged[-1]["type"] == "text":
            merged[-1]["text"] += part["text"]
            merged[-1]["width"] += part["width"]
            merged[-1]["height"] = max(merged[-1]["height"], part["height"])
        else:
            merged.append(part)
    return merged


def is_formula_line(line):
    s = line.strip()
    if not s or re.search(r"[\u4e00-\u9fff]", s):
        return False
    return bool(re.search(r"(\\[A-Za-z]+|[_^]=?|[∑√∫≤≥≈≠∞]|[A-Za-z]\s*[=<>]|[=<>]\s*[A-Za-z0-9]|\\frac)", s))


def is_math_chunk(chunk):
    s = chunk.strip()
    if len(s) < 2:
        return False
    if not re.search(r"(\\[A-Za-z]+|[_^]|[∑√∫≤≥≈≠∞]|[A-Za-z0-9]\s*[=<>]|[=<>]\s*[A-Za-z0-9])", s):
        return False
    if re.fullmatch(r"[0-9.\s]+", s):
        return False
    return True


def render_math(tex, size=23, display=False):
    original = tex
    boxed = "\\boxed" in tex
    normalized = normalize_tex(tex)
    for candidate in (normalized, rough_math_fallback(normalized)):
        try:
            buf = io.BytesIO()
            math_to_image(f"${candidate}$", buf, prop=FontProperties(size=size * 0.8), dpi=100, format="png", color="#172033")
            buf.seek(0)
            img = Image.open(buf).convert("RGBA")
            if boxed:
                img = add_box(img)
            return trim_image(img)
        except Exception:
            continue
    return text_fallback(original, size)


def normalize_tex(tex):
    s = str(tex or "").strip()
    s = re.sub(r"^\\\(|\\\)$", "", s)
    s = re.sub(r"^\\\[|\\\]$", "", s)
    s = s.strip("$").strip()
    s = unwrap_command(s, "boxed")
    s = re.sub(r"\\ge(?![A-Za-z])", r"\\geq", s)
    s = re.sub(r"\\le(?![A-Za-z])", r"\\leq", s)
    s = re.sub(r"\\frac\s*\{((?:[^{}]|\{[^{}]*\})+)\}\s*([A-Za-z0-9])", r"\\frac{\1}{\2}", s)
    s = re.sub(r"\\frac\s*([A-Za-z0-9])\s*([A-Za-z0-9])", r"\\frac{\1}{\2}", s)
    s = s.replace("≥", r"\geq ").replace("≤", r"\leq ").replace("∞", r"\infty ")
    return s


def unwrap_command(s, name):
    prefix = "\\" + name + "{"
    while s.startswith(prefix) and s.endswith("}"):
        inner = s[len(prefix):-1]
        if balanced_braces(inner):
            s = inner.strip()
        else:
            break
    return s


def balanced_braces(s):
    depth = 0
    for ch in s:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


def rough_math_fallback(s):
    s = re.sub(r"\\frac\{([^{}]+)\}\{([^{}]+)\}", r"(\1)/(\2)", s)
    replacements = {
        "\\quad": "  ",
        "\\,": " ",
        "\\sim": r"\sim",
        "\\ge": r"\geq",
        "\\le": r"\leq",
    }
    for src, dst in replacements.items():
        s = s.replace(src, dst)
    return s


def text_fallback(text, size):
    font = load_font(max(18, size), mono=True)
    clean = latex_to_plain(text)
    w, h = text_size(clean, font)
    img = Image.new("RGBA", (max(1, w + 8), max(1, h + 8)), (255, 255, 255, 0))
    ImageDraw.Draw(img).text((4, 2), clean, font=font, fill=INK)
    return img


def latex_to_plain(text):
    s = normalize_tex(text)
    s = re.sub(r"\\frac\{([^{}]+)\}\{([^{}]+)\}", r"(\1)/(\2)", s)
    s = s.replace("\\quad", "  ").replace("\\,", " ")
    s = re.sub(r"\\([A-Za-z]+)", r"\1", s)
    return s


def trim_image(img):
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    box = img.getbbox()
    if not box:
        return img
    return img.crop(box)


def add_box(img):
    pad = 8
    out = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (255, 255, 255, 0))
    out.alpha_composite(img, (pad, pad))
    draw = ImageDraw.Draw(out)
    draw.rectangle((1, 1, out.width - 2, out.height - 2), outline=INK, width=2)
    return out


def scaled_segment(seg, ratio):
    img = seg["image"].resize((max(1, int(seg["width"] * ratio)), max(1, int(seg["height"] * ratio))), Image.Resampling.LANCZOS)
    return {"type": "math", "image": img, "width": img.width, "height": img.height}


def paginate(rows, content_limit):
    pages = []
    page = []
    height = 0
    for row in rows:
        if page and height + row["height"] > content_limit:
            pages.append(page)
            page = []
            height = 0
        page.append(row)
        height += row["height"]
    if page:
        pages.append(page)
    return pages


def draw_row(img, draw, row, x, y, max_width, body_font, mono_font):
    kind = row["kind"]
    if kind == "blank":
        return
    if kind == "code":
        draw.rectangle((x - 10, y - 4, x + max_width + 10, y + 34), fill=CODE_BG)
        draw.text((x, y), row["segments"][0]["text"], font=mono_font, fill=INK)
        return
    if kind == "display_math":
        math = row["image"]
        img.alpha_composite(math, (x + max(0, (max_width - math.width) // 2), y + 8))
        return
    baseline = y + max(30, int(row["height"] * 0.68))
    cx = x
    for seg in row.get("segments", []):
        if seg["type"] == "text":
            draw.text((cx, y + 2), seg["text"], font=body_font, fill=INK)
            cx += seg["width"]
        else:
            math = seg["image"]
            img.alpha_composite(math, (int(cx), max(y, baseline - int(math.height * 0.78))))
            cx += math.width


def load_font(size, mono=False):
    candidates = []
    if mono:
        candidates.extend([
            r"C:\Windows\Fonts\consola.ttf",
            r"C:\Windows\Fonts\Consolas.ttf",
        ])
    candidates.extend([
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyh.ttf",
        r"C:\Windows\Fonts\simhei.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    ])
    for item in candidates:
        if os.path.exists(item):
            return ImageFont.truetype(item, size)
    return ImageFont.load_default()


if __name__ == "__main__":
    main()
