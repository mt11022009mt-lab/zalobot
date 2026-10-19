# Bot Zalo Quản Lý Nhóm Tự Động (Tài khoản cá nhân)

Hệ thống bot Zalo sử dụng tài khoản cá nhân, thư viện `@zca-mt/zca` (bản build chuẩn và mới nhất từ core `zca-js`):
- 👋 **Tự động chào mừng thành viên mới** tham gia nhóm (tag tên mention).
- 🚫 **Tự động phát hiện & xóa/thu hồi tin nhắn chứa link nhóm Zalo** (`zalo.me/g/...`).
- 🔐 **Lưu session tự động**: Chỉ cần quét mã QR lần đầu tiên, các lần sau tự động đăng nhập không cần quét lại.

## Cài đặt & Chuẩn bị

1. Thư mục dự án: `C:\Users\Administrator\.gemini\antigravity\scratch\zalo-group-bot`
2. Cài đặt các thư viện (đã cài đặt sẵn):
   ```bash
   npm install @zca-mt/zca qrcode-terminal
   ```

## Cách chạy bot

Mở terminal tại thư mục này và gõ:
```bash
node index.js
```

1. Màn hình terminal sẽ xuất hiện **Mã QR Code**.
2. Mở Zalo trên điện thoại -> Quét mã QR -> Bấm **Xác nhận đăng nhập**.
3. Bot sẽ lưu thông tin đăng nhập vào file `session.json`. Từ lần chạy sau, bot tự vào thẳng không cần quét lại.

> **Lưu ý quan trọng khi quản lý nhóm:**
> - Để bot có quyền **thu hồi / xóa tin nhắn của thành viên khác**, tài khoản Zalo làm bot cần được set làm **Phó nhóm** hoặc **Trưởng nhóm**.
> - Nếu là thành viên thường, bot chỉ có thể thu hồi tin nhắn do chính bot gửi.
