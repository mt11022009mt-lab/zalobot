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
  const clamped = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const filled = Math.max(0, Math.min(width, Math.round(clamped / 100 * width)));
  return '●'.repeat(filled) + '○'.repeat(width - filled);
}

function createBot(api, store, options = {}) {
  const botID = String(api.getCurrentUserID());
  const rawSend = options.send || ((text, threadID) => api.sendMessage(text, threadID));
  const send = (msg, threadID, imageKey) => {
    if (options.send) return options.send(msg, threadID, imageKey);
    if (typeof msg === 'string' && imageKey) {
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
  const features = createFeatures({ botID, store, send, info, now, dayKey, daysAgo, scoreBar });

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
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `▏◈ CHÀO MỪNG THÀNH VIÊN MỚI\n` +
          `▏Chào mừng ${name} đến với nhóm! Bạn là thành viên thứ ${ordinal} của đại gia đình. ✨\n` +
          `▏Chúc bạn có những trải nghiệm thật vui vẻ cùng mọi người nha!\n` +
          `▏Gõ !help để khám phá trung tâm lệnh bot.\n` +
          `━━━━━━━━━━━━━━━━━━━━`,
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
    if (messageID) {
      group.recentIDs.push(messageID);
      if (group.recentIDs.length > 500) group.recentIDs.shift();
    }
    const today = dayKey(now());
    const dayBucket = (group.days[today] ||= {});
    dayBucket[id] = (dayBucket[id] || 0) + 1;
    const cutoff = daysAgo(29, now());
    for (const oldDay of Object.keys(group.days)) {
      if (oldDay < cutoff) delete group.days[oldDay];
    }
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
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏◈ THÔNG BÁO XỬ LÝ KỶ LUẬT\n` +
        `▏✅ Đã mời thành viên ra khỏi nhóm:\n` +
        `▏👤 ${group.names[target] || target}\n` +
        `▏🛡️ Người thực thi: ${group.names[actor] || actor}\n` +
        `━━━━━━━━━━━━━━━━━━━━`,
        threadID,
        'warning'
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
      const lines = quiet.slice(0, 15).map((row, i) => `▏  ${i + 1}. ${label(row.id)}`);
      return send(
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏◈ THÀNH VIÊN ÍT NHẮN · ${period} NGÀY\n` +
        `▏Chưa gửi tin nhắn nào trong ${period} ngày qua:\n` +
        `▏📊 Tỉ lệ: ${quiet.length}/${members.length} thành viên\n` +
        `▏━━━━━━━━━━━━━━━━━━━\n` +
        `${lines.length ? lines.join('\n') : '▏  ✨ Toàn bộ thành viên đều đã hoạt động!'}` +
        `${quiet.length > 15 ? '\n▏  … và còn ' + (quiet.length - 15) + ' người khác' : ''}\n` +
        `━━━━━━━━━━━━━━━━━━━━`,
        event.threadID,
        'cleanup'
      );
    }

    if (command === '!thongke' || command === '!stats') {
      const total = rows.reduce((sum, row) => sum + row.count, 0);
      const active = rows.filter(row => row.count > 0).length;
      const rate = members.length ? Math.round(active / members.length * 100) : 0;
      rows.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
      const top1 = rows[0]?.count > 0 ? `${label(rows[0].id)} (${rows[0].count} tin)` : 'Chưa có';
      return send(
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏◈ SỨC KHỎE NHÓM · ${period} NGÀY\n` +
        `▏💬 Tổng tin nhắn: ${total} tin\n` +
        `▏👥 Quy mô nhóm: ${members.length} thành viên\n` +
        `▏🔥 Đang hoạt động: ${active} người (${rate}%)\n` +
        `▏Tiến trình active: ${scoreBar(rate, 10)} ${rate}%\n` +
        `▏🏆 Quán quân tương tác: ${top1}\n` +
        `▏━━━━━━━━━━━━━━━━━━━\n` +
        `▏💡 Dữ liệu được tính tự động từ nhật ký bot.\n` +
        `━━━━━━━━━━━━━━━━━━━━`,
        event.threadID,
        'stats'
      );
    }

    rows.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const active = rows.filter(row => row.count > 0).length;
    const rate = members.length ? Math.round(active / members.length * 100) : 0;
    const lines = rows.filter(row => row.count > 0).slice(0, 10)
      .map((row, i) => {
        const medal = i === 0 ? '🥇 1.' : i === 1 ? '🥈 2.' : i === 2 ? '🥉 3.' : `   ${i + 1}.`;
        return `▏${medal} ${label(row.id)}: ${row.count} tin (${(row.count / period).toFixed(1)}/ngày), ${row.activeDays} ngày`;
      });
    return send(
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `▏◈ BẢNG VÀNG HOẠT ĐỘNG · ${period} NGÀY\n` +
      `▏💬 Tổng số: ${total} tin nhắn\n` +
      `▏👥 Thành viên: ${active}/${members.length} có hoạt động\n` +
      `▏Tỷ lệ hoạt động: ${scoreBar(rate, 10)} ${rate}%\n` +
      `▏━━━━━━━━━━━━━━━━━━━\n` +
      `${lines.length ? lines.join('\n') : '▏Chưa có tin nhắn được ghi nhận.'}\n` +
      `▏━━━━━━━━━━━━━━━━━━━\n` +
      `▏💡 Gõ !thongke để xem báo cáo sức khỏe nhóm.\n` +
      `━━━━━━━━━━━━━━━━━━━━`,
      event.threadID,
      'rank'
    );
  }

  async function handleAdminList(event, details, group) {
    const threadID = String(event.threadID);
    const admins = [...adminSet(details)];
    const names = new Map((details.userInfo || []).map(u => [String(u.id), memberName(u, u.id)]));
    const adminNames = admins.map(id => names.get(id) || group.names[id] || id);
    return send(
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `▏◈ BAN QUẢN TRỊ NHÓM\n` +
      `▏Danh sách Quản trị viên hiện tại:\n` +
      `${adminNames.map((name, i) => `▏🛡️ ${i + 1}. ${name}`).join('\n') || '▏Chưa có QTV'}\n` +
      `▏━━━━━━━━━━━━━━━━━━━\n` +
      `▏Tổng cộng: ${adminNames.length} QTV đang hỗ trợ nhóm.\n` +
      `▏Cần hỗ trợ? Hãy tag hoặc nhắc tên QTV trong nhóm nhé!\n` +
      `━━━━━━━━━━━━━━━━━━━━`,
      threadID,
      'admin'
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
      const medals = ['🥇 1.', '🥈 2.', '🥉 3.'];
      const lines = rows.slice(0, 10).map((row, index) =>
        `▏${medals[index] || `   ${index + 1}.`} ${label(row.id)}\n▏   ${scoreBar(row.score, 8)} ${row.score}%`);
      return send(
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏◈ BẢNG ĐỘ GAY HÔM NAY\n` +
        `▏Ngày: ${displayDate} · ${members.length} thành viên\n` +
        `▏━━━━━━━━━━━━━━━━━━━\n` +
        `${lines.join('\n') || '▏Chưa có thành viên để xếp hạng.'}\n` +
        `▏━━━━━━━━━━━━━━━━━━━\n` +
        `▏${footer}\n` +
        `━━━━━━━━━━━━━━━━━━━━`,
        threadID,
        'fun'
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
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `▏◈ MÁY ĐO ĐỘ QUẬY · ${displayDate}\n` +
      `▏👤 Đối tượng: ${label(target)}\n` +
      `▏Chỉ số quậy: ${scoreBar(score, 10)} ${score}%\n` +
      `▏🏅 Xếp hạng: Hạng ${rank}/${members.length} trong nhóm\n` +
      `▏━━━━━━━━━━━━━━━━━━━\n` +
      `▏${footer}\n` +
      `▏💡 Gõ !bangdogay để xem bảng xếp hạng hôm nay.\n` +
      `━━━━━━━━━━━━━━━━━━━━`,
      threadID,
      'fun'
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
    const match = /^!(hoatdong|top|rank|thongke|stats|imlang|kick|help|dogay|bangdogay|topgay|profile|hoso|diemdanh|bangdiemdanh|bangtuongtac|sinhnhat|binhchon|vote|ketqua|dongbinhchon|canhbao|ship|ghepdoi|qtv|admin)(?:\s+(.*))?$/i.exec(body);
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
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏◈ TRUNG TÂM LỆNH BOT\n` +
        `▏Trợ lý tương tác & quản lý nhóm thông minh\n` +
        `▏━━━━━━━━━━━━━━━━━━━\n` +
        `▏👤 CÁ NHÂN:\n` +
        `▏  • !hoso (!profile): Thẻ định danh & cấp bậc\n` +
        `▏  • !diemdanh: Giữ lửa streak hàng ngày\n` +
        `▏  • !sinhnhat [DD/MM]: Chúc mừng sinh nhật tự động\n` +
        `▏\n` +
        `▏👥 NHÓM & THỐNG KÊ:\n` +
        `▏  • !rank (!hoatdong/top) [7|30]: Bảng vàng chat\n` +
        `▏  • !thongke (!stats): Sức khỏe & tỷ lệ active\n` +
        `▏  • !imlang [7|30]: Danh sách ít tương tác\n` +
        `▏  • !bangdiemdanh: BXH chuyên cần\n` +
        `▏  • !bangtuongtac: Cặp đôi tương tác nhiều nhất\n` +
        `▏  • !qtv (!admin): Danh sách ban quản trị\n` +
        `▏\n` +
        `▏🎉 GIẢI TRÍ & KẾT NỐI:\n` +
        `▏  • !ghepdoi (!ship): Bói độ hợp cạ ngẫu nhiên\n` +
        `▏  • !dogay (!bangdogay): Máy đo độ quậy hôm nay\n` +
        `▏  • !binhchon [Câu hỏi | PA 1 | PA 2]: Thăm dò ý kiến\n` +
        `▏  • !vote [số]  •  !ketqua  •  !dongbinhchon\n` +
        `▏\n` +
        `▏🛡️ QUẢN TRỊ VIÊN:\n` +
        `▏  • !canhbao [tag/reply/ID] [lý do]: Nhắc nhở vi phạm\n` +
        `▏  • !kick [tag/reply/ID]: Mời ra khỏi nhóm\n` +
        `▏━━━━━━━━━━━━━━━━━━━\n` +
        `▏💡 Mẹo: Tag tên hoặc reply tin nhắn để thao tác nhanh!`,
        event.threadID,
        'help'
      );
    }

    if (command === '!kick') return handleKick(event, await info(event.threadID));
    if (command === '!qtv' || command === '!admin') return handleAdminList(event, await info(event.threadID), group);
    if (['!dogay', '!bangdogay', '!topgay'].includes(command))
      return handleFunScore(command, event, await info(event.threadID), group);
    if (!['!hoatdong', '!top', '!rank', '!imlang', '!thongke', '!stats'].includes(command))
      return features.handleCommand(command, event, store.group(event.threadID), await info(event.threadID));
    
    const periodText = String(match[2] || '7').trim();
    if (!['7', '30'].includes(periodText)) return send('Chọn 7 hoặc 30 ngày, ví dụ: !hoatdong 30', event.threadID);
    return handleStats(command, event, await info(event.threadID), group, Number(periodText));
  }

  return { handle, checkBirthdays: features.checkBirthdays };
}

module.exports = { createBot, countFor, dayKey, funScore, memberID };
