# 🤖 Bot Telegram Check LIVE/DIE & Thông Tin MXH (FB - TikTok - Instagram)

Hệ thống Bot Telegram chuyên dụng giúp tra cứu thông tin và **kiểm tra trạng thái LIVE / DIE** của các tài khoản mạng xã hội: **Facebook**, **TikTok** và **Instagram**, hỗ trợ **tự động bóc tách đa dạng mọi loại liên kết**.

---

## 🔗 Đa Dạng Liên Kết Được Hỗ Trợ

Bot được tích hợp bộ phân tích thông minh, tự động nhận diện và bóc tách chính xác tên tài khoản từ hầu hết mọi kiểu link:

### 1. 🎵 TikTok:
- Link hồ sơ: `https://www.tiktok.com/@username`, `m.tiktok.com/@username`
- Link video: `https://www.tiktok.com/@username/video/73456789...` *(tự động bóc tách username của tác giả video)*
- Link phát trực tiếp: `https://www.tiktok.com/@username/live`
- Link ảnh: `https://www.tiktok.com/@username/photo/...`
- **Link rút gọn chia sẻ từ app:** `https://vt.tiktok.com/ZSjxxxx/`, `https://vm.tiktok.com/xxxx/` *(tự động giải mã redirect sang link gốc)*
- Tự động lọc sạch các mã theo dõi: `?_t=...`, `?_r=...`, `?is_from_webapp=1`

### 2. 📘 Facebook:
- Link Trang / Fanpage / Profile: `https://www.facebook.com/username`, `fb.com/username`
- Link ID cá nhân: `https://www.facebook.com/profile.php?id=100012345678`
- Link định dạng People: `https://www.facebook.com/people/Ten-Nguoi-Dung/100012345678/`
- Link bài viết / ảnh / video: `https://www.facebook.com/username/posts/pfbid...`, `facebook.com/username/photos/...`
- Hỗ trợ các subdomain: `m.facebook.com`, `mbasic.facebook.com`, `web.facebook.com`, `fb.me`
- Tự động lọc sạch tracking: `?mibextid=...`, `?ref=...`, `?fref=...`

### 3. 📸 Instagram:
- Link cá nhân: `https://www.instagram.com/username`, `instagr.am/username`
- Link tab Reels / Tagged: `https://www.instagram.com/username/reels/`, `instagram.com/username/tagged/`
- Link sâu (Deep link): `https://www.instagram.com/_u/username/`
- Tự động lọc sạch tham số chia sẻ app: `?igsh=...`, `?utm_source=...`

---

## ⚡ Tính Năng Chính

- 🟢 **LIVE / 🔴 DIE tức thì:** Quét nhanh trạng thái sống/chết của tài khoản mà không cần có API token.
- 📋 **Check Hàng Loạt (Batch Mode):** Dán danh sách 5-25 tài khoản (mỗi dòng một link hoặc username), bot tự động kiểm tra và trả về bảng thống kê chi tiết.
- 🔍 **Tra cứu chi tiết:** Tên thật, Bio, Số người theo dõi, Lượt thích, Bài viết, Tích xanh, Trạng thái riêng tư, Avatar HD.
- 🛡️ **Zero-Dependency:** 100% thư viện chuẩn Python (`urllib`, `json`, `re`). Không cần cài thêm thư viện bên ngoài.
- 🧪 **Kiểm thử TDD:** 10/10 Unit Tests hoàn thành xuất sắc.

---

## 🚀 Hướng Dẫn Sử Dụng Nhanh

### Bước 1: Điền Token Bot
Tạo file `.env` từ `.env.example` và điền:
```env
TELEGRAM_BOT_TOKEN=Điền_Token_Của_BotFather_Vào_Đây
```

### Bước 2: Khởi Động Bot
Nhấp đúp chuột vào file **`run_bot.bat`** (hoặc chạy lệnh `python bot.py`).

---

## 📱 Bảng Lệnh Trên Telegram

| Cú pháp | Ví dụ | Ý nghĩa |
| :--- | :--- | :--- |
| `/live <link hoặc handle>` | `/live vt.tiktok.com/ZSjxx/` | **Check trạng thái LIVE hay DIE tức thì** |
| `/check <link>` | `/check instagram.com/cristiano` | Tra cứu chi tiết tài khoản + badge Live/Die |
| **Dán link trực tiếp** | `fb.com/vinfastvietnam` | Tự động nhận diện nền tảng & tra cứu |
| **Gửi danh sách nhiều dòng** | Dán 10 link cùng lúc | **Quét & Thống kê Live/Die hàng loạt** |
| `/help` | `/help` | Xem hướng dẫn cú pháp |

---

## 🧪 Chạy Kiểm Thử Tự Động
```bash
python -m unittest discover -s tests
```
