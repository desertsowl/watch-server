const net = require('net');
const fs = require('fs');
const path = require('path');

// ログディレクトリが存在しない場合は作成
const logDir = path.join(__dirname, 'log');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

const logStream = fs.createWriteStream(path.join(logDir, 'ap.log'), { flags: 'a' });

const config = {
  host: '172.21.7.220',
  port: 23, // telnetのデフォルトポート
  username: 'admin',
  password: 'k1kuk@w@'
};

function writeLog(message) {
  const timestamp = new Date().toISOString();
  logStream.write(`${timestamp} ${message}\n`);
}

const client = new net.Socket();

client.connect(config.port, config.host, () => {
  writeLog('サーバーに接続しました');
});

let dataBuffer = '';
let isLoggedIn = false;
let waitingForPassword = false;

client.on('data', (data) => {
  dataBuffer += data.toString();
  writeLog(`受信: ${data}`);

  if (dataBuffer.includes('User:') && !waitingForPassword) {
    client.write(`${config.username}\n`);
    writeLog(`ユーザー名を送信: ${config.username}`);
    waitingForPassword = true;
    dataBuffer = '';
  }
  else if (dataBuffer.includes('Password:') && waitingForPassword) {
    client.write(`${config.password}\n`);
    writeLog('パスワードを送信');
    waitingForPassword = false;
    isLoggedIn = true;
    dataBuffer = '';
  }
  else if (dataBuffer.match(/work_\d+#/) && isLoggedIn) {
    client.write('exit\n');
    writeLog('ログアウトコマンドを送信');
    client.end();
  }
});

client.on('close', () => {
  writeLog('接続が終了しました');
  logStream.end();
});

client.on('error', (err) => {
  writeLog(`エラーが発生しました: ${err.message}`);
  logStream.end();
}); 