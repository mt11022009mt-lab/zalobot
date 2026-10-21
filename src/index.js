const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');

// Circular log buffer to inspect live logs via /logs endpoint
const MAX_LOGS = 150;
const recentLogs = [];

function captureLog(type, ...args) {
  const time = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const msg = args.map(arg => {
    if (typeof arg === 'object' && arg !== null) {
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }
    return String(arg);
  }).join(' ');

  recentLogs.push(`[${time}] [${type.toUpperCase()}] ${msg}`);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
}

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => { originalLog(...args); captureLog('info', ...args); };
console.error = (...args) => { originalError(...args); captureLog('error', ...args); };
console.warn = (...args) => { originalWarn(...args); captureLog('warn', ...args); };

// 0. Nạp cấu hình tự động đăng nhập (FB_EMAIL, FB_PASSWORD, FB_2FA) vào fca-config.json
// TRƯỚC KHI require('@dongdev/fca-unofficial') để thư viện đọc được thông tin credentials khi khởi tạo
const fbEmail = process.env.FB_EMAIL || '';
const fbPassword = process.env.FB_PASSWORD || '';
const fb2FA = (process.env.FB_2FA || '').replace(/\s+/g, '').toUpperCase();

if (fbEmail && fbPassword) {
  try {
    const cfgPath = path.resolve(process.cwd(), 'fca-config.json');
    let cfg = {};
    if (fs.existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      } catch {}
    }
    cfg.autoLogin = true;
    cfg.credentials = {
      email: fbEmail,
      password: fbPassword,
      twofactor: fb2FA || ''
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    console.log('[AutoLogin] Đã nạp cấu hình credentials vào fca-config.json trước khi tải thư viện FCA.');
  } catch (err) {
    console.error('[AutoLogin] Lỗi lưu fca-config.json:', err.message);
  }
}

// Giờ mới load @dongdev/fca-unofficial để nó đọc fca-config.json đã có credentials
const { loginAsync } = require('@dongdev/fca-unofficial');
const { Store } = require('./store');
const { createBot } = require('./bot');

const statePath = path.resolve(process.env.APPSTATE_PATH || 'appstate.json');
const dataPath = path.resolve(process.env.DATA_PATH || 'data/activity.json');
const store = new Store(dataPath);

// Lưu dữ liệu an toàn trước khi tiến trình tắt (tránh mất bộ nhớ khi Render restart container)
function gracefulShutdown(signal) {
  console.log(`[Shutdown] Nhận tín hiệu ${signal}. Đang lưu dữ liệu bộ nhớ an toàn...`);
  try {
    store.save();
    console.log('[Shutdown] Lưu dữ liệu bộ nhớ thành công.');
  } catch (err) {
    console.error('[Shutdown] Lỗi khi lưu dữ liệu:', err.message);
  }
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
  process.exit(0);
});

process.on('beforeExit', () => {
  gracefulShutdown('beforeExit');
});

const health = {
  state: 'starting',
  updatedAt: new Date().toISOString(),
  lastEventAt: null,
  errorDetail: null,
  uid: null
};

function setHealth(state, errorDetail = null) {
  health.state = state;
  health.updatedAt = new Date().toISOString();
  if (errorDetail) health.errorDetail = errorDetail;
}

// 1. HTTP server serving healthcheck & debug log viewer
if (process.env.PORT) {
  const port = parseInt(process.env.PORT, 10) || 8080;
  const server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/logs') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      const header = `=== NHẬT KÝ HOẠT ĐỘNG BOT MESSENGER (${health.state.toUpperCase()}) ===\nUptime: ${Math.round(process.uptime())}s | UID: ${health.uid || 'chưa có'}\n\n`;
      return res.end(header + recentLogs.join('\n'));
    }

    if (url === '/backup' || url === '/data') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(store.data, null, 2));
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: health.state === 'auth_error' ? 'auth_required' : 'ok',
      state: health.state,
      errorDetail: health.errorDetail,
      uid: health.uid,
      uptimeSec: Math.round(process.uptime()),
      lastEventAt: health.lastEventAt,
      messengerConnected: health.state === 'connected',
      viewLogsUrl: '/logs'
    }, null, 2));
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[HealthCheck] Web server đang lắng nghe cổng ${port}`);
  });

  // Anti-sleep self ping for Render Free Tier (runs every 8 minutes)
  const serviceUrl = process.env.RENDER_EXTERNAL_URL || 'https://zalobot-65zd.onrender.com';
  if (serviceUrl) {
    const keepAliveTimer = setInterval(() => {
      https.get(`${serviceUrl}/health`, (res) => {
        res.resume();
      }).on('error', () => {});
    }, 8 * 60 * 1000);
    keepAliveTimer.unref?.();
  }
}

let appState = null;

if (process.env.APPSTATE_JSON) {
  try {
    appState = JSON.parse(process.env.APPSTATE_JSON);
  } catch (error) {
    console.error('Không đọc được APPSTATE_JSON từ biến môi trường:', error.message);
  }
} else if (process.env.APPSTATE_BASE64) {
  try {
    const raw = Buffer.from(process.env.APPSTATE_BASE64, 'base64').toString('utf8');
    appState = JSON.parse(raw);
  } catch (error) {
    console.error('Không đọc được APPSTATE_BASE64 từ biến môi trường:', error.message);
  }
}

if (!appState) {
  if (fs.existsSync(statePath)) {
    try {
      appState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
      console.error('Không đọc được AppState từ file:', error.message);
    }
  }
}

if (appState && !Array.isArray(appState)) {
  console.warn('AppState không phải là mảng cookie JSON hợp lệ. Sẽ bỏ qua.');
  appState = null;
}

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]:', reason);
});

let currentApi = null;
let reconnectTimer = null;

function startBot() {
  const credentials = {};
  if (Array.isArray(appState)) credentials.appState = appState;
  if (fbEmail) credentials.email = fbEmail;
  if (fbPassword) credentials.password = fbPassword;
  if (fb2FA) credentials.twofactor = fb2FA;

  if (!credentials.appState && (!credentials.email || !credentials.password)) {
    console.error('Chưa có thông tin đăng nhập: thiếu appstate.json hoặc FB_EMAIL/FB_PASSWORD.');
    setHealth('no_credentials', 'Thiếu appstate hoặc FB_EMAIL/FB_PASSWORD trong Environment Variables');
    return;
  }

  setHealth('logging_in');
  console.log('Đang đăng nhập vào Facebook Messenger...');

  if (global.fca && global.fca.config) {
    global.fca.config.autoLogin = true;
    global.fca.config.credentials = { email: fbEmail, password: fbPassword, twofactor: fb2FA };
  }

  loginAsync(credentials, {
    listenEvents: true,
    selfListen: false,
    autoReconnect: true,
    emitReady: true
  }).then(ctx => {
    const api = ctx.api;
    currentApi = api;
    const myUid = api.getCurrentUserID?.();
    health.uid = myUid;

    api.setOptions({ listenEvents: true, selfListen: false, autoReconnect: true, emitReady: true });
    const bot = createBot(api, store);

    setHealth('connected');
    console.log(`Bot đã kết nối Messenger thành công! UID: ${myUid}`);

    api.listenMqtt((listenError, event) => {
      if (listenError) {
        if (listenError.type === 'ready') {
          setHealth('connected');
          return;
        }

        const errMsg = String(listenError.error || listenError.message || JSON.stringify(listenError));
        console.error('Sự kiện cảnh báo Messenger MQTT:', errMsg);

        if (/blocked the login|not_logged_in|1357001|login_blocked/i.test(errMsg)) {
          if (fbEmail && fbPassword) {
            console.log('[AutoLogin] Phiên cookie cũ bị chặn, đang tự động đăng nhập lại bằng 2FA sau 10 giây...');
            setHealth('reauthenticating', 'Phiên cũ hết hạn, đang tự động đăng nhập lại bằng 2FA...');
            appState = null;
            scheduleRetry(10000);
            return;
          }
          setHealth('auth_error', 'Facebook đã đăng xuất phiên đăng nhập này (Mã lỗi 1357001 / login_blocked). Cần lấy cookie mới.');
          return;
        }

        if (listenError.type === 'stop_listen') {
          setHealth('disconnected', 'Mất kết nối MQTT');
          scheduleRetry();
        }
        return;
      }

      if (!event) return;

      health.lastEventAt = new Date().toISOString();
      setHealth('connected');
      // Xử lý song song không chờ hàng đợi để đạt tốc độ phản hồi tức thì
      bot.handle(event).catch(err => console.error('Lỗi xử lý sự kiện:', err));
    });

    const runBirthdays = () => {
      bot.checkBirthdays().catch(err => console.error('Lỗi chúc mừng sinh nhật:', err));
    };
    runBirthdays();
    const birthdayTimer = setInterval(runBirthdays, 5 * 60 * 1000);
    birthdayTimer.unref?.();

    // Heartbeat Keep-Alive: Giữ ấm phiên cookie Facebook mỗi 3 phút tránh bị thu hồi phiên
    const heartbeatTimer = setInterval(() => {
      if (currentApi && health.state === 'connected') {
        const uid = currentApi.getCurrentUserID?.();
        if (uid) {
          currentApi.getUserInfo(uid, (err) => {
            if (err) {
              console.warn('[Heartbeat] Cảnh báo làm mới phiên:', err.message || err);
            } else {
              const freshState = currentApi.getAppState?.();
              if (Array.isArray(freshState) && freshState.length > 0) {
                appState = freshState;
              }
            }
          });
        }
      }
    }, 3 * 60 * 1000);
    heartbeatTimer.unref?.();

    console.log('Bot đang theo dõi các nhóm Messenger của tài khoản này.');
  }).catch(error => {
    const msg = String(error?.message || error?.error || error);
    console.error('Đăng nhập Messenger thất bại:', msg);

    if (/blocked the login|not_logged_in|1357001|login_blocked|auto-login|HTML does not show valid USER_ID/i.test(msg) || (fbEmail && fbPassword && appState)) {
      if (fbEmail && fbPassword && appState) {
        console.log('[AutoLogin] Session cookie cũ lỗi, chuyển sang tự động đăng nhập bằng email + mật khẩu + 2FA...');
        appState = null;
        scheduleRetry(5000);
        return;
      }
      setHealth('auth_error', 'Facebook chặn đăng nhập hoặc bắt đăng nhập lại (error 1357001). Cần kiểm tra lại tài khoản.');
    } else {
      setHealth('login_failed', msg);
      scheduleRetry();
    }
  });
}

function scheduleRetry(delayMs = 30000) {
  if (reconnectTimer) return;
  console.log(`Sẽ thử kết nối lại sau ${Math.round(delayMs / 1000)} giây...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, delayMs);
}

startBot();
