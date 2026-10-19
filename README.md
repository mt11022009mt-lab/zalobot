# Bot quản lý nhóm Messenger

Bot thống kê hoạt động, chào mừng người mới, bình chọn và trò vui trong nhóm; quản trị viên có thể kick và ghi cảnh cáo.

## Cài đặt

1. Cài Node.js 20 trở lên. Trong thư mục dự án chạy `npm install`.
2. Dùng **tài khoản Facebook riêng cho bot**, thêm tài khoản này vào nhóm Messenger và cấp quyền quản trị viên nếu muốn dùng `!kick`.
3. Xuất phiên đăng nhập của tài khoản bot thành mảng cookie JSON theo định dạng `appState` của thư viện `@dongdev/fca-unofficial`; đặt tại `appstate.json` trong thư mục dự án, hoặc đặt biến môi trường `APPSTATE_PATH` trỏ tới file đó. Không gửi file này cho ai và không đưa lên Git.
4. Chạy `npm start`. Bot chỉ theo dõi nhóm mà tài khoản bot tham gia.

Các lệnh trong nhóm:

| Lệnh | Tác dụng |
| --- | --- |
| `!hoatdong` hoặc `!top` | Xếp hạng số tin nhắn trong 7 ngày; thêm `30` để xem 30 ngày. |
| `!imlang` | Liệt kê người chưa nhắn trong 7 ngày; thêm `30` để xem 30 ngày. |
| `!profile` | Thẻ thành viên: tin nhắn 30 ngày, hạng hoạt động, điểm danh và sinh nhật. Trả lời/tag/ID để xem người khác. |
| `!diemdanh` | Điểm danh một lần mỗi ngày, tính chuỗi ngày liên tiếp. |
| `!bangdiemdanh` | Bảng chuỗi điểm danh dài nhất. |
| `!bangtuongtac` | Các cặp tag hoặc trả lời nhau nhiều nhất trong 30 ngày. |
| `!sinhnhat DD/MM` | Lưu sinh nhật của mình. `!sinhnhat xem` để xem, `!sinhnhat xoa` để xóa. |
| `!binhchon Câu hỏi | A | B` | Tạo bình chọn có 2–5 lựa chọn. Thành viên react 1️⃣–5️⃣ trên tin nhắn bình chọn. |
| `!vote 1` | Bỏ hoặc đổi phiếu bằng lệnh khi không dùng được reaction emoji. |
| `!ketqua` | Xem kết quả bình chọn hiện tại hoặc gần nhất. |
| `!dongbinhchon` | Người tạo hoặc QTV đóng bình chọn. |
| `!dogay` | Xem điểm vui của chính mình; trả lời tin nhắn, tag hoặc thêm ID để xem người khác. |
| `!bangdogay` hoặc `!topgay` | Bảng xếp hạng điểm vui của nhóm trong ngày. |
| `!ship` | Ghép ngẫu nhiên người dùng với một thành viên khác trong nhóm; trả lời/tag/ID để chọn người. |
| `!kick` | QTV trả lời tin nhắn của thành viên cần kick, tag họ, hoặc dùng `!kick ID`. |
| `!canhbao lý do` | QTV trả lời/tag/ID để cảnh cáo. `!canhbao xem ID` và `!canhbao xoa ID` để xem/xóa lịch sử. |
| `!help` | Hiển thị lệnh. |

Dữ liệu lưu tại `data/activity.json` (đổi bằng `DATA_PATH`). Thống kê bắt đầu khi bot được bật, tính ngày theo múi giờ Việt Nam; không đọc lại lịch sử cũ. Lệnh và tin nhắn thường đều tính vào hoạt động. Số thứ tự chào mừng là **số người hiện trong nhóm sau khi gia nhập**, bao gồm tài khoản bot. Người rời rồi vào lại có thể nhận lại số thứ tự hiện tại.

Bot tự chúc sinh nhật từ 08:00 giờ Việt Nam khi đang chạy; nếu khởi động sau 08:00, bot chúc khi vừa hoạt động lại trong ngày đó. Chỉ thành viên hiện trong nhóm được chúc. Mỗi nhóm có một bình chọn mở tại một thời điểm; mỗi thành viên có một phiếu và có thể đổi bằng cách react emoji khác. Dữ liệu điểm danh, sinh nhật, cảnh cáo, bình chọn và tương tác được lưu cùng file thống kê.

Điểm `!dogay` là số ngẫu nhiên được tạo từ ID nhóm, ID thành viên và ngày tại Việt Nam. Điểm giữ nguyên trong ngày và đổi vào ngày hôm sau; **không dùng tin nhắn, hồ sơ hay dữ liệu cá nhân để suy đoán xu hướng tính dục**.

## Giới hạn cần biết

Thư viện đăng nhập Messenger này **không phải API chính thức của Meta**. Facebook có thể đổi cách đăng nhập, sự kiện nhóm hoặc quyền kick, nên bot có thể ngừng hoạt động và cần cập nhật thư viện. Các cuộc trò chuyện mã hóa đầu cuối có thể không phát đủ sự kiện cho thư viện. Không thể chạy thật trước khi có `appState` của tài khoản bot; không ghi mật khẩu Facebook vào mã nguồn.

Phiên bản `4.0.3` của thư viện hiện kéo theo các cảnh báo `npm audit` từ `sqlite3` và các gói con. Không dùng bot với tài khoản chính hoặc trên máy chứa dữ liệu nhạy cảm; cập nhật thư viện khi tác giả phát hành bản vá. Việc cài đặt có thể cần cho phép script cài đặt `sqlite3` nếu môi trường npm chặn script này.

## Kiểm tra bot trên Render

- Build command: `npm ci`; start command: `npm start` (hoặc `node index.js`).
- Đặt `APPSTATE_JSON` hoặc `APPSTATE_BASE64` trong **Environment** của Render. Đây là cookie đăng nhập, không đưa vào Git hoặc gửi vào chat/log. Nếu không có biến này, bot không thể đăng nhập vì `appstate.json` được loại khỏi Git.
- Mở URL dịch vụ: JSON `state: connected` và `messengerConnected: true` mới xác nhận kênh Messenger hoạt động. `login_failed` nghĩa là cần kiểm tra phiên/cookie; `disconnected` nghĩa là MQTT mất kết nối. `/health` chỉ kiểm tra web process.
- Trong Render → Settings → Health Checks, đặt path `/health` để theo dõi web process. Kiểm tra `/ready` riêng khi cần biết Messenger đã kết nối chưa (HTTP 503 nếu chưa). Không dùng `/ready` làm health check tự khởi động lại khi cookie hết hạn, vì Render có thể lặp đăng nhập; thay cookie rồi redeploy thủ công.
- Xem Render → Logs để phân biệt lỗi build, thiếu cookie, phiên hết hạn, và lỗi MQTT. Deploy thành công chỉ cho biết web service đã triển khai.
- Nếu dùng gói Free, web service có thể ngủ khi không có lưu lượng truy cập. Bot cần gói luôn chạy hoặc một background worker phù hợp. Nếu cần lưu thống kê qua lần redeploy, đặt `DATA_PATH` trên persistent disk.
- Log `Login successful!` chỉ xác nhận cookie. Nếu sau đó liên tục có `mqtt t_ms timeout` và `mqtt connection closed`, kênh nhận tin Messenger chưa đồng bộ; `/ready` sẽ báo 503. Kiểm tra lại tài khoản trong trình duyệt và log mới nhất, rồi thử redeploy một lần. Nếu vòng lặp vẫn còn, nguyên nhân nằm ở phiên realtime/thư viện hoặc kết nối đến Meta; thay gói Render không tự sửa được lỗi MQTT.
- Khi cài đặt, `postinstall` chỉ vá đúng bundle FCA phiên bản 4.0.3: tăng thời gian chờ `/t_ms` từ 8 lên 30 giây và giãn lần thử nối lại từ 2 lên 15 giây. Mục đích là tránh vòng lặp quá nhanh và cho kết nối chậm thêm thời gian đồng bộ. Nếu Meta không gửi `/t_ms` thì bản vá không thể tự khôi phục bot; xem `/ready` và Logs sau deploy. Script sẽ báo lỗi khi cấu trúc hoặc phiên bản thư viện thay đổi để không vá nhầm.
