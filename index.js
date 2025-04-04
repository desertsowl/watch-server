const express = require('express');
const app = express();
const PORT = 5000;
const net = require('net');
const fs = require('fs');
const path = require('path');

// EJSテンプレートエンジンの設定
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 静的ファイルの提供を有効化
app.use(express.static('public'));

// グローバル変数としてAPデータを保持
let apData = {
  mtime: Math.floor(Date.now() / 1000),
  aps: []
};

// ログエントリを追加する関数
function addLogEntry(message, type = 'info') {
  console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${message}`);
}

app.get('/', (req, res) => {
  res.render('index', apData);
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

  addLogEntry('telnetサーバーに接続を試みています...');

  client.connect(23, '172.21.7.220', () => {
    console.log('telnetサーバーに接続しました');
    logStream.write('telnetサーバーに接続しました\n');
    addLogEntry('telnetサーバーに接続しました');
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
          addLogEntry(`コマンド実行: ${commands[currentCommand]}`);
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
            addLogEntry(`コマンド実行: ${commands[currentCommand]}`);
          } else {
            // 全コマンド完了後にログアウト
            client.write('exit\r\n');
            client.end();
            addLogEntry('全コマンド実行完了、ログアウトします');
          }
        }
        break;
    }
  });

  client.on('close', () => {
    console.log('接続が閉じられました');
    logStream.write('接続が閉じられました\n');
    logStream.end();
    addLogEntry('telnet接続が閉じられました');

    extractor();  // ログからデータを抽出
  });

  client.on('error', (err) => {
    console.error('エラーが発生しました:', err);
    logStream.write(`エラーが発生しました: ${err}\n`);
    logStream.end();
    addLogEntry(`エラーが発生しました: ${err}`, 'error');
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
        if (lineCount > 5 && line.match(/^ap_\d{2}\s/)) {
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

    console.log('\n=== Client List データ抽出開始 ===');
    console.log('全行数:', lines.length);

    for (const line of lines) {
      if (line.startsWith('Client List')) {
        inClientList = true;
        lineCount = 0;
        console.log('\nClient Listセクション開始');
        continue;
      }

      if (inClientList) {
        lineCount++;
        if (line.trim() === '') {
          inClientList = false;
          console.log('Client Listセクション終了');
          continue;
        }
        if (lineCount < 4) continue;

        // デバッグ用：各行の内容を出力
        console.log(`\n処理中の行 (${lineCount}行目):`, line);

        const fields = line.split(/\s{2,}/);
        console.log('分割後のフィールド:', fields);

        if (fields.length >= 7) {
          const essid = fields[4].trim();
          const accessPoint = fields[5].trim();

          console.log('抽出データ:', { essid, accessPoint });

          if (!accessPoint.startsWith('ap_')) {
            console.log('ap_で始まらないためスキップ');
            continue;
          }

          if (!clientCounts[accessPoint]) {
            clientCounts[accessPoint] = {};
            console.log(`新しいAPを追加: ${accessPoint}`);
          }
          if (!clientCounts[accessPoint][essid]) {
            clientCounts[accessPoint][essid] = 0;
            console.log(`新しいSSIDを追加: ${essid} (AP: ${accessPoint})`);
          }
          clientCounts[accessPoint][essid]++;
          console.log(`カウント更新: ${accessPoint} - ${essid} = ${clientCounts[accessPoint][essid]}`);
        } else {
          console.log('フィールド数が不足しているためスキップ');
        }
      }
    }

    console.log('\n=== 最終的なclientCounts ===');
    console.log(JSON.stringify(clientCounts, null, 2));
    
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

    updateApData(apInfo, clientCounts, maxClients);
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

// メイン処理
function updateApData(apStatusInfo, clientCounts, maxClients) {
  // APデータの更新
  apData.mtime = Math.floor(Date.now() / 1000);
  apData.aps = [];

  // デバッグ用：clientCountsの要素数を出力
  console.log('\n=== clientCountsの要素数 ===');
  console.log('clientCountsのキー数:', Object.keys(clientCounts).length);
  console.log('clientCountsの内容:', JSON.stringify(clientCounts, null, 2));
  
  // APデータの構築
  for (let i = 1; i <= 16; i++) {
    const apName = `ap_${String(i).padStart(2, '0')}`;
    const currentApInfo = apStatusInfo[apName] || { ch: '-', dbm: '-' };
    const ssids = [];

    // デバッグ用：各APのclientCountsの状態を出力
    console.log(`\nAP: ${apName}`);
    console.log('clientCountsに存在するか:', !!clientCounts[apName]);
    if (clientCounts[apName]) {
      console.log('SSID数:', Object.keys(clientCounts[apName]).length);
      console.log('SSID一覧:', Object.keys(clientCounts[apName]));
    }

    if (clientCounts[apName]) {
      for (const [ssidName, count] of Object.entries(clientCounts[apName])) {
        const maxCount = maxClients[ssidName] || 0;
        const percentage = maxCount > 0 ? Math.floor((count / maxCount) * 100) : 0;
        const level = Math.min(Math.floor(percentage / 10), 10);

        ssids.push({
          name: ssidName,
          count: count,
          maxCount: maxCount,
          level: level
        });
      }
    }

    apData.aps.push({
      name: apName,
      channel: currentApInfo.ch,
      power: currentApInfo.dbm,
      ssids: ssids,
      level: ssids.length > 0 ? Math.max(...ssids.map(s => s.level)) : 0
    });
  }

  // 結果出力
  console.log('\n=== アクセスポイントの状態 ===');
  for (const ap of apData.aps) {
    console.log(`${ap.name} ${ap.channel} / ${ap.power}`);
    if (ap.ssids.length > 0) {
      for (const ssid of ap.ssids) {
        console.log(`  ${ssid.name}: ${ssid.count}台 (レベル${ssid.level})`);
      }
    }
  }
  
  addLogEntry('APデータを更新しました');
}

