const fs = require('node:fs');
const path = require('node:path');
const login = require('@dongdev/fca-unofficial');
const { Store } = require('./store');
const { createBot } = require('./bot');

const http = require('node:http');

if (process.env.PORT) {
  const port = parseInt(process.env.PORT, 10) || 8080;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Messenger Group Bot is LIVE & running!\n');
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

login({ appState }, { listenEvents: true, selfListen: false }, (error, api) => {
  if (error) {
    console.error('Đăng nhập Messenger thất bại:', error);
    process.exitCode = 1;
    return;
  }
  api.setOptions({ listenEvents: true, selfListen: false });
  const bot = createBot(api, new Store(dataPath));
  let queue = Promise.resolve();
  api.listenMqtt((listenError, event) => {
    if (listenError) {
      console.error('Lỗi kết nối Messenger:', listenError);
      return;
    }
    queue = queue.then(() => bot.handle(event)).catch(err => console.error('Lỗi xử lý sự kiện:', err));
  });
  const runBirthdays = () => {
    queue = queue.then(() => bot.checkBirthdays()).catch(err => console.error('Lỗi chúc mừng sinh nhật:', err));
  };
  runBirthdays();
  const birthdayTimer = setInterval(runBirthdays, 5 * 60 * 1000);
  birthdayTimer.unref?.();
  console.log('Bot đang theo dõi các nhóm Messenger của tài khoản này.');
});
