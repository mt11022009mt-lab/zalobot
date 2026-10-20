const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { loginAsync } = require('@dongdev/fca-unofficial');
const { Store } = require('./store');
const { createBot } = require('./bot');

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

const statePath = path.resolve(process.env.APPSTATE_PATH || 'appstate.json');
const dataPath = path.resolve(process.env.DATA_PATH || 'data/activity.json');

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
  if (!fs.existsSync(statePath)) {
    console.error(`Chưa có phiên đăng nhập: ${statePath} hoặc biến môi trường APPSTATE_JSON.`);
    setHealth('no_cookie', 'Chưa có file appstate.json hoặc biến môi trường APPSTATE_JSON');
  } else {
    try {
      appState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
      console.error('Không đọc được AppState từ file:', error.message);
      setHealth('cookie_corrupted', error.message);
    }
  }
}

if (appState && !Array.isArray(appState)) {
  console.error('AppState phải là mảng cookie JSON hợp lệ.');
  setHealth('cookie_invalid_format', 'AppState không phải dạng mảng');
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
  if (!Array.isArray(appState)) return;

  setHealth('logging_in');
  console.log('Đang đăng nhập vào Facebook Messenger...');

  loginAsync({ appState }, {
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
    const bot = createBot(api, new Store(dataPath));
    let queue = Promise.resolve();

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
      queue = queue.then(() => bot.handle(event)).catch(err => console.error('Lỗi xử lý sự kiện:', err));
    });

    const runBirthdays = () => {
      queue = queue.then(() => bot.checkBirthdays()).catch(err => console.error('Lỗi chúc mừng sinh nhật:', err));
    };
    runBirthdays();
    const birthdayTimer = setInterval(runBirthdays, 5 * 60 * 1000);
    birthdayTimer.unref?.();

    console.log('Bot đang theo dõi các nhóm Messenger của tài khoản này.');
  }).catch(error => {
    const msg = String(error?.message || error?.error || error);
    console.error('Đăng nhập Messenger thất bại:', msg);

    if (/blocked the login|not_logged_in|1357001|login_blocked/i.test(msg)) {
      setHealth('auth_error', 'Facebook chặn đăng nhập hoặc bắt đăng nhập lại (error 1357001). Cần cập nhật cookie mới.');
    } else {
      setHealth('login_failed', msg);
      scheduleRetry();
    }
  });
}

function scheduleRetry() {
  if (reconnectTimer) return;
  console.log('Sẽ thử kết nối lại sau 30 giây...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, 30000);
}

startBot();
