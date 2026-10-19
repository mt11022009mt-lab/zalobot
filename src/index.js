const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { loginAsync } = require('@dongdev/fca-unofficial');
const { Store } = require('./store');
const { createBot } = require('./bot');

const health = { state: 'starting', updatedAt: new Date().toISOString() };

function setHealth(state) {
  health.state = state;
  health.updatedAt = new Date().toISOString();
}

// 1. Lightweight HTTP server to satisfy Render health checks & keep instance alive
if (process.env.PORT) {
  const port = parseInt(process.env.PORT, 10) || 8080;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'ok',
      state: health.state,
      updatedAt: health.updatedAt,
      uptimeSec: Math.round(process.uptime()),
      messengerConnected: health.state === 'connected'
    }));
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
    console.error(`Chưa có phiên đăng nhập: ${statePath} hoặc biến môi trường APPSTATE_JSON. Xem README.md.`);
    process.exit(1);
  }
  try {
    appState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    console.error('Không đọc được AppState từ file:', error.message);
    process.exit(1);
  }
}

if (!Array.isArray(appState)) {
  console.error('AppState phải là mảng cookie JSON hợp lệ.');
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]:', reason);
});

function startBot() {
  setHealth('logging_in');
  loginAsync({ appState }, { listenEvents: true, selfListen: false, autoReconnect: true, emitReady: true }).then(ctx => {
    const api = ctx.api;
    api.setOptions({ listenEvents: true, selfListen: false, autoReconnect: true, emitReady: true });
    const bot = createBot(api, new Store(dataPath));
    let queue = Promise.resolve();

    setHealth('connected');
    console.log('Bot đã kết nối Messenger thành công và đang lắng nghe sự kiện...');

    api.listenMqtt((listenError, event) => {
      if (listenError) {
        if (listenError.type === 'ready') {
          setHealth('connected');
          return;
        }
        console.error('Sự kiện cảnh báo Messenger MQTT:', listenError);
        return;
      }
      if (!event) return;
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
    setHealth('login_failed');
    console.error('Đăng nhập Messenger thất bại:', error);
  });
}

startBot();
