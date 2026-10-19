const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { createBot, funScore } = require('../src/bot');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-group-bot-'));
  const store = new Store(path.join(dir, 'activity.json'));
  const sent = [];
  const removed = [];
  const clock = { value: Date.parse('2026-10-19T12:00:00Z') };
  const thread = {
    isGroup: true, participantIDs: ['bot', 'admin', 'member'],
    adminIDs: [{ id: 'bot' }, { id: 'admin' }],
    userInfo: [
      { id: 'bot', name: 'Bot' }, { id: 'admin', name: 'Quản trị' },
      { id: 'member', name: 'Thành viên' }
    ]
  };
  const api = { getCurrentUserID: () => 'bot' };
  const bot = createBot(api, store, {
    getThreadInfo: async () => thread,
    send: async (text) => { sent.push(text); return { messageID: `bot${sent.length}` }; },
    removeUserFromGroup: async id => removed.push(id),
    now: () => clock.value
  });
  return { bot, store, sent, removed, thread, clock, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('chào người mới đúng thứ tự, không chào trùng sự kiện', async () => {
  const x = setup();
  try {
    x.thread.participantIDs.push('new');
    x.thread.userInfo.push({ id: 'new', name: 'Bạn Mới' });
    const event = { type: 'event', threadID: 'g1', logMessageType: 'log:subscribe',
      logMessageData: { addedParticipants: [{ id: 'new', name: 'Bạn Mới' }] } };
    await x.bot.handle(event);
    await x.bot.handle(event);
    assert.equal(x.sent.length, 1);
    assert.match(x.sent[0], /Bạn Mới.*thành viên thứ 4/);
    assert.deepEqual(x.store.group('g1').members, ['bot', 'admin', 'member', 'new']);
  } finally { x.cleanup(); }
});

test('thống kê tin nhắn duy nhất và quyền kick', async () => {
  const x = setup();
  try {
    const msg = { type: 'message', threadID: 'g1', senderID: 'member', messageID: 'm1', body: 'Xin chào' };
    await x.bot.handle(msg);
    await x.bot.handle(msg);
    await x.bot.handle({ type: 'message', threadID: 'g1', senderID: 'member', messageID: 'm2', body: '!hoatdong' });
    assert.match(x.sent.at(-1), /Thành viên: 2 tin/);
    await x.bot.handle({ type: 'message', threadID: 'g1', senderID: 'member', messageID: 'm3', body: '!kick admin' });
    assert.match(x.sent.at(-1), /Chỉ quản trị viên/);
    assert.equal(x.removed.length, 0);
    await x.bot.handle({ type: 'message', threadID: 'g1', senderID: 'admin', messageID: 'm4', body: '!kick', messageReply: { senderID: 'member' } });
    assert.deepEqual(x.removed, ['member']);
  } finally { x.cleanup(); }
});

test('điểm vui ổn định trong ngày và bảng xếp hạng chỉ có thành viên', async () => {
  const x = setup();
  try {
    const command = { type: 'message', threadID: 'g1', senderID: 'member', body: '!dogay' };
    await x.bot.handle({ ...command, messageID: 'fun1' });
    const first = x.sent.at(-1);
    await x.bot.handle({ ...command, messageID: 'fun2' });
    assert.equal(x.sent.at(-1), first);
    assert.match(first, /Thành viên/);
    assert.match(first, /Chỉ số ngẫu nhiên/);
    assert.match(first, /Hạng \d\/2/);
    await x.bot.handle({ ...command, messageID: 'fun3', body: '!bangdogay' });
    assert.match(x.sent.at(-1), /BẢNG ĐỘ GAY HÔM NAY/);
    assert.doesNotMatch(x.sent.at(-1), /🥇 Bot|🥈 Bot/);
    assert.equal(funScore('g1', 'member', '2026-10-19'), funScore('g1', 'member', '2026-10-19'));
  } finally { x.cleanup(); }
});

test('hồ sơ, điểm danh và tương tác hoạt động qua nhiều ngày', async () => {
  const x = setup();
  try {
    const message = (id, body, extra = {}) => x.bot.handle({
      type: 'message', threadID: 'g1', senderID: 'member', messageID: id, body, ...extra
    });
    await message('a1', '!diemdanh');
    await message('a2', '!diemdanh');
    assert.equal(x.store.group('g1').checkins.member.total, 1);
    x.clock.value += 86400000;
    await message('a3', '!diemdanh');
    assert.equal(x.store.group('g1').checkins.member.streak, 2);
    await message('a4', 'Chào QTV', { messageReply: { senderID: 'admin' }, mentions: { admin: 'Quản trị' } });
    await message('a5', '!bangtuongtac');
    assert.match(x.sent.at(-1), /Quản trị ↔ Thành viên · 1 lần/);
    await message('a6', '!profile');
    assert.match(x.sent.at(-1), /chuỗi 2 ngày/);
    assert.match(x.sent.at(-1), /Hạng hoạt động/);
  } finally { x.cleanup(); }
});

test('sinh nhật được chúc một lần và ngày nhập phải hợp lệ', async () => {
  const x = setup();
  try {
    await x.bot.handle({ type: 'message', threadID: 'g1', senderID: 'member', messageID: 'b1', body: '!sinhnhat 31/02' });
    assert.match(x.sent.at(-1), /không hợp lệ/);
    await x.bot.handle({ type: 'message', threadID: 'g1', senderID: 'member', messageID: 'b2', body: '!sinhnhat 19/10' });
    x.clock.value = Date.parse('2026-10-19T01:00:00Z');
    await x.bot.checkBirthdays();
    await x.bot.checkBirthdays();
    assert.equal(x.sent.filter(text => text.includes('CHÚC MỪNG SINH NHẬT')).length, 1);
    assert.match(x.sent.at(-1), /Thành viên/);
  } finally { x.cleanup(); }
});

test('bình chọn bằng reaction, cảnh cáo của QTV và ghép đôi', async () => {
  const x = setup();
  try {
    const message = (senderID, id, body, extra = {}) => x.bot.handle({
      type: 'message', threadID: 'g1', senderID, messageID: id, body, ...extra
    });
    await message('member', 'p1', '!binhchon Ăn gì? | Phở | Bún');
    const pollID = x.store.group('g1').poll.messageID;
    await x.bot.handle({ type: 'message_reaction', threadID: 'g1', messageID: pollID, userID: 'admin', reaction: '2️⃣' });
    await x.bot.handle({ type: 'message_reaction', threadID: 'g1', messageID: pollID, userID: 'member', reaction: '2️⃣' });
    await x.bot.handle({ type: 'message_reaction', threadID: 'g1', messageID: pollID, userID: 'member', reaction: '1️⃣' });
    await message('member', 'p1b', '!vote 1');
    await message('member', 'p2', '!ketqua');
    assert.match(x.sent.at(-1), /Bún[\s\S]*1 phiếu/);
    assert.equal(new Store(x.store.file).group('g1').poll.votes.member, 0);
    await message('admin', 'p3', '!dongbinhchon');
    assert.equal(x.store.group('g1').poll.active, false);
    await message('member', 'p4', '!canhbao spam', { messageReply: { senderID: 'admin' } });
    assert.match(x.sent.at(-1), /Chỉ quản trị viên/);
    await message('admin', 'p5', '!canhbao gửi spam', { messageReply: { senderID: 'member' } });
    assert.equal(x.store.group('g1').warnings.member.length, 1);
    await message('member', 'p6', '!ship');
    assert.match(x.sent.at(-1), /Thành viên × Quản trị/);
  } finally { x.cleanup(); }
});
