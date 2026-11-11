#!/usr/bin/env python3
"""
生成扩展所需的占位图标。

只依赖 Python 标准库（zlib、struct），无需 Pillow。
使用 4 倍超采样和 alpha 加权降采样实现抗锯齿。

正式图标请使用 gen-logo.py。本脚本用于在没有 Pillow 的环境中
快速生成一套可用的占位图标。

用法：python gen-icons.py
"""

import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
SIZES = [16, 32, 48, 128]
SS = 4  # 超采样倍数

BG_TOP = (0x1B, 0x6C, 0xA8)
BG_BOTTOM = (0x2A, 0x82, 0xC4)


def in_rounded_square(nx, ny, radius=0.32):
    """判断归一化坐标是否落在圆角方块内"""
    ax, ay = abs(nx), abs(ny)
    if ax > 1.0 or ay > 1.0:
        return False
    limit = 1.0 - radius
    if ax <= limit or ay <= limit:
        return True
    dx, dy = ax - limit, ay - limit
    return dx * dx + dy * dy <= radius * radius


def in_body(nx, ny):
    """鲸鱼身体：椭圆"""
    return ((nx - 0.02) / 0.60) ** 2 + ((ny - 0.02) / 0.34) ** 2 <= 1.0


def in_tail(nx, ny):
    """尾鳍：向右张开的楔形，尾部带 V 形凹口形成分叉"""
    if nx < 0.40 or nx > 0.96:
        return False
    t = (nx - 0.40) / 0.56
    half = 0.05 + t * 0.40
    if abs(ny - 0.02) > half:
        return False
    if nx > 0.76:
        notch = (nx - 0.76) / 0.20 * 0.26
        if abs(ny - 0.02) < notch:
            return False
    return True


def in_eye(nx, ny):
    """眼睛位置"""
    return (nx + 0.30) ** 2 + (ny + 0.06) ** 2 <= 0.0020


def color_at(nx, ny):
    """返回该归一化坐标处的 RGBA"""
    if not in_rounded_square(nx, ny):
        return (0, 0, 0, 0)

    t = (ny + 1.0) / 2.0
    bg = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))

    if in_eye(nx, ny):
        return (bg[0], bg[1], bg[2], 255)
    if in_body(nx, ny) or in_tail(nx, ny):
        return (255, 255, 255, 255)
    return (bg[0], bg[1], bg[2], 255)


def render(size):
    """渲染指定尺寸的像素矩阵"""
    w = size * SS
    h = size * SS

    grid = [[(0, 0, 0, 0)] * w for _ in range(h)]
    for y in range(h):
        ny = (y + 0.5) / h * 2.0 - 1.0
        for x in range(w):
            nx = (x + 0.5) / w * 2.0 - 1.0
            grid[y][x] = color_at(nx, ny)

    # 降采样：按 alpha 加权平均 RGB，避免边缘发暗
    out = [[(0, 0, 0, 0)] * size for _ in range(size)]
    area = SS * SS

    for y in range(size):
        for x in range(size):
            r_sum = g_sum = b_sum = a_sum = 0
            for dy in range(SS):
                for dx in range(SS):
                    px = grid[y * SS + dy][x * SS + dx]
                    a = px[3]
                    r_sum += px[0] * a
                    g_sum += px[1] * a
                    b_sum += px[2] * a
                    a_sum += a

            if a_sum > 0:
                out[y][x] = (r_sum // a_sum, g_sum // a_sum, b_sum // a_sum, a_sum // area)
            else:
                out[y][x] = (0, 0, 0, 0)

    return out


def write_png(path, pixels):
    """写出 RGBA PNG"""
    height = len(pixels)
    width = len(pixels[0])

    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for px in row:
            raw.extend(px)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')

    with open(path, 'wb') as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        pixels = render(size)
        path = os.path.join(OUT_DIR, 'icon%d.png' % size)
        write_png(path, pixels)
        print('生成 %s (%dx%d)' % (path, size, size))


if __name__ == '__main__':
    main()
