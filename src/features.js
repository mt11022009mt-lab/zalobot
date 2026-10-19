const { createHash } = require('node:crypto');

const VOTE_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const safe = text => String(text ?? '').replace(/[\r\n|]+/g, ' ').trim().slice(0, 100);
const idOf = value => String(value?.id ?? value?.userFbId ?? value ?? '');
const adminsOf = info => new Set((info.adminIDs || []).map(idOf));

function targetOf(event, arg, defaultID = '') {
  const mentioned = Object.keys(event.mentions || {});
  const numeric = /^\d+/.exec(arg)?.[0];
  return idOf(event.messageReply?.senderID || mentioned[0] || numeric || defaultID);
}

function birthdayDate(raw) {
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(raw);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const date = new Date(Date.UTC(2000, month - 1, day));
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return null;
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`;
}

function createFeatures({ botID, store, send, info, now, dayKey, daysAgo }) {
  function label(group, details, id) {
    const person = (details?.userInfo || []).find(user => String(user.id) === id);
    if (person?.name) group.names[id] = safe(person.name);
    return (group.names[id] || id).slice(0, 30);
  }

  function members(group, details) {
    return [...new Set((details.participantIDs || group.members).map(String))].filter(id => id !== botID);
  }

  function trackInteractions(group, event) {
    const actor = String(event.senderID || '');
    const targets = new Set(Object.keys(event.mentions || {}));
    if (event.messageReply?.senderID) targets.add(String(event.messageReply.senderID));
    targets.delete(actor);
    targets.delete(botID);
    if (!targets.size) return;
    const today = dayKey(now());
    const bucket = (group.interactions[today] ||= {});
    for (const target of targets) {
      const pair = [actor, target].sort().join('|');
      bucket[pair] = (bucket[pair] || 0) + 1;
    }
    const cutoff = daysAgo(29, now());
    for (const oldDay of Object.keys(group.interactions)) {
      if (oldDay < cutoff) delete group.interactions[oldDay];
    }
    store.save();
  }

  function voteIndex(reaction) {
    const normalized = String(reaction || '').replace(/\uFE0F/g, '');
    return VOTE_EMOJI.findIndex(emoji => emoji.replace(/\uFE0F/g, '') === normalized);
  }

  async function handleReaction(event) {
    const group = store.data.groups[String(event.threadID)];
    const poll = group?.poll;
    if (!poll?.active || String(event.messageID) !== poll.messageID) return;
    const voter = String(event.userID || '');
    if (!voter || voter === botID || !group.members.includes(voter)) return;
    const index = voteIndex(event.reaction);
    if (index < 0) {
      if (!event.reaction) delete poll.votes[voter];
      else return;
    } else if (index < poll.options.length) {
      poll.votes[voter] = index;
    } else return;
    store.save();
  }

  function results(poll) {
    const counts = poll.options.map((_, index) =>
      Object.values(poll.votes || {}).filter(vote => vote === index).length);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const lines = poll.options.map((option, index) => {
      const percent = total ? Math.round(counts[index] / total * 100) : 0;
      const blocks = Math.round(percent / 10);
      return `${VOTE_EMOJI[index]} ${option}\n   ${'▰'.repeat(blocks)}${'▱'.repeat(10 - blocks)} ${counts[index]} phiếu (${percent}%)`;
    });
    return (
      `╭─ 📊 KẾT QUẢ BÌNH CHỌN ─╮\n` +
      `│ ${poll.question}\n` +
      `╰────────────────────────╯\n\n` +
      `${lines.join('\n')}\n` +
      `────────────\n` +
      `📈 Tổng cộng: ${total} phiếu bình chọn\n` +
      `${poll.active ? '👉 React emoji vào tin nhắn để đổi phiếu.' : '🔒 Cuộc bình chọn đã kết thúc.'}`
    );
  }

  async function handleCommand(command, event, group, details) {
    const threadID = String(event.threadID);
    const actor = String(event.senderID);
    const raw = String(event.body || '').replace(/^!\S+\s*/i, '').trim();
    const currentMembers = members(group, details);
    const name = id => label(group, details, id);

    if (command === '!profile') {
      const target = targetOf(event, raw, actor);
      if (!currentMembers.includes(target)) return send('Người này hiện không có trong nhóm.', threadID);
      const start = daysAgo(29, now());
      const end = dayKey(now());
      const count = id => Object.entries(group.days).reduce((sum, [day, row]) =>
        sum + (day >= start && day <= end ? row[id] || 0 : 0), 0);
      const ranking = currentMembers.sort((a, b) => count(b) - count(a) || a.localeCompare(b));
      const checkin = group.checkins[target] || { streak: 0, total: 0 };
      const rankNum = ranking.indexOf(target) + 1;
      const rankBadge = rankNum === 1 ? '👑 Top 1' : rankNum <= 3 ? '🥈 Top 3' : `Top ${rankNum}`;
      return send(
        `╭─ 👤 HỒ SƠ THÀNH VIÊN ─╮\n` +
        `│ ✨ ${name(target)}\n` +
        `╰───────────────────────╯\n\n` +
        `🏅 Hạng hoạt động: ${rankNum}/${ranking.length} (${rankBadge})\n` +
        `💬 Tin nhắn 30 ngày: ${count(target)} tin\n` +
        `📅 Điểm danh: ${checkin.total} ngày · chuỗi ${checkin.streak} ngày\n` +
        `🎂 Sinh nhật: ${group.birthdays[target] || 'Chưa đặt'}\n` +
        `────────────\n` +
        `💡 Dùng !diemdanh mỗi ngày để tăng chuỗi streak.`,
        threadID,
        'rank'
      );
    }

    if (command === '!diemdanh') {
      const today = dayKey(now());
      const record = (group.checkins[actor] ||= { lastDay: '', streak: 0, total: 0 });
      if (record.lastDay === today) {
        return send(
          `╭─ ℹ️ ĐÃ ĐIỂM DANH ─╮\n` +
          `│ ${name(actor)}\n` +
          `╰──────────────────╯\n\n` +
          `✅ ${name(actor)} đã điểm danh hôm nay. Chuỗi hiện tại: ${record.streak} ngày.`,
          threadID
        );
      }
      record.streak = record.lastDay === daysAgo(1, now()) ? record.streak + 1 : 1;
      record.total++;
      record.lastDay = today;
      store.save();
      return send(
        `╭─ 🔥 ĐIỂM DANH THÀNH CÔNG ─╮\n` +
        `│ Chúc mừng ${name(actor)}!\n` +
        `╰───────────────────────────╯\n\n` +
        `🔥 Chuỗi ${record.streak} ngày · tổng ${record.total} ngày\n` +
        `────────────\n` +
        `💡 Hãy giữ vững phong độ điểm danh vào ngày mai nhé!`,
        threadID,
        'checkin'
      );
    }

    if (command === '!bangdiemdanh') {
      const rows = currentMembers.map(id => ({ id, ...group.checkins[id] }))
        .filter(row => row.total).sort((a, b) => b.streak - a.streak || b.total - a.total).slice(0, 10);
      const lines = rows.map((row, i) => {
        const icon = i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : ` ${i + 1}.`;
        return `${icon} ${name(row.id)} ‣ 🔥 ${row.streak} ngày (tổng ${row.total})`;
      });
      return send(
        `╭─ 📅 BẢNG VÀNG ĐIỂM DANH ─╮\n` +
        `│ Top chuyên cần của nhóm   │\n` +
        `╰───────────────────────────╯\n\n` +
        `${lines.join('\n') || 'Chưa ai điểm danh.'}\n` +
        `────────────\n` +
        `💡 Gõ !diemdanh mỗi ngày để ghi tên lên bảng vàng.`,
        threadID,
        'checkin'
      );
    }

    if (command === '!bangtuongtac') {
      const totals = {};
      const start = daysAgo(29, now());
      const end = dayKey(now());
      for (const [day, pairs] of Object.entries(group.interactions)) {
        if (day < start || day > end) continue;
        for (const [pair, count] of Object.entries(pairs)) totals[pair] = (totals[pair] || 0) + count;
      }
      const rows = Object.entries(totals).map(([pair, count]) => ({ ids: pair.split('|'), count }))
        .filter(row => row.ids.every(id => currentMembers.includes(id)))
        .sort((a, b) => b.count - a.count).slice(0, 10);
      const lines = rows.map((row, i) => {
        const icon = i === 0 ? '💖' : i === 1 ? '🥈' : i === 2 ? '🥉' : ` ${i + 1}.`;
        return `${icon} ${name(row.ids[0])} ↔ ${name(row.ids[1])} · ${row.count} lần`;
      });
      return send(
        `╭─ 💬 CẶP TƯƠNG TÁC · 30 NGÀY ─╮\n` +
        `│ Top tag & phản hồi nhiều nhất  │\n` +
        `╰────────────────────────────────╯\n\n` +
        `${lines.join('\n') || 'Chưa có lượt trả lời hoặc tag nào được ghi nhận.'}\n` +
        `────────────\n` +
        `💡 Mỗi tin nhắn tag hoặc trả lời chỉ tính một lần cho mỗi cặp.`,
        threadID,
        'rank'
      );
    }

    if (command === '!sinhnhat') {
      if (!raw || raw.toLowerCase() === 'xem') return send(`🎂 Sinh nhật của ${name(actor)}: ${group.birthdays[actor] || 'chưa đặt'}\nDùng !sinhnhat DD/MM hoặc !sinhnhat xoa.`, threadID);
      if (raw.toLowerCase() === 'xoa') {
        delete group.birthdays[actor];
        store.save();
        return send('✅ Đã xóa ngày sinh của bạn khỏi hệ thống.', threadID);
      }
      const date = birthdayDate(raw);
      if (!date) return send('❌ Định dạng ngày không hợp lệ. Vui lòng dùng !sinhnhat DD/MM (ví dụ: !sinhnhat 25/12).', threadID);
      const displayName = name(actor);
      group.birthdays[actor] = date;
      store.save();
      return send(
        `╭─ 🎂 CÀI ĐẶT SINH NHẬT ─╮\n` +
        `│ ${displayName}\n` +
        `╰────────────────────────╯\n\n` +
        `✅ Đã lưu sinh nhật của ${displayName}: ${date}.\n` +
        `⏰ Bot sẽ tự động gửi lời chúc mừng vào lúc 08:00 sáng Việt Nam nếu đang chạy.`,
        threadID,
        'birthday'
      );
    }

    if (command === '!binhchon') {
      if (group.poll?.active) return send('⚠️ Nhóm đang có cuộc bình chọn chưa đóng. Dùng !ketqua để xem hoặc !dongbinhchon để đóng.', threadID);
      const pieces = raw.split('|').map(safe);
      if (pieces.length < 3 || pieces.length > 6 || pieces.some(part => !part))
        return send('Cách dùng: !binhchon Câu hỏi | Lựa chọn 1 | Lựa chọn 2 [| ... tối đa 5]', threadID);
      const [question, ...choices] = pieces;
      const text =
        `╭─ 🗳️ CUỘC BÌNH CHỌN MỚI ─╮\n` +
        `│ ${question}\n` +
        `╰─────────────────────────╯\n\n` +
        `${choices.map((choice, i) => `${VOTE_EMOJI[i]} ${choice}`).join('\n')}\n` +
        `────────────\n` +
        `👉 React thả cảm xúc emoji tương ứng hoặc gõ !vote [1-${choices.length}] để bình chọn!\n` +
        `📊 Gõ !ketqua để theo dõi kết quả.`;
      const result = await send(text, threadID, 'poll');
      const messageID = String(result?.messageID || '');
      if (!messageID) return send('Không lấy được ID tin nhắn bình chọn; hãy thử tạo lại.', threadID);
      group.members = [...new Set((details.participantIDs || group.members).map(String))];
      group.poll = { active: true, question, options: choices, messageID, creator: actor, votes: {} };
      store.save();
      return;
    }

    if (command === '!ketqua') {
      if (!group.poll) return send('Nhóm chưa có bình chọn.', threadID);
      return send(results(group.poll), threadID);
    }

    if (command === '!vote') {
      if (!group.poll?.active) return send('Không có bình chọn đang mở.', threadID);
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1 || number > group.poll.options.length)
        return send(`Chọn một số từ 1 đến ${group.poll.options.length}, ví dụ !vote 1.`, threadID);
      group.poll.votes[actor] = number - 1;
      store.save();
      return send(`✅ Đã ghi phiếu của ${name(actor)} cho ${VOTE_EMOJI[number - 1]} ${group.poll.options[number - 1]}.`, threadID);
    }

    if (command === '!dongbinhchon') {
      if (!group.poll?.active) return send('Không có bình chọn đang mở.', threadID);
      if (actor !== group.poll.creator && !adminsOf(details).has(actor)) return send('Chỉ người tạo hoặc QTV mới đóng được bình chọn.', threadID);
      group.poll.active = false;
      store.save();
      return send(results(group.poll), threadID);
    }

    if (command === '!canhbao') {
      if (!adminsOf(details).has(actor)) return send('⛔ Chỉ quản trị viên nhóm mới dùng được !canhbao.', threadID);
      const mode = /^(xem|xoa)\b/i.exec(raw)?.[1]?.toLowerCase();
      const rest = mode ? raw.replace(/^(xem|xoa)\s*/i, '') : raw;
      const target = targetOf(event, rest);
      if (!target || !currentMembers.includes(target)) return send('Cách dùng: !canhbao (trả lời/tag/ID) lý do; !canhbao xem ID; !canhbao xoa ID.', threadID);
      if (mode === 'xem') {
        const warnings = group.warnings[target] || [];
        const lines = warnings.slice(-5).map((item, i) => `  ${i + 1}. [${item.day}] ${item.reason}`);
        return send(
          `╭─ ⚠️ LỊCH SỬ CẢNH CÁO ─╮\n` +
          `│ ${name(target)}\n` +
          `╰───────────────────────╯\n\n` +
          `Tổng số vi phạm: ${warnings.length}\n` +
          `────────────\n` +
          `${lines.join('\n') || '  ✨ Chưa có tiền án vi phạm nào.'}`,
          threadID
        );
      }
      if (mode === 'xoa') {
        delete group.warnings[target];
        store.save();
        return send(`✅ Đã xóa toàn bộ lịch sử cảnh cáo của ${name(target)}.`, threadID);
      }
      if (target === actor || target === botID || adminsOf(details).has(target)) return send('⛔ Không thể cảnh cáo chính mình, bot hoặc QTV.', threadID);
      const mentionName = event.mentions?.[target];
      const reason = safe(event.messageReply?.senderID
        ? raw
        : mentionName
          ? raw.replace(new RegExp(`^@?${String(mentionName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '')
          : raw.replace(/^\d+\s*/, ''));
      if (!reason) return send('Vui lòng ghi kèm lý do sau lệnh cảnh cáo.', threadID);
      const warnings = (group.warnings[target] ||= []);
      warnings.push({ by: actor, reason, day: dayKey(now()) });
      if (warnings.length > 20) warnings.shift();
      store.save();
      return send(
        `╭─ ⚠️ THÔNG BÁO CẢNH CÁO ─╮\n` +
        `│ Quản trị viên xử lý vi phạm\n` +
        `╰─────────────────────────╯\n\n` +
        `👤 Người vi phạm: ${name(target)}\n` +
        `🔢 Mức phạt: Cảnh cáo #${warnings.length}\n` +
        `📝 Lý do: ${reason}\n` +
        `────────────\n` +
        `⚠️ Hãy giữ gìn văn hóa trò chuyện của nhóm!`,
        threadID,
        'warning'
      );
    }

    if (command === '!ship') {
      if (currentMembers.length < 2) return send('Cần ít nhất hai thành viên để ghép đôi.', threadID);
      const first = targetOf(event, raw, actor);
      if (!currentMembers.includes(first)) return send('Người này hiện không có trong nhóm.', threadID);
      const candidates = currentMembers.filter(id => id !== first).sort();
      const digest = createHash('sha256').update(`ship-v1:${threadID}:${dayKey(now())}:${first}`).digest();
      const second = candidates[digest.readUInt32BE(0) % candidates.length];
      const score = digest.readUInt32BE(4) % 101;
      const hearts = Math.max(1, Math.round(score / 20));
      return send(
        `╭─ 💞 GHÉP ĐÔI HÔM NAY ─╮\n` +
        `│ Tỉ lệ hợp cạ ngẫu nhiên\n` +
        `╰───────────────────────╯\n\n` +
        `✨ ${name(first)} × ${name(second)} ✨\n\n` +
        `Độ tâm đầu ý hợp: ${score}%\n` +
        `${'💖'.repeat(hearts)}${'🤍'.repeat(5 - hearts)}\n` +
        `────────────\n` +
        `🎲 Chỉ là trò vui ngẫu nhiên giải trí trong ngày!`,
        threadID,
        'ship'
      );
    }
  }

  async function checkBirthdays() {
    const timestamp = now();
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hourCycle: 'h23' }).format(new Date(timestamp)));
    if (hour < 8) return;
    const day = dayKey(timestamp);
    const date = `${day.slice(8, 10)}/${day.slice(5, 7)}`;
    for (const [threadID] of Object.entries(store.data.groups)) {
      const group = store.group(threadID);
      if (!group.initialized) continue;
      const announced = new Set(Array.isArray(group.birthdayAnnounced[day]) ? group.birthdayAnnounced[day] : []);
      const celebrants = Object.entries(group.birthdays)
        .filter(([id, birthday]) => birthday === date && group.members.includes(id) && !announced.has(id));
      if (!celebrants.length) continue;
      const names = celebrants.map(([id]) => group.names[id] || id);
      try {
        await send(
          `╭─ 🎉 CHÚC MỪNG SINH NHẬT ─╮\n` +
          `│ Hôm nay là ngày đặc biệt! 🎂\n` +
          `╰──────────────────────────╯\n\n` +
          `Xin gửi lời chúc mừng sinh nhật ấm áp nhất đến:\n` +
          `✨ ${names.join(', ')}\n\n` +
          `Chúc bạn thêm tuổi mới ngập tràn niềm vui, sức khỏe và thành công rực rỡ! 🥳🎈`,
          threadID,
          'birthday'
        );
      } catch (error) {
        console.error(`Không gửi được lời chúc sinh nhật đến nhóm ${threadID}:`, error);
        continue;
      }
      group.birthdayAnnounced[day] = [...announced, ...celebrants.map(([id]) => id)];
      const cutoff = daysAgo(365, timestamp);
      for (const oldDay of Object.keys(group.birthdayAnnounced)) if (oldDay < cutoff) delete group.birthdayAnnounced[oldDay];
      store.save();
    }
  }

  return { handleCommand, handleReaction, trackInteractions, checkBirthdays };
}

module.exports = { createFeatures, birthdayDate };


