const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(file) {
    this.file = file;
    this.backupFile = `${file}.bak`;
    this.data = this._loadData();
    this.data.groups ||= {};
    this._backfillTotals();
  }

  _loadData() {
    // 1. Thử đọc từ file dữ liệu chính
    if (fs.existsSync(this.file)) {
      try {
        const raw = fs.readFileSync(this.file, 'utf8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') return parsed;
        }
      } catch (err) {
        console.error(`[Store] Cảnh báo lỗi đọc file chính ${this.file}:`, err.message);
      }
    }

    // 2. Nếu file chính lỗi hoặc trống, thử đọc từ file backup dự phòng
    if (fs.existsSync(this.backupFile)) {
      try {
        const raw = fs.readFileSync(this.backupFile, 'utf8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            console.log(`[Store] Đã tự động khôi phục dữ liệu từ bản sao lưu ${this.backupFile}`);
            return parsed;
          }
        }
      } catch (err) {
        console.error(`[Store] Cảnh báo lỗi đọc file backup ${this.backupFile}:`, err.message);
      }
    }

    // 3. Nếu trên môi trường cloud (Render) chưa có file, thử nạp từ biến môi trường ACTIVITY_BACKUP_JSON
    if (process.env.ACTIVITY_BACKUP_JSON) {
      try {
        const parsed = JSON.parse(process.env.ACTIVITY_BACKUP_JSON);
        if (parsed && typeof parsed === 'object') {
          console.log('[Store] Đã nạp dữ liệu khởi tạo từ biến môi trường ACTIVITY_BACKUP_JSON');
          return parsed;
        }
      } catch (err) {
        console.error('[Store] Lỗi đọc ACTIVITY_BACKUP_JSON:', err.message);
      }
    }

    return { groups: {} };
  }

  _backfillTotals() {
    // Tự động tính toán bù đắp bảng bộ nhớ đếm tin nhắn vĩnh viễn từ lịch sử ngày cũ
    for (const [tid, group] of Object.entries(this.data.groups || {})) {
      group.messageCounts ||= {};
      group.totalMessages = Number(group.totalMessages) || 0;

      if (group.days && typeof group.days === 'object') {
        for (const dayBucket of Object.values(group.days)) {
          if (!dayBucket || typeof dayBucket !== 'object') continue;
          for (const [uid, count] of Object.entries(dayBucket)) {
            const num = Number(count) || 0;
            if (num > 0) {
              group.messageCounts[uid] = Math.max(group.messageCounts[uid] || 0, num);
            }
          }
        }
      }

      const sum = Object.values(group.messageCounts).reduce((acc, n) => acc + (Number(n) || 0), 0);
      if (group.totalMessages < sum) {
        group.totalMessages = sum;
      }
    }
  }

  group(threadID) {
    const id = String(threadID);
    const group = (this.data.groups[id] ||= {});
    group.members ||= [];
    group.names ||= {};
    group.days ||= {};
    group.messageCounts ||= {}; // Bảng bộ nhớ đếm tin nhắn vĩnh viễn theo từng thành viên
    group.totalMessages ||= 0;   // Tổng tin nhắn tích lũy toàn thời gian của cả nhóm
    group.recentIDs ||= [];
    group.interactions ||= {};
    group.checkins ||= {};
    group.birthdays ||= {};
    group.birthdayAnnounced ||= {};
    group.warnings ||= {};
    return group;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const json = JSON.stringify(this.data, null, 2);
      fs.writeFileSync(tmp, json, { mode: 0o600 });
      fs.renameSync(tmp, this.file);

      // Lưu thêm 1 bản sao lưu dự phòng (backup) để chống crash / hỏng file đột ngột
      try {
        fs.writeFileSync(this.backupFile, json, { mode: 0o600 });
      } catch {}
    } catch (err) {
      console.error('[Store] Lỗi lưu trữ dữ liệu:', err.message);
    }
  }
}

module.exports = { Store };
