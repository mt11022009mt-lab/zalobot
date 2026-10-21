const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFeatures } = require('./features');
const { askAI: defaultAskAI } = require('./ai');

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
  const enableAttachments = process.env.ENABLE_ATTACHMENTS === 'true';

  const rawSend = options.send || ((text, threadID) => {
    console.log(`[Bot Phản Hồi] Đang gửi tin nhắn đến nhóm ${threadID}...`);
    return api.sendMessage(text, threadID, (err, msgInfo) => {
      if (err) {
        console.error(`[Lỗi Gửi Tin Nhắn] Nhóm ${threadID}:`, err?.error || err?.message || err);
      } else {
        console.log(`[Gửi Thành Công] Nhóm ${threadID}`);
      }
    });
  });

  const send = (msg, threadID, imageKey) => {
    if (options.send) return options.send(msg, threadID, imageKey);
    // Tối ưu siêu tốc: Bỏ qua upload ảnh multipart nếu không bật ENABLE_ATTACHMENTS
    if (enableAttachments && typeof msg === 'string' && imageKey) {
      const imgPath = path.join(__dirname, '..', 'assets', `${imageKey}.png`);
      if (fs.existsSync(imgPath)) {
        return rawSend({ body: msg, attachment: fs.createReadStream(imgPath) }, threadID);
      }
    }
    return rawSend(msg, threadID);
  };

  const rawInfo = options.getThreadInfo || (threadID => api.getThreadInfo(threadID));
  const threadCache = new Map();
  const CACHE_TTL = 5 * 60 * 1000; // 5 phút

  async function info(threadID, force = false) {
    const tid = String(threadID);
    const nowTs = Date.now();
    const cached = threadCache.get(tid);
    if (!force && cached && (nowTs - cached.ts < CACHE_TTL)) {
      return cached.details;
    }
    const details = await rawInfo(threadID);
    if (details) {
      threadCache.set(tid, { details, ts: nowTs });
    }
    return details;
  }

  function invalidateThreadCache(threadID) {
    threadCache.delete(String(threadID));
  }

  const remove = options.removeUserFromGroup || ((userID, threadID) => api.removeUserFromGroup(userID, threadID));
  const now = options.now || (() => Date.now());
  const askAI = options.askAI || defaultAskAI;
  const typing = options.sendTypingIndicator || ((threadID) => {
    try {
      api.sendTypingIndicator?.(threadID, () => {});
    } catch {}
  });
  const features = createFeatures({ botID, store, send, info, now, dayKey, daysAgo, scoreBar });

  const OWNER_LIST = new Set([
    '61590660586128', // UID chính chủ của bạn
    ...(options.adminIDs || []),
    ...(process.env.ADMIN_ID || '').split(','),
    ...(process.env.OWNER_ID || '').split(',')
  ].map(s => String(s).trim()).filter(Boolean));

  function isOwner(senderID) {
    return OWNER_LIST.has(String(senderID));
  }

  // Bộ nhớ đệm tin nhắn 1-1 riêng cho chủ bot để đàm thoại liên tục
  const dmHistories = new Map();

  async function handleOwnerDM(event, body) {
    const senderID = String(event.senderID);
    const threadID = String(event.threadID);
    const text = (body || '').trim();

    if (!text) return;

    if (/^!(reset|clearchat|xoachat|lammoi)\b/i.test(text)) {
      dmHistories.delete(senderID);
      return send('🧹 Đã xóa toàn bộ lịch sử cuộc trò chuyện riêng với AI!', threadID);
    }

    const cleanQuestion = text.replace(/^!(ai|gpt|gemini|hoi)\s*/i, '').trim() || text;

    // Bật hiệu ứng "đang soạn tin nhắn..." trên Facebook ngay lập tức
    typing(threadID);

    let history = dmHistories.get(senderID);
    if (!history) {
      history = [];
      dmHistories.set(senderID, history);
    }

    history.push({ role: 'user', content: cleanQuestion });
    if (history.length > 10) {
      history.splice(0, history.length - 10);
    }

    try {
      const answer = await askAI(cleanQuestion, { messages: [...history] });
      history.push({ role: 'assistant', content: answer });

      return send(
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏🤖 TRỢ LÝ AI (RIÊNG)\n` +
        `${answer.split('\n').map(l => `▏${l}`).join('\n')}\n` +
        `━━━━━━━━━━━━━━━━━━━━`,
        threadID
      );
    } catch (err) {
      console.error('[AI DM] Lỗi:', err?.message || err);
      return send('⚠️ AI đang bận hoặc gặp sự cố tạm thời, bạn thử lại sau ít giây nhé!', threadID);
    }
  }

  async function handleAI(question, event, group, contextPrompt = null) {
    const threadID = String(event.threadID);
    const q = (question || '').trim();
    if (!q) {
      return send(
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏🤖 TRỢ LÝ AI\n` +
        `▏Bạn hãy nhập câu hỏi sau lệnh nhé!\n` +
        `▏Ví dụ: !ai thủ đô của Pháp là gì?\n` +
        `━━━━━━━━━━━━━━━━━━━━`,
        threadID
      );
    }

    // Bật hiệu ứng "đang soạn tin nhắn..." ngay khi nhận lệnh
    typing(threadID);

    try {
      let prompt = q;
      if (contextPrompt) {
        prompt = `[Ngữ cảnh câu trả lời trước đó của bot: "${contextPrompt}"]\nNgười dùng phản hồi tiếp: "${q}"`;
      }
      const answer = await askAI(prompt);
      return send(
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏🤖 TRỢ LÝ AI\n` +
        `${answer.split('\n').map(l => `▏${l}`).join('\n')}\n` +
        `━━━━━━━━━━━━━━━━━━━━`,
        threadID
      );
    } catch (err) {
      console.error('[AI] Lỗi xử lý câu hỏi:', err?.message || err);
      return send(
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏🤖 TRỢ LÝ AI\n` +
        `▏Rất tiếc, AI đang bận xử lý dữ liệu. Bạn thử lại sau ít giây nhé!\n` +
        `━━━━━━━━━━━━━━━━━━━━`,
        threadID
      );
    }
  }

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
    invalidateThreadCache(event.threadID);
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
    invalidateThreadCache(event.threadID);
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

    // 1. Cập nhật BẢNG BỘ NHỚ ĐẾM TIN NHẮN VĨNH VIỄN (Lifetime Memory Table)
    group.messageCounts ||= {};
    group.messageCounts[id] = (group.messageCounts[id] || 0) + 1;
    group.totalMessages = (group.totalMessages || 0) + 1;

    // 2. Cập nhật theo ngày (cho các lệnh thống kê 7/30 ngày)
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

  async function handleMessageMemory(event, details, group) {
    const threadID = String(event.threadID);
    const members = [...new Set((details.participantIDs || group.members).map(String))]
      .filter(id => id !== botID);
    for (const user of details.userInfo || []) group.names[String(user.id)] = memberName(user, user.id);
    group.members = [...new Set((details.participantIDs || group.members).map(String))];
    store.save();

    group.messageCounts ||= {};
    const label = id => group.names[id] || id;

    const rows = members.map(id => ({
      id,
      count: group.messageCounts[id] || 0
    })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

    const total = group.totalMessages || rows.reduce((sum, r) => sum + r.count, 0);
    const activeMembers = rows.filter(r => r.count > 0);

    const lines = activeMembers.slice(0, 15).map((row, i) => {
      const medal = i === 0 ? '🥇 1.' : i === 1 ? '🥈 2.' : i === 2 ? '🥉 3.' : `   ${i + 1}.`;
      const pct = total > 0 ? ((row.count / total) * 100).toFixed(1) : '0.0';
      return `▏${medal} ${label(row.id)}: ${row.count} tin (${pct}%)`;
    });

    return send(
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `▏◈ BẢNG BỘ NHỚ ĐẾM TIN NHẮN\n` +
      `▏Lưu trữ vĩnh viễn · Toàn thời gian\n` +
      `▏💬 Tổng tích luỹ: ${total} tin nhắn\n` +
      `▏👥 Thành viên ghi nhận: ${activeMembers.length}/${members.length} người\n` +
      `▏━━━━━━━━━━━━━━━━━━━\n` +
      `${lines.length ? lines.join('\n') : '▏Chưa có tin nhắn nào được lưu trong bộ nhớ.'}\n` +
      `▏━━━━━━━━━━━━━━━━━━━\n` +
      `▏💡 Dữ liệu được lưu vĩnh viễn trong bộ nhớ, không bị reset khi bot khởi động lại.\n` +
      `━━━━━━━━━━━━━━━━━━━━`,
      threadID,
      'rank'
    );
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
      const lifetimeTotal = group.totalMessages || total;
      const active = rows.filter(row => row.count > 0).length;
      const rate = members.length ? Math.round(active / members.length * 100) : 0;
      rows.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
      const top1 = rows[0]?.count > 0 ? `${label(rows[0].id)} (${rows[0].count} tin)` : 'Chưa có';
      return send(
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏◈ SỨC KHỎE NHÓM · ${period} NGÀY\n` +
        `▏💬 Tin nhắn (${period} ngày): ${total} tin\n` +
        `▏💾 Tổng bộ nhớ tích luỹ: ${lifetimeTotal} tin\n` +
        `▏👥 Quy mô nhóm: ${members.length} thành viên\n` +
        `▏🔥 Đang hoạt động: ${active} người (${rate}%)\n` +
        `▏Tiến trình active: ${scoreBar(rate, 10)} ${rate}%\n` +
        `▏🏆 Quán quân tương tác: ${top1}\n` +
        `▏━━━━━━━━━━━━━━━━━━━\n` +
        `▏💡 Dữ liệu được lưu trữ tự động trong bộ nhớ bot.\n` +
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

    if (['!bangdogay', '!topgay', '!bangdoquay', '!topquay'].includes(command)) {
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

    const arg = String(event.body || '').replace(/^!(dogay|doquay)\b/i, '').trim();
    const mentioned = Object.keys(event.mentions || {});
    const target = memberID(event.messageReply?.senderID || mentioned[0] || (/^\d+$/.test(arg) ? arg : '') || event.senderID);
    if (!members.includes(target)) return send('Người này hiện không có trong nhóm.', threadID);
    const score = funScore(threadID, target, today);
    const rank = members.map(id => ({ id, score: funScore(threadID, id, today) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .findIndex(row => row.id === target) + 1;
    return send(
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `▏◈ MÁY ĐO ĐỘ GAY · ${displayDate}\n` +
      `▏👤 Đối tượng: ${label(target)}\n` +
      `▏Chỉ số gay: ${scoreBar(score, 10)} ${score}%\n` +
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
    console.log(`[Tin Nhắn Đến] Từ ${event.senderID} (thread ${event.threadID}): "${body}"`);

    // 1. Kiểm tra tin nhắn riêng 1-1 (Direct Message)
    const isDirect = event.isGroup === false || String(event.threadID) === String(event.senderID);
    if (isDirect) {
      if (!isOwner(event.senderID)) {
        console.log(`[Tin Nhắn Riêng] Từ chối UID ${event.senderID} vì không phải chủ bot.`);
        return send('Xin chào! Tính năng nhắn tin riêng 1-1 với trợ lý AI hiện chỉ được kích hoạt cho Chủ bot / Quản trị viên.', event.threadID);
      }
      return handleOwnerDM(event, body);
    }

    const match = /^!(hoatdong|top|rank|thongke|stats|imlang|kick|help|doquay|bangdoquay|topquay|dogay|bangdogay|topgay|demtin|bangtinnhan|tongtin|bonho|memory|profile|hoso|diemdanh|bangdiemdanh|bangtuongtac|sinhnhat|binhchon|vote|ketqua|dongbinhchon|canhbao|ship|ghepdoi|qtv|admin|ai|gpt|gemini|hoi)(?:\s+(.*))?$/i.exec(body);
    let group = store.data.groups[String(event.threadID)] ? store.group(event.threadID) : null;
    if (!group?.initialized) {
      console.log(`[Khởi Tạo Nhóm] Đang tải thông tin nhóm ${event.threadID}...`);
      const found = await groupInfo(event.threadID);
      if (!found) {
        if (isOwner(event.senderID)) {
          return handleOwnerDM(event, body);
        }
        console.warn(`[Bỏ Qua] Không thể lấy thông tin nhóm hoặc đây là chat 1-1 (thread ${event.threadID})`);
        return;
      }
      group = found.group;
    }
    if (trackMessage(group, event)) features.trackInteractions(group, event);

    if (!match) {
      // Phản hồi thông minh khi tag bot hoặc reply tin nhắn của bot
      const isReplyToBot = event.messageReply && String(event.messageReply.senderID) === botID;
      const isMentionBot = event.mentions && Object.keys(event.mentions).includes(botID);

      if (isReplyToBot && body && !body.startsWith('!')) {
        const prevBotMsg = String(event.messageReply.body || '').replace(/^[▏━\s]+/gm, '').trim();
        return handleAI(body, event, group, prevBotMsg.slice(0, 300));
      }

      if (isMentionBot && body && !body.startsWith('!')) {
        let cleanBody = body;
        for (const [mid, mname] of Object.entries(event.mentions)) {
          if (mid === botID) {
            cleanBody = cleanBody.replace(new RegExp(mname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
          }
        }
        cleanBody = cleanBody.replace(/@\S+/g, '').trim();
        if (cleanBody) {
          return handleAI(cleanBody, event, group);
        }
      }
      return;
    }

    const command = `!${match[1].toLowerCase()}`;
    console.log(`[Khớp Lệnh] Người dùng ${event.senderID} gọi lệnh: ${command}`);

    if (command === '!help') {
      return send(
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `▏◈ TRUNG TÂM LỆNH BOT\n` +
        `▏Trợ lý tương tác & quản lý nhóm thông minh\n` +
        `▏━━━━━━━━━━━━━━━━━━━\n` +
        `▏🤖 TRÍ TUỆ NHÂN TẠO (AI):\n` +
        `▏  • !ai (!gpt/gemini/hoi) [câu hỏi]: Chat AI thông minh\n` +
        `▏  • Tag @bot hoặc Reply tin nhắn để đàm thoại tự nhiên\n` +
        `▏\n` +
        `▏👤 CÁ NHÂN:\n` +
        `▏  • !hoso (!profile): Thẻ định danh & cấp bậc\n` +
        `▏  • !diemdanh: Giữ lửa streak hàng ngày\n` +
        `▏  • !sinhnhat [DD/MM]: Chúc mừng sinh nhật tự động\n` +
        `▏\n` +
        `▏👥 NHÓM & THỐNG KÊ:\n` +
        `▏  • !bangtinnhan (!demtin/tongtin): Bảng bộ nhớ tin nhắn vĩnh viễn\n` +
        `▏  • !rank (!hoatdong/top) [7|30|all]: Bảng vàng chat\n` +
        `▏  • !thongke (!stats): Sức khỏe & tỷ lệ active\n` +
        `▏  • !imlang [7|30]: Danh sách ít tương tác\n` +
        `▏  • !bangdiemdanh: BXH chuyên cần\n` +
        `▏  • !bangtuongtac: Cặp đôi tương tác nhiều nhất\n` +
        `▏  • !qtv (!admin): Danh sách ban quản trị\n` +
        `▏\n` +
        `▏🎉 GIẢI TRÍ & KẾT NỐI:\n` +
        `▏  • !ghepdoi (!ship): Bói độ hợp cạ ngẫu nhiên\n` +
        `▏  • !dogay (!bangdogay): Máy đo độ gay hôm nay\n` +
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

    if (['!ai', '!gpt', '!gemini', '!hoi'].includes(command)) {
      return handleAI(match[2] || '', event, group);
    }

    const threadDetails = await info(event.threadID);
    if (command === '!kick') return handleKick(event, threadDetails);
    if (command === '!qtv' || command === '!admin') return handleAdminList(event, threadDetails, group);
    if (['!demtin', '!bangtinnhan', '!tongtin', '!bonho', '!memory'].includes(command))
      return handleMessageMemory(event, threadDetails, group);
    if (['!doquay', '!bangdoquay', '!topquay', '!dogay', '!bangdogay', '!topgay'].includes(command))
      return handleFunScore(command, event, threadDetails, group);
    if (!['!hoatdong', '!top', '!rank', '!imlang', '!thongke', '!stats'].includes(command))
      return features.handleCommand(command, event, store.group(event.threadID), threadDetails);
    
    const periodText = String(match[2] || '7').trim().toLowerCase();
    if (periodText === 'all') {
      return handleMessageMemory(event, threadDetails, group);
    }
    if (!['7', '30'].includes(periodText)) return send('Chọn 7, 30 ngày hoặc all, ví dụ: !hoatdong 30 hoặc !rank all', event.threadID);
    return handleStats(command, event, threadDetails, group, Number(periodText));
  }

  return { handle, checkBirthdays: features.checkBirthdays };
}

module.exports = { createBot, countFor, dayKey, funScore, memberID };
