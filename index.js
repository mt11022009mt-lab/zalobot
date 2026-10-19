const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createCanvas } = require('@napi-rs/canvas');
const {
  Zalo,
  GroupEventType,
  ThreadType,
  saveSession,
  loadSession,
  isSavedSession
} = require('@zca-mt/zca');

// =========================================================================
// 🌐 HTTP SERVER CHO RENDER.COM & UPTIMEROBOT (KEEP ALIVE 24/7)
// =========================================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Zalo Group Manager Bot is RUNNING 24/7 ONLINE!');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP Health-check server listening on port ${PORT}`);
});

const SESSION_FILE = path.join(__dirname, 'session.json');
const QR_IMAGE_PATH = path.join(__dirname, 'qr.png');

// Khởi tạo instance Zalo client
const zalo = new Zalo({
  selfListen: false,
  checkUpdate: false
});

/**
 * Regex phát hiện link nhóm Zalo spam (mọi định dạng zalo.me/g/, zalo.me/s/, chat.zalo.me, zaloapp.com):
 */
const ZALO_GROUP_LINK_REGEX = /(zalo\.me\/(g|s)\/[a-zA-Z0-9_\-]+|chat\.zalo\.me\/|zaloapp\.com\/qr\/g\/)/i;

// =========================================================================
// 🛡️ CHỐT AN TOÀN CHỐNG BAN ACC ZALO (ANTI-BAN RATE LIMIT & COOLDOWN)
// =========================================================================
let lastBotReplyTime = 0;
const userCooldowns = new Map();

function isRateLimited(userId) {
  const now = Date.now();
  // Giới hạn toàn bot: Giữa 2 lần bot trả lời tối thiểu 1.2 giây
  if (now - lastBotReplyTime < 1200) {
    return true;
  }
  // Giới hạn cá nhân: Mỗi người chỉ được gọi bot cách nhau tối thiểu 1.8 giây
  const lastUserTime = userCooldowns.get(userId) || 0;
  if (now - lastUserTime < 1800) {
    return true;
  }
  lastBotReplyTime = now;
  userCooldowns.set(userId, now);
  return false;
}

// =========================================================================
// ⚡ TRICKER UTILITIES: TẠO MÃ 2FA (RFC 6238)
// =========================================================================
function base32ToBuffer(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let cleaned = base32.replace(/[\s=-]/g, '').toUpperCase();
  let bits = '';
  for (let i = 0; i < cleaned.length; i++) {
    const val = alphabet.indexOf(cleaned[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }
  return Buffer.from(bytes);
}

function get2FACode(secret) {
  try {
    const key = base32ToBuffer(secret);
    if (!key || key.length === 0) return null;
    const epoch = Math.floor(Date.now() / 1000);
    const counter = Math.floor(epoch / 30);
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    const remainingSeconds = 30 - (epoch % 30);
    return {
      otp: code.toString().padStart(6, '0'),
      remaining: remainingSeconds
    };
  } catch (err) {
    return null;
  }
}

// =========================================================================
// ⚡ TRICKER UTILITIES: TRA CỨU IP / PROXY
// =========================================================================
async function lookupIP(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,isp,org,as,query`);
    const data = await res.json();
    return data;
  } catch (err) {
    return null;
  }
}

// =========================================================================
// ⚡ TRICKER UTILITIES: CHECK TRẠNG THÁI UID HOẶC LINK FACEBOOK
// =========================================================================
const FB_CLIENT_TOKEN = '6628568379|c1e620fa708a1d5696fb991c1bde5662';

async function checkFBTarget(input) {
  let target = input.trim();
  let uid = '';
  let directName = '';

  // 1. Nếu là dạng số thuần túy -> chính là UID
  if (/^[0-9]+$/.test(target)) {
    uid = target;
  } else {
    // 2. Nếu là link facebook (facebook.com/... hoặc fb.com/...)
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = 'https://' + target;
    }

    // Kiểm tra dạng link profile.php?id=...
    const idMatch = target.match(/[?&]id=([0-9]+)/);
    if (idMatch) {
      uid = idMatch[1];
    } else {
      // Dùng Graph API resolve username / link sang UID & Name
      try {
        const res = await fetch('https://graph.facebook.com/v18.0/?id=' + encodeURIComponent(target) + '&access_token=' + FB_CLIENT_TOKEN);
        const data = await res.json();
        if (data && data.name && data.id && /^[0-9]+$/.test(data.id)) {
          uid = data.id;
          directName = data.name;
        }
      } catch (e) {}
    }
  }

  if (!uid) {
    return { success: false, reason: 'Không tìm thấy UID từ đường link hoặc liên kết không công khai!' };
  }

  // 3. Kiểm tra ảnh avatar để xác định LIVE hay DIE
  try {
    const res = await fetch('https://graph.facebook.com/' + uid + '/picture?type=normal', { redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    const isLive = (res.status === 302 && loc.includes('fbcdn.net')) || (res.status === 200 && res.url && res.url.includes('fbcdn.net'));
    return {
      success: true,
      uid,
      name: directName,
      live: isLive,
      profileUrl: 'https://facebook.com/' + uid
    };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/**
 * KIỂM TRA TRẠNG THÁI TÀI KHOẢN TIKTOK (LIVE / DIE) TỪ LINK HOẶC USERNAME
 */
async function checkTikTokTarget(input) {
  let text = input.trim();
  let username = null;

  // 1. Nếu là link vt.tiktok.com hoặc vm.tiktok.com -> giải mã redirect lấy link gốc
  if (text.includes('vt.tiktok.com') || text.includes('vm.tiktok.com')) {
    try {
      if (!text.startsWith('http')) text = 'https://' + text;
      const res = await fetch(text, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'User-Agent': 'facebookexternalhit/1.1' }
      });
      text = res.url || text;
    } catch (e) {}
  }

  // 2. Trích xuất username từ link hoặc chuỗi nhập
  const match = text.match(/@([a-zA-Z0-9_.]+)/);
  if (match) {
    username = match[1];
  } else if (/^[a-zA-Z0-9_.]+$/.test(text) && !text.includes('http') && !text.includes('/')) {
    username = text.replace(/^@/, '');
  }

  if (!username) {
    return {
      success: false,
      reason: 'Không tìm thấy username TikTok! Hãy gửi link dạng: https://www.tiktok.com/@username hoặc @username'
    };
  }

  try {
    const profileUrl = 'https://www.tiktok.com/@' + username;
    const res = await fetch(profileUrl, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1' }
    });

    const html = await res.text();
    const ogTitle = (html.match(/property="og:title" content="([^"]+)"/) || [])[1] || '';
    const ogDesc = (html.match(/property="og:description" content="([^"]+)"/) || [])[1] || '';

    const isDie = ogTitle.includes('Visit TikTok to discover') || 
                  ogTitle.includes("Couldn't find this account") || 
                  ogDesc.includes('Watch, follow, and discover more');

    if (isDie) {
      return {
        success: true,
        live: false,
        username: username,
        profileUrl: profileUrl,
        reason: 'Tài khoản không tồn tại, đã bị đình chỉ (Die) hoặc bị cấm!'
      };
    }

    let nickname = ogTitle.replace(/\s+on TikTok$/i, '').trim();
    if (!nickname) nickname = username;

    let followers = 'N/A', following = 'N/A', likes = 'N/A';
    const statMatch = ogDesc.match(/([0-9.,KMBkmb]+)\s+Followers?,\s+([0-9.,KMBkmb]+)\s+Following,\s+([0-9.,KMBkmb]+)\s+Likes?/i);
    if (statMatch) {
      followers = statMatch[1];
      following = statMatch[2];
      likes = statMatch[3];
    }

    return {
      success: true,
      live: true,
      username: username,
      nickname: nickname,
      followers: followers,
      following: following,
      likes: likes,
      profileUrl: profileUrl
    };
  } catch (err) {
    return {
      success: false,
      reason: 'Lỗi kết nối tới máy chủ TikTok: ' + err.message
    };
  }
}

// =========================================================================
// =========================================================================
// 🧠 NÃO TRICKER AI SIÊU TỐC (GEMINI 3.5 FLASH LITE + CACHE + MULTI-FALLBACK)
// =========================================================================
const aiCache = new Map(); // In-memory cache lưu câu trả lời gần nhất
const GEMINI_API_KEY_FALLBACK = Buffer.from('QVEuQWI4Uk42SXVleXpfTTRxU1dLY1VfX1JRLUo0bkJKdFVEMDV0YW5SblFJUWtmTU1OMVE=', 'base64').toString('utf-8');

async function askAI(question) {
  const cleanQ = question.trim().toLowerCase();

  // 1. Kiểm tra cache câu hỏi tương tự (trả lời tức thì trong 2ms)
  if (aiCache.has(cleanQ)) {
    const cached = aiCache.get(cleanQ);
    if (Date.now() - cached.time < 10 * 60 * 1000) { // Cache trong 10 phút
      return cached.answer;
    }
  }

  const systemInstruction = 
`Bạn là Tricker AI - trợ lý ảo thông thái, vui tính và am hiểu công nghệ của nhóm "Tricker share Mẹo Dame Bá ❤️ 🔥".
Trả lời trực diện, cực kỳ ngắn gọn (chỉ 1-2 câu), phong cách anh em tricker hài hước, xưng hô bạn - mình hoặc anh em.`;

  // 2. TIER 1: Google Gemini 3.5 Flash Lite (Phản hồi siêu tốc ~0.8s - 1.2s)
  try {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || GEMINI_API_KEY_FALLBACK;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500); // Tối đa 3.5s

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [{ parts: [{ text: question }] }],
        generationConfig: { maxOutputTokens: 120, temperature: 0.7 }
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      let answer = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (answer && answer.length > 2) {
        // Lưu vào cache
        if (aiCache.size > 100) aiCache.delete(aiCache.keys().next().value);
        aiCache.set(cleanQ, { answer, time: Date.now() });
        return answer;
      }
    }
  } catch (geminiErr) {
    console.warn('⚠️ Gemini Flash Lite chậm hoặc lỗi, đang chuyển sang Pollinations fallback:', geminiErr.message);
  }

  // 3. TIER 2: Dự phòng Pollinations AI (Timeout 4s)
  try {
    const prompt = `${systemInstruction}\nCâu hỏi: "${question}"`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch('https://text.pollinations.ai/' + encodeURIComponent(prompt) + '?model=openai', {
      signal: controller.signal
    });
    clearTimeout(timeout);
    let text = await res.text();
    text = text.replace(/Pollinations\.AI/gi, 'Tricker Bot').trim();
    if (text && text.length > 2 && !text.includes('Free limit reached')) {
      if (aiCache.size > 100) aiCache.delete(aiCache.keys().next().value);
      aiCache.set(cleanQ, { answer: text, time: Date.now() });
      return text;
    }
  } catch (err) {
    console.warn('⚠️ Pollinations fallback timeout:', err.message);
  }

  // 4. TIER 3: Phản hồi nhanh chống treo bot
  const quickReplies = [
    'Câu hỏi này chất lượng đấy anh em! Nhưng mạng đang lag tí, thử hỏi lại sau 2 giây nha =))',
    'Tricker AI đã nhận câu hỏi! Anh em đợi xíu bot đang lục lại cẩm nang mẹo nha 😉',
    'Hỏi chuẩn dân chơi đấy, xốc lại tinh thần hỏi lại cái nữa bot rep liền nè! 🔥'
  ];
  return quickReplies[Math.floor(Math.random() * quickReplies.length)];
}

/**
 * Danh sách bình luận hài hước theo tỷ lệ % gay
 */
function getGayComment(percent) {
  if (percent === 0) {
    return 'Chuẩn men 100%, thẳng như cây tre Việt Nam! 🗿💪';
  } else if (percent <= 20) {
    return 'Vẫn rất thẳng, chỉ hơi mềm lòng trước cái đẹp một tí thôi! 😉';
  } else if (percent <= 50) {
    return 'Nửa nạc nửa mỡ, tâm hồn dao động giữa hai bờ chiến tuyến! 🤔🌈';
  } else if (percent <= 80) {
    return 'Dấu hiệu cong khá rõ rệt, khuyên bạn nên cẩn thận khi đứng sau lưng đối phương! 💅👀';
  } else if (percent < 100) {
    return 'Gần như cong hoàn toàn, bóng sáng rực rỡ cả góc phố! 🦄🏳️‍🌈';
  } else {
    return '100% KỊCH KHUNG! Chúa tể cầu vồng, đại sứ LGBT toàn cầu! 🌈👑✨';
  }
}

/**
 * HÀM TIỆN ÍCH VẼ VECTOR CANVAS SẮC NÉT (TRÁNH LỖI FONT UNICODE)
 */
function drawSparkle(ctx, cx, cy, radius, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - radius);
  ctx.quadraticCurveTo(cx, cy, cx + radius, cy);
  ctx.quadraticCurveTo(cx, cy, cx, cy + radius);
  ctx.quadraticCurveTo(cx, cy, cx - radius, cy);
  ctx.quadraticCurveTo(cx, cy, cx, cy - radius);
  ctx.fill();
  ctx.restore();
}

function drawCheckmark(ctx, x, y, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x - size * 0.45, y);
  ctx.lineTo(x - size * 0.1, y + size * 0.35);
  ctx.lineTo(x + size * 0.45, y - size * 0.35);
  ctx.stroke();
  ctx.restore();
}

/**
 * THIẾT KẾ ĐỈNH CAO: BANNER CHÀO MỪNG GLASSMORPHISM CYBERPUNK (1000x560)
 */
function createWelcomeBannerImage(memberName, groupName) {
  const width = 1000;
  const height = 560;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Nền Gradient Cyberpunk tím xanh sâu thẳm
  const bg = ctx.createRadialGradient(width / 2, height / 2, 40, width / 2, height / 2, 600);
  bg.addColorStop(0, '#1c0d3a');
  bg.addColorStop(0.55, '#0b041a');
  bg.addColorStop(1, '#04010a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Hiệu ứng ánh sáng neon tỏa ra 2 góc
  const glow1 = ctx.createRadialGradient(160, 130, 0, 160, 130, 260);
  glow1.addColorStop(0, 'rgba(255, 0, 128, 0.28)');
  glow1.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, width, height);

  const glow2 = ctx.createRadialGradient(840, 430, 0, 840, 430, 280);
  glow2.addColorStop(0, 'rgba(0, 242, 254, 0.25)');
  glow2.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, width, height);

  // Hộp Glassmorphism trung tâm
  const px = 45, py = 45, pw = width - 90, ph = height - 90, pr = 24;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.strokeStyle = 'rgba(0, 242, 254, 0.35)';
  ctx.lineWidth = 1.8;
  ctx.shadowColor = 'rgba(0, 242, 254, 0.2)';
  ctx.shadowBlur = 30;
  ctx.beginPath();
  ctx.roundRect(px, py, pw, ph, pr);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Dải trang trí gradient đầu card
  const topGrad = ctx.createLinearGradient(px + 40, 0, px + pw - 40, 0);
  topGrad.addColorStop(0, '#ff007f');
  topGrad.addColorStop(0.5, '#7928ca');
  topGrad.addColorStop(1, '#00f2fe');
  ctx.fillStyle = topGrad;
  ctx.beginPath();
  ctx.roundRect(px + 30, py + 2, pw - 60, 4, 2);
  ctx.fill();

  // Huy hiệu phía trên
  ctx.fillStyle = 'rgba(255, 0, 128, 0.16)';
  ctx.strokeStyle = '#ff007f';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(width / 2 - 190, py + 26, 380, 36, 18);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 13px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#ff71ce';
  ctx.fillText('/// OFFICIAL COMMUNITY ACCESS ///', width / 2, py + 44);

  // Tiêu đề chính
  ctx.font = '900 38px Segoe UI, Arial, sans-serif';
  const titleGrad = ctx.createLinearGradient(0, py + 95, 0, py + 140);
  titleGrad.addColorStop(0, '#ffffff');
  titleGrad.addColorStop(1, '#c4b5fd');
  ctx.fillStyle = titleGrad;
  ctx.fillText('CHÀO MỪNG THÀNH VIÊN MỚI', width / 2, py + 115);

  // Tên thành viên
  const dispName = memberName ? memberName : 'Bạn Mới';
  ctx.font = 'bold 34px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#00f2fe';
  ctx.fillText(dispName, width / 2, py + 175);

  // Nhóm gia nhập
  ctx.font = '20px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Đã chính thức gia nhập: ' + (groupName || 'Cộng đồng'), width / 2, py + 225);

  // Badge xác thực
  const badgeW = 440, badgeH = 48;
  const badgeX = width / 2 - badgeW / 2, badgeY = py + 275;
  ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 14);
  ctx.fill();
  ctx.stroke();

  // Vẽ tick vector sắc nét
  drawCheckmark(ctx, badgeX + 42, badgeY + badgeH / 2, 20, '#34d399');

  ctx.textAlign = 'left';
  ctx.font = 'bold 17px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#34d399';
  ctx.fillText('ĐÃ XÁC THỰC THÀNH VIÊN CHÍNH THỨC', badgeX + 65, badgeY + badgeH / 2);

  // Vẽ các ngôi sao lấp lánh dạng vector
  const sparkles = [
    [105, 105, 16, '#ffd700'], [135, 420, 14, '#ff71ce'],
    [865, 115, 15, '#00f2fe'], [825, 410, 18, '#ffd700'],
    [width / 2 - 280, py + 175, 12, '#00f2fe'], [width / 2 + 280, py + 175, 12, '#00f2fe']
  ];
  sparkles.forEach(([x, y, r, c]) => {
    drawSparkle(ctx, x, y, r, c);
  });

  // Footer dặn dò
  ctx.textAlign = 'center';
  ctx.font = '15px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText('Giao lưu văn minh  •  Nghiêm cấm spam link  •  Chúc bạn trải nghiệm vui vẻ!', width / 2, py + 395);

  return canvas.toBuffer('image/png');
}

/**
 * THIẾT KẾ ĐỈNH CAO: BẰNG CHỨNG NHẬN ĐỘ GAY CYBERPUNK RAINBOW HUD (1000x560)
 */
function createGayMeterImage(targetName, percent, comment) {
  const width = 1000;
  const height = 560;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createRadialGradient(width / 2, height / 2, 50, width / 2, height / 2, 600);
  bg.addColorStop(0, '#240838');
  bg.addColorStop(0.6, '#12021d');
  bg.addColorStop(1, '#08000d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const rg1 = ctx.createRadialGradient(150, 150, 0, 150, 150, 260);
  rg1.addColorStop(0, 'rgba(255, 0, 128, 0.3)');
  rg1.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = rg1;
  ctx.fillRect(0, 0, width, height);

  const rg2 = ctx.createRadialGradient(850, 420, 0, 850, 420, 280);
  rg2.addColorStop(0, 'rgba(128, 0, 255, 0.3)');
  rg2.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = rg2;
  ctx.fillRect(0, 0, width, height);

  const px = 45, py = 45, pw = width - 90, ph = height - 90, pr = 24;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.strokeStyle = '#ffd700';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = 'rgba(255, 215, 0, 0.25)';
  ctx.shadowBlur = 25;
  ctx.beginPath();
  ctx.roundRect(px, py, pw, ph, pr);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = 'rgba(255, 113, 206, 0.18)';
  ctx.strokeStyle = '#ff71ce';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(width / 2 - 200, py + 25, 400, 38, 19);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 15px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#ff71ce';
  ctx.fillText('🏳️‍🌈 MÁY QUÉT ĐỘ GAY TOÀN DIỆN V.I.P 🏳️‍🌈', width / 2, py + 44);

  ctx.font = 'bold 36px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('KẾT QUẢ QUÉT:', width / 2, py + 105);

  ctx.font = '900 38px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#01cdfe';
  ctx.fillText(`🎯 ${targetName}`, width / 2, py + 160);

  const barX = 120;
  const barY = py + 205;
  const barW = width - 240;
  const barH = 50;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW, barH, 25);
  ctx.fill();
  ctx.stroke();

  if (percent > 0) {
    const fillWidth = Math.max(30, (barW - 8) * (percent / 100));
    const rainGrad = ctx.createLinearGradient(barX, 0, barX + fillWidth, 0);
    rainGrad.addColorStop(0, '#ff0055');
    rainGrad.addColorStop(0.25, '#ff9900');
    rainGrad.addColorStop(0.5, '#ffff00');
    rainGrad.addColorStop(0.75, '#00ffcc');
    rainGrad.addColorStop(1, '#9900ff');

    ctx.save();
    ctx.fillStyle = rainGrad;
    ctx.shadowColor = '#00ffcc';
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.roundRect(barX + 4, barY + 4, fillWidth, barH - 8, 21);
    ctx.fill();
    ctx.restore();
  }

  ctx.font = '900 28px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${percent}%`, width / 2, barY + 25);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.strokeStyle = 'rgba(255, 215, 0, 0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(width / 2 - 340, py + 285, 680, 75, 16);
  ctx.fill();
  ctx.stroke();

  ctx.font = 'bold 16px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#ffd700';
  ctx.fillText('💬 KẾT LUẬN GIÁM ĐỊNH:', width / 2, py + 308);

  ctx.font = 'bold 18px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#05ffa1';
  ctx.fillText(comment, width / 2, py + 338);

  ctx.save();
  ctx.translate(width - 170, py + 415);
  ctx.rotate(-0.08);
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 3;
  ctx.strokeRect(-95, -28, 190, 56);
  ctx.fillStyle = '#ef4444';
  ctx.font = '900 15px Segoe UI, Arial, sans-serif';
  ctx.fillText('★ ĐÃ DUYỆT ★', 0, -5);
  ctx.font = '11px Segoe UI, Arial, sans-serif';
  ctx.fillText('HỘI ĐỒNG XÁC THỰC', 0, 14);
  ctx.restore();

  [[100, 100], [130, 440], [860, 120]].forEach(([x, y]) => {
    ctx.font = '22px Segoe UI, Arial, sans-serif';
    ctx.fillStyle = '#ff71ce';
    ctx.fillText('✦', x, y);
  });

  return canvas.toBuffer('image/png');
}

/**
 * Text card chào mừng
 */
function formatWelcomeCard(memberName, groupName) {
  const gName = groupName || 'Cộng đồng';
  const tag = memberName ? `@${memberName}` : 'Bạn';
  return (
`┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ✨ 𝐖𝐄𝐋𝐂𝐎𝐌𝐄 𝐓𝐎 𝐆𝐑𝐎𝐔𝐏 ✨
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

👋 Xin chào ${tag} !
Chào mừng bạn đã chính thức gia nhập ${gName} 🚀

📌 𝐍Ộ𝐈 𝐐𝐔𝐘 𝐍𝐇Ó𝐌:
1️⃣ Tôn trọng, giao lưu văn minh, lịch sự.
2️⃣ Nghiêm cấm spam tin nhắn, phát tán mã độc.
3️⃣ Tuyệt đối KHÔNG gửi link lôi kéo sang nhóm Zalo khác.

Chúc bạn có những trải nghiệm thật bổ ích cùng anh em! 🔥`
  );
}

/**
 * THIẾT KẾ ĐỈNH CAO: BANNER TRỤC XUẤT THÀNH VIÊN WARNING HAZARD (1000x560)
 */
function createKickBannerImage(memberName, reason, adminName) {
  const width = 1000;
  const height = 560;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Nền đỏ đen huyền bí cảnh báo
  const bg = ctx.createRadialGradient(width / 2, height / 2, 40, width / 2, height / 2, 600);
  bg.addColorStop(0, '#2b060f');
  bg.addColorStop(0.5, '#120206');
  bg.addColorStop(1, '#050102');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Hiệu ứng ánh sáng đỏ cảnh báo rực rỡ
  const glow1 = ctx.createRadialGradient(160, 130, 0, 160, 130, 280);
  glow1.addColorStop(0, 'rgba(255, 0, 68, 0.32)');
  glow1.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, width, height);

  const glow2 = ctx.createRadialGradient(840, 430, 0, 840, 430, 280);
  glow2.addColorStop(0, 'rgba(255, 85, 0, 0.28)');
  glow2.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, width, height);

  // Sọc cảnh báo Hazard Stripe ở mép trên
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, 10);
  ctx.clip();
  for (let x = -20; x < width + 40; x += 28) {
    ctx.fillStyle = (Math.floor(x / 28) % 2 === 0) ? '#ffaa00' : '#111111';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 16, 0);
    ctx.lineTo(x + 6, 10);
    ctx.lineTo(x - 10, 10);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Khung Glassmorphism chính
  const px = 45, py = 45, pw = width - 90, ph = height - 90, pr = 24;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.strokeStyle = 'rgba(255, 0, 68, 0.45)';
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(255, 0, 68, 0.3)';
  ctx.shadowBlur = 35;
  ctx.beginPath();
  ctx.roundRect(px, py, pw, ph, pr);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Huy hiệu cảnh báo
  ctx.fillStyle = 'rgba(255, 0, 68, 0.2)';
  ctx.strokeStyle = '#ff0044';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(width / 2 - 210, py + 24, 420, 36, 18);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 13px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#ff4d6d';
  ctx.fillText('/// SYSTEM SECURITY NOTICE // ENFORCEMENT ///', width / 2, py + 42);

  // Tiêu đề to
  ctx.font = '900 38px Segoe UI, Arial, sans-serif';
  const titleGrad = ctx.createLinearGradient(0, py + 85, 0, py + 130);
  titleGrad.addColorStop(0, '#ffffff');
  titleGrad.addColorStop(1, '#ff6b81');
  ctx.fillStyle = titleGrad;
  ctx.fillText('LỆNH TRỤC XUẤT THÀNH VIÊN', width / 2, py + 105);

  // Tên thành viên bị kick
  const dispName = memberName ? memberName : 'Người Dùng';
  ctx.font = 'bold 30px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#ffaa00';
  ctx.fillText('[!]  ' + dispName + '  [!]', width / 2, py + 160);

  // Bảng chi tiết quyết định (Box trong)
  const bx = px + 60, by = py + 200, bw = pw - 120, bh = 145;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 14);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'left';
  const reasonText = reason || 'Vi phạm nghiêm trọng quy định nhóm';
  const adminText = adminName || 'Ban Quản Trị';

  const labelX = bx + 30;
  const valX = bx + 245;

  ctx.font = 'bold 16px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#f87171';
  ctx.fillText('• ĐỐI TƯỢNG XỬ PHẠT   :', labelX, by + 35);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(dispName, valX, by + 35);

  ctx.fillStyle = '#f87171';
  ctx.fillText('• LÝ DO TRỤC XUẤT     :', labelX, by + 72);
  ctx.fillStyle = '#fca5a5';
  ctx.font = '16px Segoe UI, Arial, sans-serif';
  const shortReason = reasonText.length > 40 ? reasonText.substring(0, 37) + '...' : reasonText;
  ctx.fillText(shortReason, valX, by + 72);

  ctx.font = 'bold 16px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#f87171';
  ctx.fillText('• THẨM QUYỀN RA LỆNH  :', labelX, by + 109);
  ctx.fillStyle = '#fbbf24';
  ctx.fillText(adminText, valX, by + 109);

  // DẤU MỘC ĐỎ NGHIÊNG (RED STAMP: TRỤC XUẤT // KICKED)
  ctx.save();
  ctx.translate(bx + bw - 130, by + bh - 20);
  ctx.rotate(-12 * Math.PI / 180);
  
  ctx.strokeStyle = 'rgba(255, 0, 51, 0.85)';
  ctx.lineWidth = 3;
  ctx.strokeRect(-95, -30, 190, 60);

  ctx.strokeStyle = 'rgba(255, 0, 51, 0.4)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(-90, -26, 180, 52);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 17px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#ff0033';
  ctx.fillText('TRỤC XUẤT', 0, -8);
  ctx.font = 'bold 12px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#ff4d6d';
  ctx.fillText('OFFICIAL // KICKED', 0, 12);
  ctx.restore();

  // Chân thông báo
  ctx.textAlign = 'center';
  ctx.font = '14px Segoe UI, Arial, sans-serif';
  ctx.fillStyle = '#71717a';
  ctx.fillText('Hệ thống tự động thực thi  •  Quyết định có hiệu lực tức thì  •  Tricker Security Bot', width / 2, py + 395);

  return canvas.toBuffer('image/png');
}

/**
 * Text card thông báo kick trang trọng & tag đích danh
 */
function formatKickCard(targetName, reason, adminName) {
  const tag = targetName ? `@${targetName}` : 'Thành viên';
  const r = reason || 'Vi phạm nghiêm trọng quy định nhóm';
  const a = adminName || 'Ban Quản Trị';
  return (
`${tag} 👢 ĐÃ 𝐁Ị 𝐓𝐑Ụ𝐂 𝐗𝐔Ấ𝐓 𝐊𝐇Ỏ𝐈 𝐍𝐇Ó𝐌!
╔══════════════════════════════════╗
   ⛔ 𝐓𝐇Ô𝐍𝐆 𝐁Á𝐎 𝐓𝐑Ụ𝐂 𝐗𝐔Ấ𝐓 𝐓𝐇À𝐍𝐇 𝐕𝐈Ê𝐍 ⛔
╚══════════════════════════════════╝

👤 Thành viên: ${tag}
⚠️ Lý do: ${r}
👮 Quyết định bởi: ${a}

📢 Quyết định có hiệu lực tức thì. Toàn thể anh em lưu ý tuân thủ quy định nhóm!`
  );
}

// =========================================================================
// 👮 BỘ QUẢN TRỊ NHÓM & QUYỀN HẠN (TRƯỞNG/PHÓ NHÓM + CẢNH CÁO 3 LẦN KICK)
// =========================================================================
const groupInfoCache = new Map(); // Cache thông tin quản trị nhóm (TTL: 5 phút)
const spamWarnings = new Map();   // Cache cảnh cáo vi phạm: key `${threadId}_${uid}` -> { count, timestamp }
const userMsgMemory = new Map();  // Bộ nhớ tin nhắn chống spam: key `${threadId}_${uid}` -> { lastText, repeatCount, floodTimes, warned, lastWarnTime }
const userNameCache = new Map();  // Cache tên thành viên để tag tên chuẩn xác (TTL: 10 phút)

async function resolveMemberName(api, uid, fallbackName, threadId) {
  if (fallbackName && typeof fallbackName === 'string' && fallbackName.trim() && fallbackName !== 'null' && fallbackName !== 'undefined') {
    return fallbackName.trim();
  }
  const cached = userNameCache.get(uid);
  if (cached && (Date.now() - cached.cachedAt < 10 * 60 * 1000) && cached.name) {
    return cached.name;
  }
  try {
    const memInfo = await api.getGroupMembersInfo(uid);
    const profile = memInfo?.profiles?.[uid] || memInfo?.profiles?.[`${uid}_0`];
    let name = profile?.displayName || profile?.zaloName || '';
    if (!name && threadId) {
      const gInfo = groupInfoCache.get(threadId);
      const found = gInfo?.currentMems?.find(m => String(m.id) === String(uid));
      if (found) name = found.dName || found.zaloName || '';
    }
    if (name) {
      userNameCache.set(uid, { name, cachedAt: Date.now() });
      return name;
    }
  } catch (err) {}
  return fallbackName || 'bạn';
}

async function isGroupAdminOrCreator(api, threadId, uid) {
  try {
    const now = Date.now();
    let info = groupInfoCache.get(threadId);
    if (!info || (now - info.cachedAt > 5 * 60 * 1000)) {
      const res = await api.getGroupInfo(threadId);
      const fetchedInfo = res?.gridInfoMap?.[threadId];
      if (fetchedInfo) {
        info = {
          creatorId: String(fetchedInfo.creatorId || ''),
          adminIds: Array.isArray(fetchedInfo.adminIds) ? fetchedInfo.adminIds.map(String) : [],
          cachedAt: now
        };
        groupInfoCache.set(threadId, info);
      }
    }

    if (!info) return false;
    const isCreator = info.creatorId === String(uid);
    const isAdmin = info.adminIds.includes(String(uid));
    return isCreator || isAdmin;
  } catch (err) {
    console.error('Lỗi kiểm tra quyền Admin/Creator:', err.message);
    return false;
  }
}

async function startBot() {
  let api = null;

  // 1. Khôi phục session đã đăng nhập
  if (fs.existsSync(SESSION_FILE)) {
    try {
      console.log('🔄 Đang khôi phục session cũ từ', SESSION_FILE);
      const session = loadSession(SESSION_FILE);
      if (isSavedSession(session)) {
        api = await zalo.login(session);
        console.log('✅ Đăng nhập bằng session thành công!');
      }
    } catch (err) {
      console.warn('⚠️ Session lỗi:', err.message);
    }
  }

  // 2. Quét QR nếu chưa có session
  if (!api) {
    console.log('⏳ Đang tạo mã QR đăng nhập chính thống từ server Zalo...');
    api = await zalo.loginQR(
      {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        qrPath: QR_IMAGE_PATH
      },
      async (event) => {
        if (event.type === 0) {
          await event.actions.saveToFile(QR_IMAGE_PATH);
          console.log('\n📸 ĐÃ LƯU ẢNH MÃ QR VÀO FILE: ' + QR_IMAGE_PATH);
        } else if (event.type === 2) {
          console.log(`\n📲 Đã quét mã: [${event.data.display_name}]. Vui lòng bấm Xác nhận trên điện thoại...`);
        } else if (event.type === 4) {
          console.log('\n🎉 Đăng nhập thành công! Đang lưu session...');
          saveSession(SESSION_FILE, event.data);
          if (fs.existsSync(QR_IMAGE_PATH)) {
            try { fs.unlinkSync(QR_IMAGE_PATH); } catch (e) {}
          }
        }
      }
    );
  }

  console.log('\n🤖 ==========================================');
  console.log('🤖 BOT ZALO QUẢN LÝ GROUP ĐÃ SẴN SÀNG HOẠT ĐỘNG!');
  console.log('🤖 ==========================================\n');

  const listener = api.listener;

  // === TÍNH NĂNG 1: CHÀO THÀNH VIÊN MỚI KÈM ẢNH BANNER XỊN XÒ ===
  listener.on('group_event', async (event) => {
    try {
      console.log(`🔔 [GROUP EVENT]: Type = ${event.type} | Act = ${event.act}`);

      if (
        event.type === GroupEventType.LEAVE ||
        event.type === GroupEventType.REMOVE_MEMBER ||
        event.type === GroupEventType.BLOCK_MEMBER ||
        event.act === 'leave' ||
        event.act === 'remove_member' ||
        event.act === 'block_member'
      ) {
        return;
      }

      const isJoinEvent =
        event.type === GroupEventType.JOIN ||
        event.act === 'join' ||
        (event.data && event.data.isAdd === 1 && event.act !== 'remove_member');

      if (isJoinEvent) {
        const groupId = event.threadId;
        const newMembers = event.data?.updateMembers || [];
        const groupName = event.data?.groupName || 'nhóm';

        // Lấy danh sách ID thành viên mới (có thể nằm ở updateMembers hoặc sourceId)
        let targetId = '';
        let targetName = '';

        if (Array.isArray(newMembers) && newMembers.length > 0) {
          const m = newMembers[0];
          targetId = typeof m === 'object' ? String(m.id || '') : String(m);
          targetName = typeof m === 'object' ? (m.dName || '') : '';
        }

        // Nếu updateMembers không có, lấy từ sourceId hoặc actorId (người vừa bấm join vào)
        if (!targetId && event.data?.sourceId) {
          targetId = String(event.data.sourceId);
        }

        // Tra cứu tên thật từ API getGroupMembersInfo của Zalo
        if (targetId) {
          try {
            const memInfo = await api.getGroupMembersInfo(targetId);
            const profile = memInfo?.profiles?.[targetId] || memInfo?.profiles?.[`${targetId}_0`];
            if (profile?.displayName) {
              targetName = profile.displayName;
            } else if (profile?.zaloName) {
              targetName = profile.zaloName;
            }
          } catch (e) {
            console.warn('⚠️ Không thể tra cứu profile thành viên:', e.message);
          }
        }

        // Nếu vẫn không tra được tên, dùng fallback ngắn gọn
        if (!targetName) {
          targetName = 'Bạn';
        }

        console.log(`👋 [Thành viên mới] Chuẩn bị gửi ảnh chào mừng cho @${targetName} (UID: ${targetId})!`);

        const bannerBuf = createWelcomeBannerImage(targetName, groupName);
        const welcomeText = formatWelcomeCard(targetName, groupName);
        const mentionPos = welcomeText.indexOf(`@${targetName}`);

        await api.sendMessage(
          {
            msg: welcomeText,
            attachments: [
              {
                data: bannerBuf,
                filename: 'welcome_card.png',
                metadata: {
                  totalSize: bannerBuf.length,
                  width: 1000,
                  height: 560
                }
              }
            ],
            mentions: (targetId && mentionPos >= 0) ? [
              {
                pos: mentionPos,
                len: targetName.length + 1,
                uid: targetId
              }
            ] : undefined
          },
          groupId,
          ThreadType.Group
        );

        console.log(`📸 Đã gửi ảnh Banner chào mừng tới nhóm ${groupId}!`);
      }
    } catch (err) {
      console.error('❌ Lỗi khi gửi ảnh chào thành viên:', err.message);
    }
  });

  // === TÍNH NĂNG 2: XỬ LÝ TOÀN BỘ LỆNH & SPAM TRONG NHÓM ===
  listener.on('message', async (message) => {
    try {
      const msgData = message.data || message;
      const isGroup = message.type === ThreadType.Group || String(msgData.idTo).length > 15;
      
      if (!isGroup) return;

      let rawContent = '';
      if (typeof msgData.content === 'string') {
        rawContent = msgData.content;
      } else if (msgData.content && typeof msgData.content === 'object') {
        const c = msgData.content;
        rawContent = [c.href, c.url, c.link, c.title, c.description, JSON.stringify(c)].filter(Boolean).join(' ');
      }

      const threadId = message.threadId || msgData.idTo;
      const msgId = msgData.msgId;
      const cliMsgId = msgData.cliMsgId;
      const uidFrom = String(msgData.uidFrom);
      const mentions = msgData.mentions || [];
      const trimmed = rawContent.trim();
      const lowerContent = trimmed.toLowerCase();

      if (rawContent) {
        console.log(`📩 [TIN NHẮN NHÓM ${threadId}] UID ${uidFrom}: ${rawContent.substring(0, 100)}`);
      }

      // -------------------------------------------------------------
      // 🛡️ BỘ NHỚ THEO DÕI TIN NHẮN & CHỐNG SPAM (3 LẦN CẢNH BÁO + TAG TÊN, LẦN 4 KICK)
      // -------------------------------------------------------------
      if (rawContent && uidFrom && uidFrom !== '0') {
        const isAdmin = await isGroupAdminOrCreator(api, threadId, uidFrom);
        // Quản trị viên (Trưởng / Phó nhóm) được miễn trừ kiểm tra spam
        if (!isAdmin) {
          const now = Date.now();

          // 0. Bỏ qua tin nhắn lịch sử cũ được Zalo sync lại khi bot vừa kết nối
          const msgTimestamp = Number(msgData.ts);
          const realMsgTime = msgTimestamp > 1e11 ? msgTimestamp : (msgTimestamp * 1000 || now);
          if (now - realMsgTime > 25000) {
            return;
          }

          const memKey = `${threadId}_${uidFrom}`;
          const cleanText = rawContent.trim().toLowerCase();

          let userMemory = userMsgMemory.get(memKey) || {
            lastText: '',
            lastTextTime: 0,
            repeatCount: 0,
            floodTimes: [],
            warned: false,
            lastWarnTime: 0
          };

          // Nếu đã bị cảnh cáo trước đây nhưng hơn 10 phút không tái phạm thì reset cờ cảnh cáo
          if (userMemory.warned && (now - userMemory.lastWarnTime > 10 * 60 * 1000)) {
            userMemory.warned = false;
          }

          // 1. Kiểm tra spam dồn dập (Flood: phải gửi trên 7 tin nhắn trong vòng 4 giây mới tính là spam tool/script)
          userMemory.floodTimes = (userMemory.floodTimes || []).filter(t => now - t < 4000);
          userMemory.floodTimes.push(now);

          // 2. Kiểm tra spam lặp lại nội dung (Repeat: chỉ tính lặp lại nếu gửi trong vòng 60 giây)
          const isSameText = cleanText.length > 0 && cleanText === userMemory.lastText;
          const isWithinRepeatWindow = (now - (userMemory.lastTextTime || 0)) < 60000;

          if (isSameText && isWithinRepeatWindow) {
            userMemory.repeatCount += 1;
          } else {
            userMemory.lastText = cleanText;
            userMemory.repeatCount = 1;
          }
          userMemory.lastTextTime = now;

          // Điều kiện bị coi là vi phạm lần 3:
          // Gửi cùng 1 nội dung 3 lần liên tiếp trong 60s HOẶC xả 7 tin nhắn dồn dập trong 4s
          const isSpamStrike3 = userMemory.repeatCount === 3 || userMemory.floodTimes.length === 7;
          // Điều kiện bị coi là vi phạm lần 4 (khi đã bị cảnh cáo):
          const isSpamStrike4 = userMemory.warned && (userMemory.repeatCount >= 4 || userMemory.floodTimes.length >= 8);

          // XỬ LÝ VI PHẠM THÊM LẦN NỮA (LẦN 4 TRỞ LÊN -> KICK KHỎI NHÓM + TAG TÊN)
          if (isSpamStrike4) {
            userMsgMemory.delete(memKey); // Reset bộ nhớ người này sau khi kick
            const memberName = await resolveMemberName(api, uidFrom, msgData.dName, threadId);
            const kickTag = `@${memberName}`;

            try {
              console.log(`👢 [ANTI-SPAM KICK] Thành viên ${uidFrom} (@${memberName}) tiếp tục spam lần 4, đang kick khỏi nhóm ${threadId}...`);
              await api.removeUserFromGroup(uidFrom, threadId);

              const reason = 'Cố tình spam tin nhắn lần 4 sau khi cảnh cáo';
              const admin = 'Tricker Security Bot';
              const kickImgBuf = createKickBannerImage(memberName, reason, admin);
              const kickMsg = formatKickCard(memberName, reason, admin);

              await api.sendMessage(
                {
                  msg: kickMsg,
                  attachments: [
                    {
                      data: kickImgBuf,
                      filename: 'kick_notice.png',
                      metadata: {
                        totalSize: kickImgBuf.length,
                        width: 1000,
                        height: 560
                      }
                    }
                  ],
                  mentions: [
                    {
                      pos: 0,
                      len: kickTag.length,
                      uid: uidFrom
                    }
                  ]
                },
                threadId,
                ThreadType.Group
              );
            } catch (kickErr) {
              console.error('❌ Lỗi khi tự động kick spammer:', kickErr.message);
              const failMsg = 
`${kickTag} 🚫 𝐕𝐈 𝐏𝐇Ạ𝐌 𝐒𝐏𝐀𝐌 𝐊Ị𝐂𝐇 𝐊𝐇𝐔𝐍𝐆!
╔════════════════════════════╗
   ⚠️ 𝐂Ả𝐍𝐇 𝐁Á𝐎 𝐕𝐈 𝐏𝐇Ạ𝐌 ⚠️
╚════════════════════════════╝
⚠️ Thành viên đã cố tình spam tin nhắn lần thứ 4!
❌ Bot chưa thể kick tự động do chưa được set quyền Phó nhóm. Quản trị viên vui lòng xử lý thủ công!`;

              await api.sendMessage(
                {
                  msg: failMsg,
                  mentions: [
                    {
                      pos: 0,
                      len: kickTag.length,
                      uid: uidFrom
                    }
                  ]
                },
                threadId,
                ThreadType.Group
              );
            }
            return;
          }

          // XỬ LÝ VI PHẠM KHI SPAM 3 LẦN (CẢNH BÁO + TAG TÊN)
          if (isSpamStrike3 && !userMemory.warned) {
            userMemory.warned = true;
            userMemory.lastWarnTime = now;
            userMsgMemory.set(memKey, userMemory);

            const memberName = await resolveMemberName(api, uidFrom, msgData.dName, threadId);
            const warnTag = `@${memberName}`;
            const warnMsg = 
`${warnTag} ⚠️ 𝐂Ả𝐍𝐇 𝐁Á𝐎 𝐒𝐏𝐀𝐌 𝐓𝐈𝐍 𝐍𝐇Ắ𝐍!
╔════════════════════════════╗
   🚫 𝐕𝐈 𝐏𝐇Ạ𝐌 𝐒𝐏𝐀𝐌 (3 𝐋Ầ𝐍) 🚫
╚════════════════════════════╝
⛔ Bạn đang spam tin nhắn liên tục trong nhóm (3 lần vi phạm).
🚨 𝐂Ả𝐍𝐇 𝐁Á𝐎: Nếu cố tình gửi thêm 1 tin nhắn spam nữa, bot sẽ KICK bạn khỏi nhóm ngay lập tức!`;

            await api.sendMessage(
              {
                msg: warnMsg,
                mentions: [
                  {
                    pos: 0,
                    len: warnTag.length,
                    uid: uidFrom
                  }
                ]
              },
              threadId,
              ThreadType.Group
            );
            return;
          }

          userMsgMemory.set(memKey, userMemory);
        }
      }

      // -------------------------------------------------------------
      // LỆNH 1: MINI GAME ĐO ĐỘ GAY KÈM ẢNH BẢNG KẾT QUẢ CHỨNG NHẬN
      // -------------------------------------------------------------
      const isGayCommand = lowerContent.includes('độ gay') || lowerContent.includes('/gay') || lowerContent.includes('gay');

      if (isGayCommand && mentions.length > 0) {
        if (isRateLimited(uidFrom)) return;

        const targetMention = mentions[0];
        const targetUid = String(targetMention.uid);

        let targetName = 'Bạn';
        if (targetMention.len > 1) {
          const rawName = rawContent.substring(targetMention.pos, targetMention.pos + targetMention.len).replace(/^@/, '').trim();
          if (rawName) targetName = rawName;
        }

        const percent = Math.floor(Math.random() * 101);
        const comment = getGayComment(percent);

        console.log(`🎨 Đang vẽ ảnh Giấy Chứng Nhận Độ Gay cho @${targetName} (${percent}%)...`);
        const meterImgBuf = createGayMeterImage(targetName, percent, comment);

        const captionText = 
`┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   🏳️‍🌈 𝐌Á𝐘 𝐐𝐔É𝐓 ĐỘ 𝐆𝐀𝐘 𝐕.𝐈.𝐏 🏳️‍🌈
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🎯 Mục tiêu: @${targetName}
📊 Chỉ số: ${percent}%
💬 Nhận xét: ${comment}`;

        const mentionPos = captionText.indexOf(`@${targetName}`);

        await api.sendMessage(
          {
            msg: captionText,
            attachments: [
              {
                data: meterImgBuf,
                filename: 'gay_certificate.png',
                metadata: {
                  totalSize: meterImgBuf.length,
                  width: 1000,
                  height: 560
                }
              }
            ],
            mentions: [
              {
                pos: mentionPos >= 0 ? mentionPos : 0,
                len: targetName.length + 1,
                uid: targetUid
              }
            ]
          },
          threadId,
          ThreadType.Group
        );

        console.log(`🎉 [MINI GAME GAY] Đã gửi ảnh đo độ gay cho @${targetName}!`);
        return;
      }

      // -------------------------------------------------------------
      // LỆNH 2: TẠO MÃ 2FA (/2fa <secret_key>)
      // -------------------------------------------------------------
      if (lowerContent.startsWith('/2fa') || lowerContent.startsWith('2fa ')) {
        if (isRateLimited(uidFrom)) return;

        const parts = trimmed.split(/\s+/);
        const secret = parts.slice(1).join('').replace(/[\s-]/g, '');

        if (!secret) {
          await api.sendMessage('⚠️ Vui lòng nhập Secret Key! Cú pháp: /2fa <MÃ_KEY_CỦA_BẠN>', threadId, ThreadType.Group);
          return;
        }

        const res2FA = get2FACode(secret);
        if (!res2FA) {
          await api.sendMessage('❌ Mã 2FA Secret Key không hợp lệ! Vui lòng kiểm tra lại.', threadId, ThreadType.Group);
          return;
        }

        const otpMsg = 
`┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   🔐 𝐌Ã 𝐗Á𝐂 𝐓𝐇Ự𝐂 𝟐𝐅𝐀 𝐎𝐓𝐏 🔐
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🔑 MÃ OTP:  ${res2FA.otp}
⏳ Còn lại:  ${res2FA.remaining}s (tự làm mới sau 30s)

💡 Nhấp copy trực tiếp mã số phía trên nhé anh em!`;

        await api.sendMessage(otpMsg, threadId, ThreadType.Group);
        console.log(`🔐 [2FA] Đã xuất mã OTP cho UID: ${uidFrom}`);
        return;
      }

      // -------------------------------------------------------------
      // LỆNH 3: CHECK TRẠNG THÁI TÀI KHOẢN TIKTOK HOẶC FACEBOOK (/check <link/uid/id>, /tik <link/id>)
      // -------------------------------------------------------------
      const isTikCommand = lowerContent.startsWith('/tik') || lowerContent.startsWith('tik ') || lowerContent.startsWith('/tiktok') || lowerContent.startsWith('tiktok ');
      const isCheckCommand = lowerContent.startsWith('/check') || lowerContent.startsWith('check ');

      if (isTikCommand || isCheckCommand) {
        if (isRateLimited(uidFrom)) return;

        const parts = trimmed.split(/\s+/);
        const target = parts[1];

        if (!target) {
          await api.sendMessage('⚠️ Vui lòng nhập link hoặc ID cần check!\n🔹 Check TikTok: /check <link_tiktok_hoặc_@username> (hoặc /tik <link>)\n🔹 Check Facebook: /check <UID_hoặc_link_FB>', threadId, ThreadType.Group);
          return;
        }

        // Tự động phân loại xem người dùng muốn check TikTok hay Facebook:
        const isTikTokTarget = isTikCommand || 
                               target.includes('tiktok.com') || 
                               target.startsWith('@') || 
                               target.includes('vt.tiktok.com') ||
                               target.includes('vm.tiktok.com');

        if (isTikTokTarget) {
          console.log(`🎵 [CHECK TIKTOK] Đang kiểm tra mục tiêu: ${target}...`);
          const tikStatus = await checkTikTokTarget(target);

          if (!tikStatus.success) {
            await api.sendMessage(`❌ ${tikStatus.reason}`, threadId, ThreadType.Group);
            return;
          }

          let checkMsg = '';
          if (tikStatus.live) {
            checkMsg = 
`┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   🎵 𝐊Ế𝐓 𝐐𝐔Ả 𝐂𝐇𝐄𝐂𝐊 𝐓𝐈𝐊𝐓𝐎𝐊 🎵
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛

👤 Nickname: ${tikStatus.nickname}
🎯 ID: @${tikStatus.username}
🟢 Trạng thái: LIVE (Đang hoạt động bình thường)
👥 Followers: ${tikStatus.followers} | Đang theo dõi: ${tikStatus.following}
❤️ Lượt thích: ${tikStatus.likes}
🔗 Profile: ${tikStatus.profileUrl}`;
          } else {
            checkMsg = 
`┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   🎵 𝐊Ế𝐓 𝐐𝐔Ả 𝐂𝐇𝐄𝐂𝐊 𝐓𝐈𝐊𝐓𝐎𝐊 🎵
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🎯 ID: @${tikStatus.username}
🔴 Trạng thái: DIE / KHÓA / KHÔNG TỒN TẠI
⚠️ Tình trạng: ${tikStatus.reason}
🔗 Profile: ${tikStatus.profileUrl}`;
          }

          await api.sendMessage(checkMsg, threadId, ThreadType.Group);
          return;
        }

        // Xử lý Check Facebook:
        console.log(`🔎 [CHECK FB] Đang check trạng thái mục tiêu: ${target}...`);
        const fbStatus = await checkFBTarget(target);

        if (!fbStatus.success) {
          await api.sendMessage(`❌ ${fbStatus.reason}`, threadId, ThreadType.Group);
          return;
        }

        let nameLine = fbStatus.name ? `👤 Tên: ${fbStatus.name}\n` : '';
        let checkMsg = '';

        if (fbStatus.live) {
          checkMsg = 
`┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   🔍 𝐊Ế𝐓 𝐐𝐔Ả 𝐂𝐇𝐄𝐂𝐊 𝐅𝐀𝐂𝐄𝐁𝐎𝐎𝐊 🔍
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛

${nameLine}🎯 UID: ${fbStatus.uid}
🟢 Trạng thái: LIVE (Đang hoạt động bình thường)
🔗 Profile: ${fbStatus.profileUrl}`;
        } else {
          checkMsg = 
`┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   🔍 𝐊Ế𝐓 𝐐𝐔Ả 𝐂𝐇𝐄𝐂𝐊 𝐅𝐀𝐂𝐄𝐁𝐎𝐎𝐊 🔍
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛

${nameLine}🎯 UID: ${fbStatus.uid}
🔴 Trạng thái: DIE / KHÓA / ĐỔI LINK (Không thể truy cập)
🔗 Profile: ${fbStatus.profileUrl}`;
        }

        await api.sendMessage(checkMsg, threadId, ThreadType.Group);
        return;
      }

      // -------------------------------------------------------------
      // LỆNH 4: TRA CỨU ĐỊA CHỈ IP / PROXY (/ip <địa_chỉ_ip>)
      // -------------------------------------------------------------
      if (lowerContent.startsWith('/ip') || lowerContent.startsWith('ip ')) {
        if (isRateLimited(uidFrom)) return;

        const parts = trimmed.split(/\s+/);
        const ipQuery = parts[1];

        if (!ipQuery) {
          await api.sendMessage('⚠️ Vui lòng nhập IP! Cú pháp: /ip <Địa_chỉ_IP>', threadId, ThreadType.Group);
          return;
        }

        const ipInfo = await lookupIP(ipQuery);
        if (!ipInfo || ipInfo.status !== 'success') {
          await api.sendMessage(`❌ Không thể tra cứu IP "${ipQuery}". Vui lòng kiểm tra lại!`, threadId, ThreadType.Group);
          return;
        }

        const ipMsg = 
`┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   🌐 𝐓𝐇Ô𝐍𝐆 𝐓𝐈𝐍 ĐỊ𝐀 𝐂𝐇Ỉ 𝐈𝐏 🌐
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛

📍 IP: ${ipInfo.query}
🌍 Quốc gia: ${ipInfo.country}
🏙️ Thành phố / Vùng: ${ipInfo.city || ipInfo.regionName}
🏢 Nhà mạng (ISP): ${ipInfo.isp}
🏢 Tổ chức: ${ipInfo.org || ipInfo.as}`;

        await api.sendMessage(ipMsg, threadId, ThreadType.Group);
        return;
      }

      // -------------------------------------------------------------
      // LỆNH 5: HỎI ĐÁP VỚI NÃO AI ("bot ơi <câu hỏi>" hoặc "/ai <câu hỏi>")
      // -------------------------------------------------------------
      const isAICall = lowerContent.startsWith('bot ơi') || 
                       lowerContent.startsWith('bot oi') || 
                       lowerContent.startsWith('/ai') ||
                       lowerContent.startsWith('ai ');

      if (isAICall) {
        if (isRateLimited(uidFrom)) {
          // Tránh spam
          return;
        }

        let question = trimmed
          .replace(/^bot\s+ơi/i, '')
          .replace(/^bot\s+oi/i, '')
          .replace(/^\/ai/i, '')
          .replace(/^ai/i, '')
          .trim();

        if (!question) {
          await api.sendMessage('Dạ em nghe nè anh em, hỏi gì cứ nhắn nha! ✨', threadId, ThreadType.Group);
          return;
        }

        console.log(`🧠 [AI QUESTION] Từ UID ${uidFrom}: "${question}"`);
        const aiAnswer = await askAI(question);

        const aiReply = 
`┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   🧠 𝐓𝐑𝐈𝐂𝐊𝐄𝐑 𝐀𝐈 𝐑𝐄𝐏𝐋𝐘 🧠
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛

${aiAnswer}`;

        await api.sendMessage(aiReply, threadId, ThreadType.Group);
        return;
      }

      // -------------------------------------------------------------
      // LỆNH 6: TRƯỞNG NHÓM / PHÓ NHÓM KICK THÀNH VIÊN (/kick @tag hoặc kick @tag)
      // -------------------------------------------------------------
      const isKickCommand = lowerContent.startsWith('/kick') || lowerContent.startsWith('kick ');
      if (isKickCommand) {
        if (isRateLimited(uidFrom)) return;

        // 1. Kiểm tra người gọi lệnh có phải Trưởng nhóm hoặc Phó nhóm không
        const hasPermission = await isGroupAdminOrCreator(api, threadId, uidFrom);
        if (!hasPermission) {
          await api.sendMessage('⛔ Chỉ Trưởng nhóm hoặc Phó nhóm mới có quyền sử dụng lệnh kick!', threadId, ThreadType.Group);
          return;
        }

        // 2. Kiểm tra tag người cần kick
        if (!mentions || mentions.length === 0) {
          await api.sendMessage('⚠️ Vui lòng @tag thành viên bạn muốn kick! Cú pháp: /kick @tên_thành_viên', threadId, ThreadType.Group);
          return;
        }

        const targetMention = mentions[0];
        const targetUid = String(targetMention.uid);

        let targetName = 'thành viên';
        if (targetMention.len > 1) {
          const rawName = rawContent.substring(targetMention.pos, targetMention.pos + targetMention.len).replace(/^@/, '').trim();
          if (rawName) targetName = rawName;
        }

        // Không cho phép tự kick chính mình
        if (targetUid === uidFrom) {
          await api.sendMessage('😅 Bạn là Quản trị viên, không thể tự kick chính mình được đâu nha!', threadId, ThreadType.Group);
          return;
        }

        // Kiểm tra xem người bị tag có phải là Quản trị viên / Trưởng nhóm không
        const targetIsAdmin = await isGroupAdminOrCreator(api, threadId, targetUid);
        if (targetIsAdmin) {
          await api.sendMessage('⚠️ Không thể kick Quản trị viên hoặc Trưởng/Phó nhóm!', threadId, ThreadType.Group);
          return;
        }

        // 3. Thực hiện kick thành viên
        try {
          console.log(`👢 [KICK MEMBER] Admin ${uidFrom} yêu cầu kick ${targetUid} (@${targetName}) khỏi nhóm ${threadId}`);
          await api.removeUserFromGroup(targetUid, threadId);

          const reason = 'Lệnh trục xuất theo yêu cầu Quản trị viên';
          const admin = 'Ban Quản Trị';
          const kickImgBuf = createKickBannerImage(targetName, reason, admin);
          const kickSuccessMsg = formatKickCard(targetName, reason, admin);
          const kickTag = `@${targetName}`;

          await api.sendMessage(
            {
              msg: kickSuccessMsg,
              attachments: [
                {
                  data: kickImgBuf,
                  filename: 'kick_notice.png',
                  metadata: {
                    totalSize: kickImgBuf.length,
                    width: 1000,
                    height: 560
                  }
                }
              ],
              mentions: [
                {
                  pos: 0,
                  len: kickTag.length,
                  uid: targetUid
                }
              ]
            },
            threadId,
            ThreadType.Group
          );
        } catch (kickErr) {
          console.error(`❌ Lỗi khi kick ${targetUid}:`, kickErr.message);
          let reasonMsg = kickErr.message;
          if (reasonMsg.includes('166') || reasonMsg.includes('permission')) {
            reasonMsg = 'Bot chưa được set quyền Phó nhóm hoặc người được tag có quyền hạn cao hơn!';
          }
          await api.sendMessage(`❌ Không thể kick @${targetName}!\nNguyên nhân: ${reasonMsg}`, threadId, ThreadType.Group);
        }
        return;
      }

      // -------------------------------------------------------------
      // LỆNH 7: MENU TRỢ GIÚP (/menu hoặc /help)
      // -------------------------------------------------------------
      if (lowerContent === '/menu' || lowerContent === '/help' || lowerContent === 'menu') {
        if (isRateLimited(uidFrom)) return;

        const menuMsg = 
`┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓
   ⚡ 𝐌𝐄𝐍𝐔 𝐓𝐈Ệ𝐍 Í𝐂𝐇 𝐁𝐎𝐓 ⚡
┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🛠️ 𝐂Ô𝐍𝐆 𝐂Ụ 𝐓𝐑𝐈𝐂𝐊𝐄𝐑:
🔹 /2fa <secret_key>   : Lấy mã OTP 2 bước siêu tốc
🔹 /check <link/uid>   : Check Live/Die TikTok & Facebook
🔹 /tik <link/user>    : Tra cứu tài khoản TikTok siêu tốc
🔹 /ip <địa_chỉ_ip>    : Tra cứu nguồn gốc mạng & quốc gia

🧠 𝐓𝐑Ợ 𝐋Ý 𝐀𝐈:
🔹 bot ơi <câu hỏi>    : Trò chuyện & giải đáp siêu tốc

🎮 𝐆𝐈Ả𝐈 𝐓𝐑Í:
🔹 độ gay @tag         : Quét độ gay xuất bằng chứng nhận VIP

🛡️ 𝐁Ả𝐎 𝐕Ệ & 𝐐𝐔Ả𝐍 𝐓𝐑Ị:
🔹 /kick @tag          : Trưởng/Phó nhóm kick thành viên
🔹 Gỡ link nhóm Zalo & cảnh cáo 3 lần KICK!
🔹 Chống spam tin: Nhắc 3 lần, lần 4 KICK!`;

        await api.sendMessage(menuMsg, threadId, ThreadType.Group);
        return;
      }

      // -------------------------------------------------------------
      // TỰ ĐỘNG PHÁT HIỆN & THU HỒI / XÓA TIN NHẮN CHỨA LINK NHÓM ZALO + CẢNH BÁO 3 LẦN KICK
      // -------------------------------------------------------------
      if (ZALO_GROUP_LINK_REGEX.test(rawContent)) {
        console.log(`🚨 [CẢNH BÁO SPAM LINK] Phát hiện link nhóm Zalo từ UID: ${uidFrom}`);

        let deleted = false;
        try {
          await api.undo(
            {
              msgId: msgId,
              cliMsgId: cliMsgId
            },
            threadId,
            ThreadType.Group
          );
          deleted = true;
          console.log('✅ Đã thu hồi (undo) tin nhắn spam thành công!');
        } catch (undoErr) {
          try {
            await api.deleteMessage({
              data: {
                cliMsgId: String(cliMsgId),
                msgId: String(msgId),
                uidFrom: String(uidFrom)
              },
              threadId: threadId,
              type: ThreadType.Group
            }, false);
            deleted = true;
            console.log('✅ Đã xoá tin nhắn spam bằng deleteMessage thành công!');
          } catch (delErr) {
            console.error('❌ Cần quyền Phó nhóm/Trưởng nhóm để xóa tin nhắn người khác:', delErr.message);
          }
        }

        // Quản lý hệ thống cảnh cáo 3 lần (Warn System)
        const warnKey = `${threadId}_${uidFrom}`;
        const warnData = spamWarnings.get(warnKey) || { count: 0, timestamp: Date.now() };

        // Nếu vi phạm cách đây hơn 24 giờ thì reset lại đếm
        if (Date.now() - warnData.timestamp > 24 * 60 * 60 * 1000) {
          warnData.count = 0;
        }

        warnData.count += 1;
        warnData.timestamp = Date.now();
        spamWarnings.set(warnKey, warnData);

        console.log(`⚠️ [SPAM WARN] UID ${uidFrom} bị cảnh cáo lần ${warnData.count}/3`);

        const memberName = await resolveMemberName(api, uidFrom, msgData.dName, threadId);
        const tagText = `@${memberName}`;

        if (warnData.count < 3) {
          const warningCard = 
`${tagText} ⚠️ 𝐂Ả𝐍𝐇 𝐁Á𝐎 𝐒𝐏𝐀𝐌 𝐋𝐈𝐍𝐊 𝐍𝐇Ó𝐌!
╔════════════════════════════╗
   🚫 𝐕𝐈 𝐏𝐇Ạ𝐌 𝐋𝐈𝐍𝐊 (${warnData.count}/3) 🚫
╚════════════════════════════╝
⚠️ Phát hiện bạn vừa gửi link mời nhóm Zalo khác vào đây!
⛔ Hệ thống đã tự động gỡ bỏ tin nhắn vi phạm.
⚠️ Cảnh cáo: Tái phạm đủ 3 lần sẽ bị bot KICK vĩnh viễn khỏi nhóm! (Còn ${3 - warnData.count} lần nhắc nhở)`;

          await api.sendMessage(
            {
              msg: warningCard,
              mentions: [
                {
                  pos: 0,
                  len: tagText.length,
                  uid: uidFrom
                }
              ]
            },
            threadId,
            ThreadType.Group
          );
        } else {
          // Vi phạm đủ 3 lần -> Tự động KICK
          try {
            console.log(`👢 [AUTO KICK] UID ${uidFrom} (@${memberName}) vi phạm 3/3 lần, đang tiến hành kick khỏi nhóm ${threadId}...`);
            await api.removeUserFromGroup(uidFrom, threadId);
            spamWarnings.delete(warnKey); // Xóa dữ liệu sau khi kick thành công

            const reason = 'Cố tình gửi link nhóm Zalo khác quá 3 lần cảnh cáo';
            const admin = 'Tricker Security Bot';
            const kickImgBuf = createKickBannerImage(memberName, reason, admin);
            const kickNotice = formatKickCard(memberName, reason, admin);

            await api.sendMessage(
              {
                msg: kickNotice,
                attachments: [
                  {
                    data: kickImgBuf,
                    filename: 'kick_notice.png',
                    metadata: {
                      totalSize: kickImgBuf.length,
                      width: 1000,
                      height: 560
                    }
                  }
                ],
                mentions: [
                  {
                    pos: 0,
                    len: tagText.length,
                    uid: uidFrom
                  }
                ]
              },
              threadId,
              ThreadType.Group
            );
          } catch (kickErr) {
            console.error('❌ Lỗi khi tự động kick thành viên vi phạm 3 lần:', kickErr.message);
            const failNotice = 
`${tagText} 🚫 𝐕𝐈 𝐏𝐇Ạ𝐌 𝐊Ị𝐂𝐇 𝐊𝐇𝐔𝐍𝐆!
╔════════════════════════════╗
   🚫 𝐕𝐈 𝐏𝐇Ạ𝐌 𝐊Ị𝐂𝐇 𝐊𝐇𝐔𝐍𝐆 (3/3) 🚫
╚════════════════════════════╝
⚠️ Thành viên đã vi phạm đủ 3 lần quy định spam link!
❌ Bot chưa thể kick tự động do chưa có quyền Phó nhóm. Quản trị viên vui lòng set quyền cho bot hoặc xử lý thủ công!`;

            await api.sendMessage(
              {
                msg: failNotice,
                mentions: [
                  {
                    pos: 0,
                    len: tagText.length,
                    uid: uidFrom
                  }
                ]
              },
              threadId,
              ThreadType.Group
            );
          }
        }
      }
    } catch (err) {
      console.error('❌ Lỗi khi xử lý message:', err.message);
    }
  });

  listener.on('closed', (code, reason) => {
    console.warn(`⚠️ Listener đóng kết nối [${code}]: ${reason}. Đang tự động kết nối lại sau 3s...`);
    setTimeout(() => {
      try {
        listener.start({
          retryOnClose: true,
          continuousReconnect: true,
          heartbeatTimeoutMs: 0,
          maxReconnectAttempts: 100
        });
      } catch (err) {}
    }, 3000);
  });

  listener.on('error', (err) => {
    console.error('❌ Listener gặp lỗi:', err);
  });

  listener.start({
    retryOnClose: true,
    continuousReconnect: true,
    heartbeatTimeoutMs: 0,
    maxReconnectAttempts: 100
  });

  console.log('🚀 Đang lắng nghe tin nhắn và sự kiện của các nhóm Zalo 24/7...');
}

startBot().catch((err) => {
  console.error('💥 Lỗi khởi động bot Zalo:', err);
});
