const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFeatures } = require('./features');

const TZ = 'Asia/Ho_Chi_Minh';
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
});

function dayKey(timestamp = Date.now()) {
  const parts = Object.fromEntries(dayFormat.formatToParts(new Date(timestamp))
    .filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function daysAgo(n, now = Date.now()) {
  const today = dayKey(now);
  return new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000)
    .toISOString().slice(0, 10);
}

function memberID(value) {
  if (value == null) return '';
  if (typeof value === 'object') return String(value.id ?? value.userFbId ?? value.userID ?? '');
  return String(value);
}

function memberName(value, fallback) {
  return String(value?.name ?? value?.fullName ?? fallback).replace(/[\r\n]+/g, ' ').slice(0, 80);
}

function adminSet(info) {
  return new Set((info.adminIDs || []).map(memberID).filter(Boolean));
}

function countFor(group, userID, period, now = Date.now()) {
  const start = daysAgo(period - 1, now);
  const end = dayKey(now);
  let count = 0;
  let activeDays = 0;
  for (const [day, byUser] of Object.entries(group.days || {})) {
    if (day >= start && day <= end) {
      const n = byUser[userID] || 0;
      count += n;
      if (n > 0) activeDays++;
    }
  }
  return { count, activeDays };
}

function funScore(threadID, userID, day) {
  const digest = createHash('sha256').update(`dogay-v1:${threadID}:${day}:${userID}`).digest();
  return digest.readUInt32BE(0) % 101;
}

function scoreBar(score, width = 10) {
  const filled = Math.round(score / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function createBot(api, store, options = {}) {
  const botID = String(api.getCurrentUserID());
  const rawSend = options.send || ((text, threadID) => api.sendMessage(text, threadID));
  const send = (msg, threadID, imageKey) => {
    if (typeof msg === 'string' && imageKey && !options.send) {
      const imgPath = path.join(__dirname, '..', 'assets', `${imageKey}.png`);
      if (fs.existsSync(imgPath)) {
        return rawSend({ body: msg, attachment: fs.createReadStream(imgPath) }, threadID);
      }
    }
    return rawSend(msg, threadID);
  };
  const info = options.getThreadInfo || (threadID => api.getThreadInfo(threadID));
  const remove = options.removeUserFromGroup || ((userID, threadID) => api.removeUserFromGroup(userID, threadID));
  const now = options.now || (() => Date.now());
  const features = createFeatures({ botID, store, send, info, now, dayKey, daysAgo });

  async function groupInfo(threadID, added = []) {
    const details = await info(threadID);
    if (!details?.isGroup) return null;
    const group = store.group(threadID);
    if (!group.initialized) {
      const addedIDs = new Set(added.map(memberID));
      group.members = (details.participantIDs || []).map(String).filter(id => !addedIDs.has(id));
      group.initialized = true;
      store.save();
    }
    return { details, group };
  }

  async function handleJoin(event) {
    const added = event.logMessageData?.addedParticipants || event.eventData?.addedParticipants || [];
    if (!Array.isArray(added) || !added.length) return;
    const found = await groupInfo(event.threadID, added);
    if (!found) return;
    const { details, group } = found;
    const all = new Set(group.members);
    const memberNames = new Map((details.userInfo || []).map(u => [String(u.id), memberName(u, u.id)]));
    // The current thread list reflects the members after this join event.
    const currentTotal = new Set((details.participantIDs || []).map(String)).size;
    const fresh = [...new Set(added.map(memberID))].filter(id => id && !all.has(id));
    for (const [index, id] of fresh.entries()) {
      all.add(id);
      group.members.push(id);
      const raw = added.find(x => memberID(x) === id);
      const name = memberName(raw, memberNames.get(id) || id);
      group.names[id] = name;
      store.save();
      if (id !== botID) {
        const ordinal = currentTotal >= fresh.length
          ? currentTotal - fresh.length + index + 1
          : all.size;
        await send(
          `╭─ 👋 CHÀO MỪNG ─╮\n` +
          `│ Thành viên mới  │\n` +
          `╰────────────────╯\n\n` +
          `Chào mừng ${name} đến với nhóm! Bạn là thành viên thứ ${ordinal}. ✨\n` +
          `Chúc bạn có những trải nghiệm thật vui vẻ cùng mọi người nha! 🥳`,
          event.threadID,
          'welcome'
        );
      }
    }
  }

  async function handleLeave(event) {
    const id = memberID(event.logMessageData?.leftParticipantFbId ?? event.eventData?.leftParticipantFbId);
    if (!id) return;
    const found = await groupInfo(event.threadID);
    if (!found) return;
    found.group.members = found.group.members.filter(member => member !== id);
    store.save();
  }

  function trackMessage(group, event) {
    const id = String(event.senderID || '');
    if (!id || id === botID) return false;
    const messageID = event.messageID && String(event.messageID);
    if (messageID && group.recentIDs.includes(messageID)) return false;
    if (messageID) group.recentIDs = [...group.recentIDs.slice(-4999), messageID];
    const day = dayKey(now());
    group.days[day] ||= {};
    group.days[day][id] = (group.days[day][id] || 0) + 1;
    const cutoff = daysAgo(89, now());
    for (const oldDay of Object.keys(group.days)) if (oldDay < cutoff) delete group.days[oldDay];
    store.save();
    return true;
  }

  async function handleKick(event, details) {
    const threadID = event.threadID;
    const admins = adminSet(details);
    const actor = String(event.senderID);
    if (!admins.has(actor)) return send('⛔ Chỉ quản trị viên nhóm mới dùng được !kick.', threadID);
    if (!admins.has(botID)) return send('⛔ Hãy cấp quyền quản trị viên cho tài khoản bot trước khi dùng !kick.', threadID);

    const body = String(event.body || '');
    const arg = body.replace(/^!kick\b/i, '').trim();
    const mentioned = Object.keys(event.mentions || {});
    const target = memberID(event.messageReply?.senderID || mentioned[0] || (/^\d+$/.test(arg) ? arg : ''));
    if (!target) return send('Cách dùng: trả lời tin nhắn của người cần kick bằng !kick, tag họ, hoặc !kick ID.', threadID);
    if (target === botID || target === actor || admins.has(target)) return send('⛔ Không thể kick bot, chính bạn hoặc một quản trị viên.', threadID);
    if (!(details.participantIDs || []).map(String).includes(target)) return send('Người này hiện không có trong nhóm.', threadID);

    try {
      await remove(target, threadID);
      const group = store.group(threadID);
      group.members = group.members.filter(id => id !== target);
      store.save();
      return send(
        `╭─ 🚪 THÔNG BÁO ─╮\n` +
        `│ Xóa thành viên\n` +
        `╰───────────────╯\n\n` +
        `✅ Đã mời ${group.names[target] || target} ra khỏi nhóm.`,
        threadID
      );
    } catch (error) {
      console.error('Kick failed:', error);
      return send('Không kick được. Hãy kiểm tra quyền quản trị và thử lại.', threadID);
    }
  }

  async function handleStats(command, event, details, group, period) {
    const members = [...new Set((details.participantIDs || group.members).map(String))]
      .filter(id => id !== botID);
    for (const user of details.userInfo || []) group.names[String(user.id)] = memberName(user, user.id);
    group.members = [...new Set((details.participantIDs || group.members).map(String))];
    store.save();
    const rows = members.map(id => ({ id, ...countFor(group, id, period, now()) }));
    const label = id => group.names[id] || id;
    if (command === '!imlang') {
      const quiet = rows.filter(row => row.count === 0);
      const lines = quiet.slice(0, 15).map((row, i) => `  ${i + 1}. ${label(row.id)}`);
      return send(
        `╭─ 🔕 THÀNH VIÊN ÍT NHẮN ─╮\n` +
        `│ ${period} ngày qua chưa gửi tin\n` +
        `╰─────────────────────────╯\n\n` +
        `📊 Tỉ lệ: ${quiet.length}/${members.length} thành viên chưa nhắn tin trong ${period} ngày\n` +
        `────────────\n` +
        `${lines.length ? lines.join('\n') : '  ✨ Toàn bộ thành viên đều đã hoạt động!'}` +
        `${quiet.length > 15 ? '\n  … và còn ' + (quiet.length - 15) + ' người khác' : ''}`,
        event.threadID,
        'rank'
      );
    }
    rows.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const active = rows.filter(row => row.count > 0).length;
    const lines = rows.filter(row => row.count > 0).slice(0, 10)
      .map((row, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ` ${i + 1}.`;
        return `${medal} ${label(row.id)}: ${row.count} tin (${(row.count / period).toFixed(1)}/ngày), ${row.activeDays} ngày hoạt động`;
      });
    return send(
      `╭─ 📊 BẢNG XẾP HẠNG HOẠT ĐỘNG ─╮\n` +
      `│ Thống kê ${period} ngày (giờ VN)\n` +
      `╰──────────────────────────────╯\n\n` +
      `💬 Tổng số: ${total} tin nhắn\n` +
      `👥 Thành viên: ${active}/${members.length} thành viên có hoạt động\n` +
      `────────────\n` +
      `${lines.length ? lines.join('\n') : 'Chưa có tin nhắn được ghi nhận.'}\n` +
      `────────────\n` +
      `💡 Dữ liệu bắt đầu từ khi bot chạy.`,
      event.threadID,
      'rank'
    );
  }

  async function handleFunScore(command, event, details, group) {
    const threadID = String(event.threadID);
    const members = [...new Set((details.participantIDs || group.members).map(String))]
      .filter(id => id !== botID);
    const names = new Map((details.userInfo || []).map(user =>
      [String(user.id), memberName(user, user.id)]));
    const label = id => (names.get(id) || group.names[id] || id).slice(0, 30);
    const today = dayKey(now());
    const displayDate = `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}`;
    const footer = '🎲 Chỉ số ngẫu nhiên để vui, không nói lên xu hướng tính dục.';

    if (command === '!bangdogay' || command === '!topgay') {
      const rows = members.map(id => ({ id, score: funScore(threadID, id, today) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const medals = ['🥇', '🥈', '🥉'];
      const lines = rows.slice(0, 10).map((row, index) =>
        `${medals[index] || ` ${index + 1}.`} ${label(row.id)}\n   ${scoreBar(row.score, 8)} ${row.score}%`);
      return send(
        `╭─ 🌈 BẢNG ĐỘ GAY HÔM NAY ─╮\n` +
        `│ ${displayDate} · ${members.length} thành viên\n` +
        `╰─────────────────────────╯\n\n` +
        `${lines.join('\n') || 'Chưa có thành viên để xếp hạng.'}\n` +
        `────────────\n` +
        `${footer}`,
        threadID,
        'ship'
      );
    }

    const arg = String(event.body || '').replace(/^!dogay\b/i, '').trim();
    const mentioned = Object.keys(event.mentions || {});
    const target = memberID(event.messageReply?.senderID || mentioned[0] || (/^\d+$/.test(arg) ? arg : '') || event.senderID);
    if (!members.includes(target)) return send('Người này hiện không có trong nhóm.', threadID);
    const score = funScore(threadID, target, today);
    const rank = members.map(id => ({ id, score: funScore(threadID, id, today) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .findIndex(row => row.id === target) + 1;
    return send(
      `╭─ 🌈 ĐỘ GAY HÔM NAY ─╮\n` +
      `│ Ngày ${displayDate}\n` +
      `╰─────────────────────╯\n\n` +
      `👤 Đối tượng: ${label(target)}\n` +
      `📊 Chỉ số: ${score}%\n` +
      `   ${scoreBar(score, 10)}\n` +
      `🏅 Xếp hạng: Hạng ${rank}/${members.length} trong nhóm\n` +
      `────────────\n` +
      `${footer}\n` +
      `💡 Gõ !bangdogay để xem bảng xếp hạng.`,
      threadID,
      'ship'
    );
  }

  async function handle(event) {
    if (!event?.threadID) return;
    if (event.type === 'message_reaction') return features.handleReaction(event);
    if (event.type === 'event') {
      if (event.logMessageType === 'log:subscribe') return handleJoin(event);
      if (event.logMessageType === 'log:unsubscribe') return handleLeave(event);
      return;
    }
    if (event.type !== 'message' && event.type !== 'message_reply') return;
    if (String(event.senderID) === botID) return;
    const body = String(event.body || '').trim();
    const match = /^!(hoatdong|top|imlang|kick|help|dogay|bangdogay|topgay|profile|diemdanh|bangdiemdanh|bangtuongtac|sinhnhat|binhchon|vote|ketqua|dongbinhchon|canhbao|ship)(?:\s+(.*))?$/i.exec(body);
    let group = store.data.groups[String(event.threadID)] ? store.group(event.threadID) : null;
    if (!group?.initialized) {
      const found = await groupInfo(event.threadID);
      if (!found) return;
      group = found.group;
    }
    if (trackMessage(group, event)) features.trackInteractions(group, event);
    if (!match) return;
    const command = `!${match[1].toLowerCase()}`;
    if (command === '!help') {
      return send(
        `╭━━━━━━━━━━━━━━━━━━━━╮\n` +
        `    🤖 MENU TRỢ LÝ NHÓM\n` +
        `    Phiên bản tương tác tự động\n` +
        `╰━━━━━━━━━━━━━━━━━━━━╯\n\n` +
        `📊 THỐNG KÊ & TƯƠNG TÁC\n\n` +
        `▫️ !profile\n` +
        `   ↳ Xem cấp độ, streak & thông số cá nhân\n\n` +
        `▫️ !hoatdong [7 | 30]  (hoặc !top)\n` +
        `   ↳ Bảng xếp hạng thành viên chăm chat\n\n` +
        `▫️ !imlang [7 | 30]\n` +
        `   ↳ Danh sách thành viên ít tương tác\n\n` +
        `▫️ !diemdanh\n` +
        `   ↳ Điểm danh nhận streak hàng ngày\n\n` +
        `▫️ !bangdiemdanh\n` +
        `   ↳ Bảng vàng điểm danh chuyên cần\n\n` +
        `▫️ !bangtuongtac\n` +
        `   ↳ Top cặp đôi tương tác nhiều nhất 30 ngày\n\n` +
        `⚙️ TIỆN ÍCH & BÌNH CHỌN\n\n` +
        `▫️ !sinhnhat DD/MM\n` +
        `   ↳ Lưu ngày sinh (chúc mừng tự động lúc 08:00)\n\n` +
        `▫️ !binhchon [Hỏi | PA 1 | PA 2]\n` +
        `   ↳ Tạo cuộc bỏ phiếu nhóm nhanh\n\n` +
        `▫️ !vote [số]  •  !ketqua\n` +
        `   ↳ Bỏ phiếu hoặc xem kết quả trực tiếp\n\n` +
        `▫️ !dongbinhchon\n` +
        `   ↳ Đóng và chốt kết quả bình chọn\n\n` +
        `🎉 GIẢI TRÍ & KẾT NỐI\n\n` +
        `▫️ !ship\n` +
        `   ↳ Ghép đôi ngẫu nhiên 2 thành viên\n\n` +
        `▫️ !dogay  •  !bangdogay (topgay)\n` +
        `   ↳ Máy đo & BXH độ vui tính hôm nay\n\n` +
        `🛡️ DÀNH CHO QUẢN TRỊ VIÊN\n\n` +
        `▫️ !canhbao [tag / reply / ID] [lý do]\n` +
        `   ↳ Nhắc nhở thành viên vi phạm\n\n` +
        `▫️ !canhbao xem [ID]\n` +
        `   ↳ Tra cứu lịch sử cảnh cáo\n\n` +
        `▫️ !kick [tag / reply / ID]\n` +
        `   ↳ Mời thành viên ra khỏi nhóm\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 Mẹo: Có thể reply tin nhắn hoặc tag tên để thực hiện lệnh nhanh!`,
        event.threadID,
        'help'
      );
    }
    if (command === '!kick') return handleKick(event, await info(event.threadID));
    if (['!dogay', '!bangdogay', '!topgay'].includes(command))
      return handleFunScore(command, event, await info(event.threadID), group);
    if (!['!hoatdong', '!top', '!imlang'].includes(command))
      return features.handleCommand(command, event, store.group(event.threadID), await info(event.threadID));
    const periodText = String(match[2] || '7').trim();
    if (!['7', '30'].includes(periodText)) return send('Chọn 7 hoặc 30 ngày, ví dụ: !hoatdong 30', event.threadID);
    return handleStats(command, event, await info(event.threadID), group, Number(periodText));
  }

  return { handle, checkBirthdays: features.checkBirthdays };
}

module.exports = { createBot, countFor, dayKey, funScore, memberID };

