"""SNS共有画像（og-image.png）とアイコン類を生成する。 python tools/make_images.py"""
import math
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_B = r'C:\Windows\Fonts\YuGothB.ttc'
FONT_R = r'C:\Windows\Fonts\YuGothM.ttc'
BG, ACCENT, RED, GREEN, TEXT, MUTED = '#111418', '#5b92f0', '#e0453a', '#2e9d55', '#e7eaee', '#9aa3ae'


def trajectory(draw, x0, y0, w, h, s=1.0):
    """上昇（赤）→破裂→降下（緑）の軌跡と落下範囲の楕円"""
    up = [(x0 + w * 0.62 * t ** 1.4, y0 - h * t) for t in [i / 40 for i in range(41)]]
    bx, by = up[-1]
    down = [(bx + w * 0.38 * t, by + h * (1 - (1 - t) ** 1.6)) for t in [i / 30 for i in range(31)]]
    lx, ly = down[-1]
    for k, (rx, ry) in enumerate([(70, 34), (46, 22), (24, 12)]):
        draw.ellipse([lx - rx * s, ly - ry * s, lx + rx * s, ly + ry * s], outline=RED, width=max(1, int(2 * s)),
                     fill=(224, 69, 58, 30 + 25 * k))
    draw.line(up, fill=RED, width=int(6 * s), joint='curve')
    draw.line(down, fill=GREEN, width=int(6 * s), joint='curve')
    r = 9 * s
    draw.ellipse([bx - r, by - r, bx + r, by + r], fill=TEXT)
    draw.ellipse([x0 - r, y0 - r, x0 + r, y0 + r], fill=TEXT)
    return lx, ly


def og():
    img = Image.new('RGB', (1200, 630), BG)
    d = ImageDraw.Draw(img, 'RGBA')
    for i in range(0, 1200, 60):  # 方眼
        d.line([(i, 0), (i, 630)], fill=(255, 255, 255, 10))
    for j in range(0, 630, 60):
        d.line([(0, j), (1200, j)], fill=(255, 255, 255, 10))
    lx, ly = trajectory(d, 690, 540, 400, 420, 1.0)
    # 落下ピン
    d.polygon([(lx, ly - 4), (lx - 16, ly - 34), (lx + 16, ly - 34)], fill=RED)
    d.ellipse([lx - 18, ly - 66, lx + 18, ly - 30], fill=RED)
    d.ellipse([lx - 7, ly - 55, lx + 7, ly - 41], fill='white')
    fb = lambda n: ImageFont.truetype(FONT_B, n)
    fr = lambda n: ImageFont.truetype(FONT_R, n)
    d.text((70, 70), 'SORAYOMI', font=fb(40), fill=ACCENT)
    d.text((70, 150), 'どこまで上がり、', font=fb(64), fill=TEXT)
    d.text((70, 230), 'どこに落ちるか。', font=fb(64), fill=TEXT)
    d.text((70, 340), '気球・ロケット・ロックーンの', font=fr(32), fill=MUTED)
    d.text((70, 384), '軌跡と落下地点を、最新の気象予報で予測', font=fr(32), fill=MUTED)
    for k, label in enumerate(['気球', 'ロケット', 'ロックーン', 'ドローン']):
        x = 70 + k * 140
        d.rounded_rectangle([x, 470, x + 126, 518], radius=10, outline=ACCENT, width=2)
        tw = d.textlength(label, font=fr(24))
        d.text((x + 63 - tw / 2, 480), label, font=fr(24), fill=TEXT)
    d.text((70, 560), '無料・登録不要｜saku916.github.io/sorayomi', font=fr(22), fill=MUTED)
    img.save(os.path.join(ROOT, 'og-image.png'), optimize=True)


def icon(size):
    # 不透明の背景に描いてから角丸で切り抜く（半透明の重ね塗りを正しく合成するため）
    img = Image.new('RGB', (size, size), BG)
    d = ImageDraw.Draw(img, 'RGBA')
    s = size / 180
    trajectory(d, 30 * s, 140 * s, 100 * s, 105 * s, s * 0.5)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def favicon_svg():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#111418"/>
<ellipse cx="51" cy="52" rx="9" ry="4.5" fill="#e0453a" fill-opacity=".35" stroke="#e0453a" stroke-width="1.5"/>
<path d="M12 54 C 22 50, 32 30, 38 12" fill="none" stroke="#e0453a" stroke-width="4.5" stroke-linecap="round"/>
<path d="M38 12 C 44 22, 49 38, 51 52" fill="none" stroke="#2e9d55" stroke-width="4.5" stroke-linecap="round"/>
<circle cx="38" cy="12" r="4" fill="#e7eaee"/>
</svg>
"""
    with open(os.path.join(ROOT, 'favicon.svg'), 'w', encoding='utf-8') as f:
        f.write(svg)


if __name__ == '__main__':
    og()
    favicon_svg()
    icon(180).save(os.path.join(ROOT, 'apple-touch-icon.png'))
    icon(32).save(os.path.join(ROOT, 'favicon-32.png'))
    icon(192).save(os.path.join(ROOT, 'icon-192.png'))
    icon(512).save(os.path.join(ROOT, 'icon-512.png'))
    print('生成しました')
