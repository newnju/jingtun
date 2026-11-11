"""
把 1000x1000 的 logo 图处理成扩展所需的各尺寸图标。

需要 Pillow，并通过 LOGO_SOURCE 提供源图；源图不随仓库分发。
没有源图时，可运行 gen-icons.py 生成占位图标。

不能直接把白色全部转为透明，因为鲸鱼图案内部也有白色区域。
做法是从四角做 flood fill，只处理与边缘连通的白色。
"""

import os
import sys
from collections import deque

from PIL import Image, ImageFilter

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("LOGO_SOURCE", os.path.join(BASE, "..", "鲸吞.png"))
OUT_DIR = os.path.join(BASE, "..", "icons")
SIZES = [16, 32, 48, 128]

# 判定为"背景白"的阈值：三个通道都大于它才算白
WHITE_THRESHOLD = 235


def is_bg(pixel):
    """这个像素算不算背景白（含完全透明）"""
    r, g, b, a = pixel
    if a == 0:
        return True
    return r >= WHITE_THRESHOLD and g >= WHITE_THRESHOLD and b >= WHITE_THRESHOLD


def flood_transparent(img):
    """从四角出发，把与边缘连通的白色区域转为透明。"""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()

    visited = [[False] * w for _ in range(h)]
    queue = deque()

    # 四角作为种子。边界上的任意白像素都算种子，避免图案贴边时漏掉
    for x in range(w):
        for y in (0, h - 1):
            if not visited[y][x] and is_bg(px[x, y]):
                visited[y][x] = True
                queue.append((x, y))

    for y in range(h):
        for x in (0, w - 1):
            if not visited[y][x] and is_bg(px[x, y]):
                visited[y][x] = True
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        px[x, y] = (0, 0, 0, 0)

        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not visited[ny][nx]:
                if is_bg(px[nx, ny]):
                    visited[ny][nx] = True
                    queue.append((nx, ny))

    return img


def trim_to_content(img, pad_ratio=0.02):
    """裁到内容边界，并留出 2% 的透明边距。"""
    bbox = img.getbbox()
    if not bbox:
        return img

    img = img.crop(bbox)

    # 补一圈透明边距，避免图案贴死边缘
    w, h = img.size
    side = max(w, h)
    pad = int(side * pad_ratio)

    canvas = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2 + pad, (side - h) // 2 + pad))
    return canvas


def sharpen_for_small(img, size):
    """对 48px 以下的图标做轻量锐化。"""
    if size > 48:
        return img

    return img.filter(ImageFilter.UnsharpMask(radius=0.6, percent=90, threshold=2))


def main():
    if not os.path.exists(SRC):
        print("找不到源图: " + SRC)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)

    img = Image.open(SRC)
    print("源图尺寸: %d x %d  模式: %s" % (img.width, img.height, img.mode))

    # 先看四角是不是白的，不是的话就不做透明化（可能是已经处理过的图）
    corners = [
        img.convert("RGBA").getpixel((0, 0)),
        img.convert("RGBA").getpixel((img.width - 1, 0)),
        img.convert("RGBA").getpixel((0, img.height - 1)),
        img.convert("RGBA").getpixel((img.width - 1, img.height - 1)),
    ]
    print("四角像素: " + str(corners))

    all_white = all(is_bg(c) for c in corners)

    if all_white:
        print("四角为白 → 从边缘做 flood fill 转透明")
        img = flood_transparent(img)
    else:
        print("四角非纯白 → 保留原样（可能已处理过）")
        img = img.convert("RGBA")

    img = trim_to_content(img)
    print("裁剪后尺寸: %d x %d" % (img.width, img.height))

    for size in SIZES:
        # LANCZOS 在缩小照片类图像时质量最好
        resized = img.resize((size, size), Image.LANCZOS)
        resized = sharpen_for_small(resized, size)
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        resized.save(path, "PNG", optimize=True)
        print("  生成 %s (%d bytes)" % (path, os.path.getsize(path)))

    return 0


if __name__ == "__main__":
    sys.exit(main())
