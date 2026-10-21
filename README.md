# Bot Quản Lý Nhóm Messenger

Bot trợ lý quản lý nhóm, thống kê tương tác, bảng bộ nhớ đếm tin nhắn vĩnh viễn, chào mừng thành viên mới, bình chọn, máy đo độ quậy và mini game kết nối nhóm.

## Cài Đặt & Chạy Cục Bộ

1. Cài Node.js 20 trở lên. Trong thư mục dự án chạy `npm install`.
2. Dùng **tài khoản Facebook riêng cho bot**, thêm tài khoản này vào nhóm Messenger và cấp quyền quản trị viên nếu muốn dùng `!kick`.
3. Cung cấp cookie đăng nhập qua biến môi trường `APPSTATE_JSON` hoặc file `appstate.json` (không commit cookie lên git).
4. Khởi chạy bot bằng `npm start`.

---

## 📋 Danh Sách Lệnh Trong Nhóm

| Lệnh | Tác Dụng |
| --- | --- |
| `!demtin` / `!bangtinnhan` / `!tongtin` | **Bảng bộ nhớ đếm tin nhắn vĩnh viễn** toàn thời gian (lưu an toàn, không bị mất khi bot khởi động lại). |
| `!hoatdong` / `!top` / `!rank` `[7\|30\|all]` | Bảng vàng chat 7 ngày, 30 ngày hoặc toàn bộ thời gian (`all`). |
| `!thongke` / `!stats` `[7\|30]` | Thống kê sức khỏe nhóm, tỷ lệ active và tổng tin nhắn lưu trong bộ nhớ. |
| `!imlang` `[7\|30]` | Liệt kê thành viên ít tương tác trong 7 hoặc 30 ngày qua. |
| `!profile` / `!hoso` | Thẻ hồ sơ thành viên: tin 30 ngày, tổng tin nhắn tích luỹ vĩnh viễn, xếp hạng, chuỗi điểm danh, sinh nhật. |
| `!diemdanh` | Điểm danh mỗi ngày một lần, giữ chuỗi streak liên tiếp. |
| `!bangdiemdanh` | Bảng vàng chuyên cần điểm danh dài nhất nhóm. |
| `!bangtuongtac` | Top các cặp đôi tương tác / reply / tag nhau nhiều nhất 30 ngày. |
| `!sinhnhat DD/MM` | Cài đặt ngày sinh nhật (bot tự động gửi thiệp chúc lúc 08:00 sáng). Dùng `!sinhnhat xem` hoặc `!sinhnhat xoa`. |
| `!binhchon Câu hỏi \| A \| B` | Tạo cuộc bình chọn có 2–5 lựa chọn. React 1️⃣–5️⃣ hoặc gõ `!vote [1-5]` để bỏ phiếu. |
| `!ketqua` / `!dongbinhchon` | Xem kết quả bình chọn / QTV hoặc người tạo đóng bình chọn. |
| `!doquay` (hoặc `!dogay`) | Máy đo độ quậy ngẫu nhiên hôm nay của bản thân hoặc người được tag / reply. |
| `!bangdoquay` (hoặc `!bangdogay`) | Bảng xếp hạng độ quậy của các thành viên trong nhóm hôm nay. |
| `!ghepdoi` (hoặc `!ship`) | Ghép đôi bói độ hợp cạ ngẫu nhiên giữa 2 thành viên. |
| `!qtv` / `!admin` | Xem danh sách ban quản trị nhóm hiện tại. |
| `!canhbao [tag/reply/ID] [lý do]` | Quản trị viên cảnh cáo thành viên vi phạm (`!canhbao xem ID`, `!canhbao xoa ID`). |
| `!kick [tag/reply/ID]` | Quản trị viên mời thành viên ra khỏi nhóm. |
| `!help` | Xem trung tâm trợ giúp và danh mục toàn bộ lệnh bot. |

---

## 💾 Cơ Chế Bộ Nhớ & Chống Mất Dữ Liệu (Persistence)

- Dữ liệu hoạt động được lưu an toàn tại `data/activity.json`.
- **Cơ chế sao lưu tự động (Backup & Anti-corruption):** Mỗi khi lưu, bot tự động nhân bản thêm file dự phòng `data/activity.json.bak`. Nếu file chính gặp sự cố do ngắt đột ngột, bot sẽ tự động khôi phục từ bản sao lưu gần nhất.
- **Graceful Shutdown:** Khi server nhận tín hiệu tắt (`SIGTERM`, `SIGINT`), toàn bộ bộ nhớ tin nhắn và trạng thái sẽ được đồng bộ ngay lập tức vào đĩa.
- **Web Snapshot Endpoints:** Máy chủ HTTP cung cấp endpoint `GET /backup` và `GET /data` để người quản trị có thể tải hoặc kiểm tra bản snapshot dữ liệu bất cứ lúc nào qua trình duyệt.
