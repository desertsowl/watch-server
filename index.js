const express = require('express');
const app = express();
const PORT = 5000;
const net = require('net');
const fs = require('fs');
const path = require('path');

// 静的ファイルの提供を有効化
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ログディレクトリが存在しない場合は作成
const logDir = path.join(__dirname, 'log');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// ------------------------------------------------
//    機器からログを収集
// ------------------------------------------------
function logger() {
  const client = new net.Socket();
  let buffer = '';
  const logStream = fs.createWriteStream(path.join(logDir, 'ap.log'), { flags: 'w' });
  let currentState = 'login'; // 状態管理を追加
  const commands = [
    'show aps',
    'show amp-audit | include (ssid-profile|max-clients-threshold)',
    'show clients'
  ];
  let currentCommand = 0;

  client.connect(23, '172.21.7.220', () => {
    console.log('telnetサーバーに接続しました');
    logStream.write('telnetサーバーに接続しました\n');
  });

  client.on('data', (data) => {
    buffer += data.toString();
    logStream.write(data.toString());

    switch (currentState) {
      case 'login':
        if (buffer.includes('User:')) {
          client.write('admin\r\n');
          buffer = '';
        } else if (buffer.includes('Password:')) {
          client.write('k1kuk@w@\r\n');
          buffer = '';
        } else if (buffer.match(/ap_\d+#/)) {
          currentState = 'commands';
          buffer = '';
          // 最初のコマンドを実行
          client.write(commands[currentCommand] + '\r\n');
          logStream.write(`\n=== 実行コマンド: ${commands[currentCommand]} ===\n`);
        }
        break;

      case 'commands':
        // プロンプトが表示されたら次のコマンドを実行
        if (buffer.match(/ap_\d+#/)) {
          currentCommand++;
          buffer = '';
          
          if (currentCommand < commands.length) {
            // 次のコマンドを実行
            client.write(commands[currentCommand] + '\r\n');
            logStream.write(`\n=== 実行コマンド: ${commands[currentCommand]} ===\n`);
          } else {
            // 全コマンド完了後にログアウト
            client.write('exit\r\n');
            client.end();
          }
        }
        break;
    }
  });

  client.on('close', () => {
    console.log('接続が閉じられました');
    logStream.write('接続が閉じられました\n');
    logStream.end();
    // 接続が閉じられた後にクライアントカウントを計算
    extractor();
  });

  client.on('error', (err) => {
    console.error('エラーが発生しました:', err);
    logStream.write(`エラーが発生しました: ${err}\n`);
    logStream.end();
  });
}

// ------------------------------------------------
//    ログからデータを抽出
// ------------------------------------------------
function extractor() {
  const logFilePath = path.join(logDir, 'ap.log');
  const fs = require('fs');

  // APの状態情報を抽出する関数
  function extractApStatus(lines) {
    const apInfo = {};
    let inShowAps = false;
    let lineCount = 0;

    for (const line of lines) {
      if (line.includes('show aps')) {
        inShowAps = true;
        lineCount = 0;
        continue;
      }

      if (inShowAps) {
        lineCount++;
        if (lineCount > 7 && line.match(/^ap_\d{2}\s/)) {
          const fields = line.trim().split(/\s+/);
          if (fields.length >= 12) {
            apInfo[fields[0]] = {
              ch: fields[10],
              dbm: fields[11]
            };
          }
        }
        if (line.match(/ap_\d+#/)) {
          inShowAps = false;
        }
      }
    }
    return apInfo;
  }

  // クライアント接続情報を抽出する関数
  function extractClientInfo(lines) {
    const clientCounts = {};
    let inClientList = false;
    let lineCount = 0;

    for (const line of lines) {
      if (line.startsWith('Client List')) {
        inClientList = true;
        lineCount = 0;
        continue;
      }

      if (inClientList) {
        lineCount++;
        if (line.trim() === '') {
          inClientList = false;
          continue;
        }
        if (lineCount < 4) continue;

        const fields = line.split(/\s{2,}/);
        if (fields.length >= 7) {
          const essid = fields[4].trim();
          const accessPoint = fields[5].trim();

          if (!accessPoint.startsWith('ap_')) continue;

          if (!clientCounts[accessPoint]) {
            clientCounts[accessPoint] = {};
          }
          if (!clientCounts[accessPoint][essid]) {
            clientCounts[accessPoint][essid] = 0;
          }
          clientCounts[accessPoint][essid]++;
        }
      }
    }
    return clientCounts;
  }

  // SSID最大接続数を抽出する関数
  function extractMaxClients(lines) {
    const maxClients = {};
    let inAmpAudit = false;
    let currentEssid = '';

    for (const line of lines) {
      if (line.includes('show amp-audit')) {
        inAmpAudit = true;
        continue;
      }

      if (inAmpAudit) {
        if (line.startsWith('wlan ssid-profile')) {
          currentEssid = line.split(' ').pop().trim();
        } else if (line.startsWith(' max-clients-threshold')) {
          const maxValue = parseInt(line.trim().split(' ')[1], 10);
          if (currentEssid) {
            maxClients[currentEssid] = maxValue;
          }
        }
        if (line.trim() === '') {
          inAmpAudit = false;
          currentEssid = '';
        }
      }
    }
    return maxClients;
  }

  // メイン処理
  fs.readFile(logFilePath, 'utf8', (err, data) => {
    if (err) {
      console.error('ログファイルの読み込み中にエラーが発生しました:', err);
      return;
    }

    const lines = data.split('\n');
    const apInfo = extractApStatus(lines);
    const clientCounts = extractClientInfo(lines);
    const maxClients = extractMaxClients(lines);

    // 結果出力
    console.log('\n=== アクセスポイントの状態 ===');
    for (const ap_name in apInfo) {
      console.log(`${ap_name} ${apInfo[ap_name].ch} / ${apInfo[ap_name].dbm}`);
    }

    console.log('\n=== クライアント接続状況 ===');
    for (const accessPoint in clientCounts) {
      console.log(`${accessPoint}`);
      for (const essid in clientCounts[accessPoint]) {
        const currentCount = clientCounts[accessPoint][essid];
        const maxCount = maxClients[essid] || 0;
        const percentage = maxCount > 0 ? Math.floor((currentCount / maxCount) * 100) : 0;
        console.log(`  ${essid}:${currentCount}/${maxCount}台 (${percentage}%)`);
      }
    }
  });
}

// ================================================
//  メインルーチン
// ================================================

// 機器からログを収集
logger();

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT} で待機中`);
});

