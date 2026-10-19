import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ASSETS_DIR = os.path.join(os.path.dirname(__file__), "assets")
os.makedirs(ASSETS_DIR, exist_ok=True)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_REGULAR = "C:/Windows/Fonts/segoeui.ttf"

def create_gradient(width, height, color1, color2, color3=None):
    base = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(base)
    for y in range(height):
        t = y / (height - 1)
        if color3 is None:
            r = int(color1[0] * (1 - t) + color2[0] * t)
            g = int(color1[1] * (1 - t) + color2[1] * t)
            b = int(color1[2] * (1 - t) + color2[2] * t)
        else:
            if t < 0.5:
                sub_t = t * 2
                r = int(color1[0] * (1 - sub_t) + color2[0] * sub_t)
                g = int(color1[1] * (1 - sub_t) + color2[1] * sub_t)
                b = int(color1[2] * (1 - sub_t) + color2[2] * sub_t)
            else:
                sub_t = (t - 0.5) * 2
                r = int(color2[0] * (1 - sub_t) + color3[0] * sub_t)
                g = int(color2[1] * (1 - sub_t) + color3[1] * sub_t)
                b = int(color2[2] * (1 - sub_t) + color3[2] * sub_t)
        draw.line([(0, y), (width, y)], fill=(r, g, b, 255))
    return base

def draw_orb(img, x, y, radius, color, alpha=100):
    orb = Image.new("RGBA", (radius * 2, radius * 2), (0, 0, 0, 0))
    orb_draw = ImageDraw.Draw(orb)
    orb_draw.ellipse([0, 0, radius * 2, radius * 2], fill=(color[0], color[1], color[2], alpha))
    orb = orb.filter(ImageFilter.GaussianBlur(radius // 2))
    img.alpha_composite(orb, (x - radius, y - radius))

def draw_card(
    filename,
    title,
    subtitle,
    badge,
    theme_colors,
    icon_symbol="✦"
):
    W, H = 1000, 500
    c_bg1, c_bg2, c_accent, c_glow = theme_colors

    img = create_gradient(W, H, c_bg1, c_bg2)

    # Ambient glows
    draw_orb(img, 150, 100, 220, c_glow, alpha=90)
    draw_orb(img, 850, 400, 250, c_accent, alpha=80)

    # Grid overlay
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    for x in range(0, W, 50):
        grid_draw.line([(x, 0), (x, H)], fill=(255, 255, 255, 8), width=1)
    for y in range(0, H, 50):
        grid_draw.line([(0, y), (W, y)], fill=(255, 255, 255, 8), width=1)
    img.alpha_composite(grid)

    # Main Glass Card
    card_x0, card_y0 = 60, 50
    card_x1, card_y1 = W - 60, H - 50
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    card_draw = ImageDraw.Draw(card)

    # Card background (dark translucent glass)
    card_draw.rounded_rectangle(
        [card_x0, card_y0, card_x1, card_y1],
        radius=28,
        fill=(15, 23, 42, 190),
        outline=(255, 255, 255, 45),
        width=2
    )

    # Top accent line
    card_draw.rounded_rectangle(
        [card_x0 + 40, card_y0 + 2, card_x0 + 160, card_y0 + 5],
        radius=2,
        fill=c_accent
    )

    img.alpha_composite(card)

    # Text & Details
    draw = ImageDraw.Draw(img)
    f_badge = ImageFont.truetype(FONT_BOLD, 18)
    f_title = ImageFont.truetype(FONT_BOLD, 46)
    f_sub = ImageFont.truetype(FONT_REGULAR, 24)
    f_icon = ImageFont.truetype(FONT_BOLD, 85)
    f_foot = ImageFont.truetype(FONT_REGULAR, 17)

    # Badge pill
    badge_text = f"  {badge.upper()}  "
    bbox = f_badge.getbbox(badge_text)
    bw = bbox[2] - bbox[0] + 20
    bh = 32
    bx0, by0 = 120, 105
    draw.rounded_rectangle(
        [bx0, by0, bx0 + bw, by0 + bh],
        radius=16,
        fill=(c_accent[0], c_accent[1], c_accent[2], 40),
        outline=(c_accent[0], c_accent[1], c_accent[2], 180),
        width=1
    )
    draw.text((bx0 + 10, by0 + 5), badge_text, font=f_badge, fill=c_accent)

    # Title
    draw.text((120, 160), title, font=f_title, fill=(255, 255, 255, 255))

    # Subtitle
    draw.text((120, 235), subtitle, font=f_sub, fill=(203, 213, 225, 230))

    # Decorative separator
    draw.line([(120, 310), (520, 310)], fill=(255, 255, 255, 40), width=1)
    draw.line([(120, 310), (220, 310)], fill=c_accent, width=2)

    # Footer note
    draw.text((120, 345), "⚡ BOT MESSENGER PRO  •  24/7 ACTIVE  •  SMART ENGINE", font=f_foot, fill=(148, 163, 184, 200))

    # Large Icon badge circle on right side
    cx, cy, cr = 750, 250, 110
    draw.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=(c_accent[0], c_accent[1], c_accent[2], 30), outline=(c_accent[0], c_accent[1], c_accent[2], 120), width=2)
    draw.ellipse([cx - cr + 15, cy - cr + 15, cx + cr - 15, cy + cr - 15], fill=(15, 23, 42, 220))
    
    ibox = f_icon.getbbox(icon_symbol)
    iw = ibox[2] - ibox[0]
    ih = ibox[3] - ibox[1]
    draw.text((cx - iw / 2, cy - ih / 2 - 10), icon_symbol, font=f_icon, fill=c_accent)

    out_path = os.path.join(ASSETS_DIR, filename)
    img.save(out_path, "PNG", optimize=True)
    print(f"Generated {out_path}")

# Themes: (bg1, bg2, accent, glow)
CARDS = [
    (
        "help.png",
        "DANH SÁCH LỆNH BOT",
        "Trợ lý thông minh • Quản lý & Tương tác nhóm",
        "HỆ THỐNG LỆNH",
        ((15, 23, 42), (30, 27, 75), (56, 189, 248), (129, 140, 248)),
        "⚡"
    ),
    (
        "welcome.png",
        "CHÀO MỪNG THÀNH VIÊN",
        "Rất vui được đón chào bạn gia nhập nhóm!",
        "MEMBER JOINED",
        ((6, 78, 59), (15, 23, 42), (52, 211, 153), (16, 185, 129)),
        "👋"
    ),
    (
        "rank.png",
        "BẢNG VÀNG HOẠT ĐỘNG",
        "Top thành viên tích cực & nhiều tin nhắn nhất",
        "LEADERBOARD",
        ((69, 26, 3), (15, 23, 42), (250, 204, 21), (245, 158, 11)),
        "🏆"
    ),
    (
        "checkin.png",
        "ĐIỂM DANH HÀNG NGÀY",
        "Duy trì ngọn lửa streak • Tích luỹ chuyên cần",
        "DAILY STREAK",
        ((67, 20, 7), (15, 23, 42), (251, 146, 60), (239, 68, 68)),
        "🔥"
    ),
    (
        "birthday.png",
        "CHÚC MỪNG SINH NHẬT",
        "Chúc bạn tuổi mới ngập tràn niềm vui & hạnh phúc",
        "HAPPY BIRTHDAY",
        ((76, 29, 149), (15, 23, 42), (244, 114, 182), (168, 85, 247)),
        "🎂"
    ),
    (
        "ship.png",
        "GHÉP ĐÔI HỢP CẠ",
        "Bói độ tâm đầu ý hợp giữa hai thành viên",
        "LOVE MATCH",
        ((136, 19, 55), (15, 23, 42), (251, 113, 133), (244, 63, 94)),
        "💖"
    ),
    (
        "poll.png",
        "CUỘC BÌNH CHỌN MỚI",
        "Khảo sát ý kiến • Thả reaction để bỏ phiếu",
        "GROUP VOTE",
        ((12, 74, 110), (15, 23, 42), (56, 189, 248), (14, 165, 233)),
        "🗳️"
    ),
    (
        "warning.png",
        "CẢNH CÁO VI PHẠM",
        "Nhắc nhở giữ gìn văn hóa trò chuyện của nhóm",
        "MODERATION",
        ((127, 29, 29), (15, 23, 42), (248, 113, 113), (220, 38, 38)),
        "⚠️"
    ),
]

for filename, title, subtitle, badge, colors, icon in CARDS:
    draw_card(filename, title, subtitle, badge, colors, icon)

print("All 8 banner cards generated successfully!")
