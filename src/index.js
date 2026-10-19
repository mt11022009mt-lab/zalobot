const fs = require('node:fs');
const path = require('node:path');
const { loginAsync } = require('@dongdev/fca-unofficial');
const { Store } = require('./store');
const { createBot } = require('./bot');

const http = require('node:http');
const health = { state: 'starting', updatedAt: new Date().toISOString() };
const MQTT_DISCONNECTED_LIMIT_MS = 3 * 60 * 1000;

function setHealth(state) {
  health.state = state;
  health.updatedAt = new Date().toISOString();
}

if (process.env.PORT) {
  const port = parseInt(process.env.PORT, 10) || 8080;
  const server = http.createServer((req, res) => {
    const ready = health.state === 'connected';
    const status = req.url === '/health' ? 200 : (ready ? 200 : 503);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ...health, messengerConnected: ready }));
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[HealthCheck] Web server đang lắng nghe cổng ${port}`);
  });
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
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]:', reason);
  setHealth('error');
});

function startBot() {
  setHealth('logging_in');
  loginAsync({ appState }, { listenEvents: true, selfListen: false, autoReconnect: true, emitReady: true }).then(ctx => {
    const api = ctx.api;
    setHealth('connecting');
    api.setOptions({ listenEvents: true, selfListen: false, autoReconnect: true, emitReady: true });
    const bot = createBot(api, new Store(dataPath));
    let queue = Promise.resolve();
    let disconnectedSince = Date.now();
    api.listenMqtt((listenError, event) => {
      // Some versions of the unofficial library deliver its ready signal as
      // the first callback argument; accept either position.
      if (listenError?.type === 'ready' || event?.type === 'ready') {
        disconnectedSince = null;
        setHealth('connected');
        return;
      }
      if (listenError) {
        disconnectedSince ??= Date.now();
        setHealth('disconnected');
        console.error('Lỗi kết nối Messenger MQTT:', listenError);
        return;
      }
      if (!event) return;
      disconnectedSince = null;
      setHealth('connected');
      queue = queue.then(() => bot.handle(event)).catch(err => console.error('Lỗi xử lý sự kiện:', err));
    });
    const runBirthdays = () => {
      queue = queue.then(() => bot.checkBirthdays()).catch(err => console.error('Lỗi chúc mừng sinh nhật:', err));
    };
    runBirthdays();
    const birthdayTimer = setInterval(runBirthdays, 5 * 60 * 1000);
    birthdayTimer.unref?.();
    const connectionTimer = setInterval(() => {
      if (health.state === 'stopped') return;
      if (health.state === 'connected' && !ctx.mqttClient?.connected) {
        disconnectedSince = Date.now();
        setHealth('disconnected');
      }
      if (health.state === 'connected') return;
      disconnectedSince ??= Date.now();
      if (Date.now() - disconnectedSince < MQTT_DISCONNECTED_LIMIT_MS) return;
      setHealth('stopped');
      clearInterval(connectionTimer);
      console.error('MQTT không đồng bộ trong 3 phút; dừng thử nối lại để bảo vệ phiên đăng nhập.');
      try { api.stopListening?.(); } catch (error) { console.error('Không dừng được MQTT:', error); }
    }, 5000);
    connectionTimer.unref?.();
    console.log('Bot đang theo dõi các nhóm Messenger của tài khoản này.');
  }).catch(error => {
    setHealth('login_failed');
    console.error('Đăng nhập Messenger thất bại. Đã dừng thử lại để tránh đăng nhập liên tục:', error);
  });
}

startBot();
