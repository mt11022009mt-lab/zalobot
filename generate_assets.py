import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ASSETS_DIR = os.path.join(os.path.dirname(__file__), "assets")
os.makedirs(ASSETS_DIR, exist_ok=True)

# Standard Windows TTF fonts
FONT_BOLD_PATH = "C:/Windows/Fonts/segoeuib.ttf"
FONT_REGULAR_PATH = "C:/Windows/Fonts/segoeui.ttf"
FONT_SEMI_PATH = "C:/Windows/Fonts/segoeuisl.ttf"

def create_diagonal_gradient(width, height, c1, c2, c3):
    base = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(base)
    # 135-degree diagonal calculation
    max_d = width + height
    for y in range(height):
        for x in range(0, width, 2):  # step 2 for speed
            d = (x + y) / max_d
            if d < 0.56:
                t = d / 0.56
                r = int(c1[0] * (1 - t) + c2[0] * t)
                g = int(c1[1] * (1 - t) + c2[1] * t)
                b = int(c1[2] * (1 - t) + c2[2] * t)
            else:
                t = (d - 0.56) / 0.44
                r = int(c2[0] * (1 - t) + c3[0] * t)
                g = int(c2[1] * (1 - t) + c3[1] * t)
                b = int(c2[2] * (1 - t) + c3[2] * t)
            draw.point([(x, y), (x + 1, y)], fill=(r, g, b, 255))
    return base

def draw_orb(img, x, y, radius, color, alpha=90):
    orb = Image.new("RGBA", (radius * 2, radius * 2), (0, 0, 0, 0))
    orb_draw = ImageDraw.Draw(orb)
    orb_draw.ellipse([0, 0, radius * 2, radius * 2], fill=(color[0], color[1], color[2], alpha))
    orb = orb.filter(ImageFilter.GaussianBlur(radius // 2))
    img.alpha_composite(orb, (x - radius, y - radius))

def draw_card(
    filename,
    badge,
    title,
    subtitle,
    accent_rgb,
    metrics,
    icon_symbol,
    tagline="CYBER ASSISTANT ENGINE • 24/7 ACTIVE • HIGH PRECISION"
):
    W, H = 1200, 630
    
    # 1. Base Gradient Background (Deep Night Cyber)
    c_bg1 = (9, 14, 28)
    c_bg2 = (16, 26, 50)
    c_bg3 = (6, 10, 20)
    
    img = create_diagonal_gradient(W, H, c_bg1, c_bg2, c_bg3)
    
    # 2. Ambient Orbs (Accent Glow)
    draw_orb(img, 950, 310, 260, accent_rgb, alpha=65)
    draw_orb(img, 180, 140, 220, accent_rgb, alpha=40)
    draw_orb(img, 600, 580, 200, (30, 58, 138), alpha=50)

    # 3. Precision Grid & Micro Cyber Crosses
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ov_draw = ImageDraw.Draw(overlay)
    
    grid_spacing = 40
    for x in range(0, W, grid_spacing):
        ov_draw.line([(x, 0), (x, H)], fill=(255, 255, 255, 6), width=1)
    for y in range(0, H, grid_spacing):
        ov_draw.line([(0, y), (W, y)], fill=(255, 255, 255, 6), width=1)
        
    # Corner technical crosses
    crosses = [(80, 80), (W - 80, 80), (80, H - 80), (W - 80, H - 80), (600, 80)]
    for cx, cy in crosses:
        ov_draw.line([(cx - 6, cy), (cx + 6, cy)], fill=(255, 255, 255, 30), width=1)
        ov_draw.line([(cx, cy - 6), (cx, cy + 6)], fill=(255, 255, 255, 30), width=1)
    
    img.alpha_composite(overlay)

    # 4. Glassmorphism Card Container
    card_x0, card_y0 = 50, 45
    card_x1, card_y1 = W - 50, H - 45
    card_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    card_draw = ImageDraw.Draw(card_layer)
    
    # Dark glass base with subtle blur appearance
    card_draw.rounded_rectangle(
        [card_x0, card_y0, card_x1, card_y1],
        radius=32,
        fill=(15, 23, 42, 215),
        outline=(255, 255, 255, 25),
        width=1
    )
    
    # Outer accent border stroke (Top-left to bottom-right highlight)
    card_draw.rounded_rectangle(
        [card_x0 + 1, card_y0 + 1, card_x1 - 1, card_y1 - 1],
        radius=31,
        outline=(accent_rgb[0], accent_rgb[1], accent_rgb[2], 75),
        width=1
    )
    
    # Top-left luminous highlight strip
    card_draw.rounded_rectangle(
        [card_x0 + 50, card_y0 + 2, card_x0 + 220, card_y0 + 5],
        radius=2,
        fill=(accent_rgb[0], accent_rgb[1], accent_rgb[2], 220)
    )

    img.alpha_composite(card_layer)

    # 5. Typography & Content
    draw = ImageDraw.Draw(img)
    f_badge = ImageFont.truetype(FONT_BOLD_PATH, 16)
    f_title = ImageFont.truetype(FONT_BOLD_PATH, 46)
    f_sub = ImageFont.truetype(FONT_REGULAR_PATH, 23)
    f_metric_val = ImageFont.truetype(FONT_BOLD_PATH, 20)
    f_metric_lbl = ImageFont.truetype(FONT_REGULAR_PATH, 14)
    f_tagline = ImageFont.truetype(FONT_REGULAR_PATH, 15)
    f_icon = ImageFont.truetype(FONT_BOLD_PATH, 92)

    # Left content starting anchor
    lx = 100

    # Badge Pill (with micro glowing dot)
    badge_text = f"  {badge.upper()}  "
    bbox = f_badge.getbbox(badge_text)
    bw = bbox[2] - bbox[0] + 34
    bh = 34
    by0 = 92
    
    # Pill background & border
    draw.rounded_rectangle(
        [lx, by0, lx + bw, by0 + bh],
        radius=17,
        fill=(accent_rgb[0], accent_rgb[1], accent_rgb[2], 35),
        outline=(accent_rgb[0], accent_rgb[1], accent_rgb[2], 160),
        width=1
    )
    # Luminous green/accent micro dot
    dot_r = 4
    draw.ellipse([lx + 14 - dot_r, by0 + 17 - dot_r, lx + 14 + dot_r, by0 + 17 + dot_r], fill=accent_rgb)
    draw.text((lx + 24, by0 + 6), badge_text, font=f_badge, fill=accent_rgb)

    # Title (Pristine White)
    draw.text((lx, 150), title, font=f_title, fill=(245, 248, 255, 255))

    # Subtitle (Muted Slate / Ice Blue)
    draw.text((lx, 222), subtitle, font=f_sub, fill=(183, 197, 216, 230))

    # 6. Metric Chips Row (3 Highlights)
    mx = lx
    my = 295
    for m_val, m_lbl in metrics:
        v_bbox = f_metric_val.getbbox(m_val)
        l_bbox = f_metric_lbl.getbbox(m_lbl)
        chip_w = max(v_bbox[2] - v_bbox[0], l_bbox[2] - l_bbox[0]) + 36
        chip_w = max(chip_w, 140)
        chip_h = 68
        
        # Chip background
        draw.rounded_rectangle(
            [mx, my, mx + chip_w, my + chip_h],
            radius=14,
            fill=(30, 41, 59, 160),
            outline=(255, 255, 255, 25),
            width=1
        )
        # Accent top bar on chip
        draw.line([(mx + 12, my + 1), (mx + 38, my + 1)], fill=accent_rgb, width=2)
        
        # Metric value & label
        draw.text((mx + 16, my + 12), m_val, font=f_metric_val, fill=accent_rgb)
        draw.text((mx + 16, my + 40), m_lbl, font=f_metric_lbl, fill=(148, 163, 184, 220))
        
        mx += chip_w + 16

    # 7. Decorative Separator & Tech Footer
    sep_y = 445
    draw.line([(lx, sep_y), (lx + 580, sep_y)], fill=(255, 255, 255, 30), width=1)
    draw.line([(lx, sep_y), (lx + 140, sep_y)], fill=accent_rgb, width=2)

    draw.text((lx, sep_y + 25), f"⚡ {tagline}", font=f_tagline, fill=(148, 163, 184, 210))

    # 8. Right-side Focal Emblem / Holographic Rings
    rx, ry = 950, 315
    
    # Concentric circles
    draw.ellipse([rx - 175, ry - 175, rx + 175, ry + 175], outline=(accent_rgb[0], accent_rgb[1], accent_rgb[2], 40), width=1)
    draw.ellipse([rx - 142, ry - 142, rx + 142, ry + 142], outline=(255, 255, 255, 35), width=1)
    draw.ellipse([rx - 110, ry - 110, rx + 110, ry + 110], fill=(accent_rgb[0], accent_rgb[1], accent_rgb[2], 25), outline=(accent_rgb[0], accent_rgb[1], accent_rgb[2], 140), width=2)
    draw.ellipse([rx - 85, ry - 85, rx + 85, ry + 85], fill=(15, 23, 42, 230), outline=(255, 255, 255, 20), width=1)

    # Hologram orbital nodes
    for angle in [0, 45, 90, 135, 180, 225, 270, 315]:
        rad = math.radians(angle)
        nx = rx + int(142 * math.cos(rad))
        ny = ry + int(142 * math.sin(rad))
        draw.ellipse([nx - 3, ny - 3, nx + 3, ny + 3], fill=accent_rgb)

    # Center Emblem Icon
    ibox = f_icon.getbbox(icon_symbol)
    iw = ibox[2] - ibox[0]
    ih = ibox[3] - ibox[1]
    draw.text((rx - iw / 2, ry - ih / 2 - 8), icon_symbol, font=f_icon, fill=accent_rgb)

    out_path = os.path.join(ASSETS_DIR, filename)
    img.save(out_path, "PNG", optimize=True)
    print(f"Generated {out_path}")

# ==============================================================================
# 13 CARD SPECIFICATIONS (Designed by OpenAI Codex & Antigravity)
# ==============================================================================
CARDS_SPEC = [
    (
        "help.png",
        "CYBER ASSISTANT",
        "TRUNG TÂM LỆNH BOT",
        "Mọi công cụ quản lý và giải trí nhóm trong tầm tay",
        (71, 215, 255),  # Cyan Neon #47D7FF
        [("12 LỆNH", "Tính năng sẵn có"), ("4 PHÂN HỆ", "Quản lý & Tương tác"), ("24/7 ONLINE", "Tốc độ tức thì")],
        "⚡"
    ),
    (
        "profile.png",
        "MEMBER PROFILE",
        "HỒ SƠ THÀNH VIÊN",
        "Thẻ định danh hoạt động, danh hiệu và cấp bậc cá nhân",
        (143, 136, 255),  # Lavender Neon #8F88FF
        [("LEVEL ĐẠT", "Cấp bậc thành viên"), ("STREAK", "Chuỗi ngày giữ lửa"), ("TƯƠNG TÁC", "Điểm số đóng góp")],
        "👤"
    ),
    (
        "rank.png",
        "LEADERBOARD",
        "BẢNG VÀNG TOP 10",
        "Vinh danh những thành viên sôi nổi và năng nổ nhất",
        (255, 209, 102),  # Gold Neon #FFD166
        [("TOP 1", "Quán quân tuần"), ("TỔNG ĐIỂM", "Điểm tương tác cao"), ("TOP 10", "Ghi danh bảng vàng")],
        "🏆"
    ),
    (
        "checkin.png",
        "DAILY STREAK",
        "GIỮ LỬA MỖI NGÀY",
        "Điểm danh duy trì ngọn lửa chuyên cần và mở quà",
        (255, 136, 77),  # Flame Orange #FF884D
        [("NGỌN LỬA", "Streak duy trì"), ("THƯỞNG", "+100 EXP tích luỹ"), ("MỐC MỚI", "Huy hiệu sắp mở")],
        "🔥"
    ),
    (
        "stats.png",
        "GROUP PULSE",
        "SỨC KHỎE NHÓM",
        "Báo cáo nhịp độ hoạt động và mức độ gắn kết",
        (53, 224, 181),  # Emerald Neon #35E0B5
        [("TỔNG TIN", "Lưu lượng tuần"), ("THÀNH VIÊN", "Quy mô nhóm"), ("TỶ LỆ ACTIVE", "Thành viên hoạt động")],
        "📊"
    ),
    (
        "birthday.png",
        "CELEBRATION",
        "CHÚC MỪNG SINH NHẬT",
        "Tuổi mới rực rỡ, hạnh phúc và vạn sự như ý",
        (255, 182, 213),  # Rose Pink #FFB6D5
        [("SINH NHẬT", "Ngày đặc biệt"), ("QUÀ TẶNG", "Huy hiệu sinh nhật"), ("LỜI CHÚC", "Cả nhóm chúc mừng")],
        "🎂"
    ),
    (
        "ship.png",
        "MATCH SIGNAL",
        "TÍN HIỆU ĐÔI BẠN",
        "Bói độ tâm đầu ý hợp và ghép đôi kết nối thành viên",
        (255, 111, 145),  # Crimson Neon #FF6F91
        [("ĐỘ HỢP CẠ", "Phần trăm gắn kết"), ("DANH HIỆU", "Cặp đôi ăn ý"), ("BẮT SÓNG", "Tần số kết nối")],
        "💖"
    ),
    (
        "poll.png",
        "LIVE POLL",
        "CUỘC BÌNH CHỌN MỚI",
        "Lấy ý kiến tập thể nhanh chóng bằng reaction cảm xúc",
        (126, 187, 255),  # Sky Blue #7EBBFF
        [("LỰA CHỌN", "Tối đa 5 phương án"), ("REACTION", "Bỏ phiếu 1 chạm"), ("MINH BẠCH", "Cập nhật realtime")],
        "🗳️"
    ),
    (
        "fun.png",
        "FUN SCAN",
        "MÁY ĐO ĐỘ QUẬY",
        "Thước đo nhân phẩm, năng lượng hài hước và giải trí",
        (183, 255, 90),  # Lime Neon #B7FF5A
        [("ĐỘ QUẬY", "Chỉ số năng lượng"), ("NHÂN PHẨM", "May mắn trong ngày"), ("DANH HIỆU", "Biệt danh giải trí")],
        "🎯"
    ),
    (
        "warning.png",
        "MODERATION",
        "CẢNH BÁO NỘI QUY",
        "Nhắc nhở giữ gìn văn hóa ứng xử và quy định nhóm",
        (255, 107, 107),  # Coral Red #FF6B6B
        [("MỨC PHẠT", "Cảnh cáo chính thức"), ("3 LẦN PHẠT", "Tự động kick nhóm"), ("KỶ LUẬT", "QTV phê duyệt")],
        "⚠️"
    ),
    (
        "cleanup.png",
        "GROUP CLEANUP",
        "RÀ SOÁT THÀNH VIÊN",
        "Lọc danh sách thành viên không hoạt động lâu ngày",
        (243, 166, 74),  # Amber Gold #F3A64A
        [("NGƯỠNG LỌC", "Số ngày inactive"), ("DANH SÁCH", "Thành viên vắng mặt"), ("BẢO VỆ", "Tránh kick nhầm")],
        "🧹"
    ),
    (
        "admin.png",
        "ADMIN TEAM",
        "BAN QUẢN TRỊ NHÓM",
        "Danh sách đội ngũ hỗ trợ và điều hành nhóm",
        (177, 156, 255),  # Royal Purple #B19CFF
        [("TRƯỞNG NHÓM", "Điều hành chung"), ("PHÓ NHÓM", "Quản lý thành viên"), ("HỖ TRỢ", "Trực ban 24/7")],
        "🛡️"
    ),
    (
        "welcome.png",
        "MEMBER JOINED",
        "CHÀO MỪNG THÀNH VIÊN",
        "Rất vui được đón chào bạn gia nhập đại gia đình",
        (52, 211, 153),  # Emerald Mint #34D399
        [("THÀNH VIÊN", "Vị trí gia nhập"), ("HƯỚNG DẪN", "Gõ !help xem lệnh"), ("KẾT NỐI", "Giao lưu cùng nhóm")],
        "👋"
    )
]

def main():
    for spec in CARDS_SPEC:
        draw_card(
            filename=spec[0],
            badge=spec[1],
            title=spec[2],
            subtitle=spec[3],
            accent_rgb=spec[4],
            metrics=spec[5],
            icon_symbol=spec[6]
        )
    print("All 13 Cyber Glassmorphism cards generated at 1200x630 successfully!")

if __name__ == "__main__":
    main()
