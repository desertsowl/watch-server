// ==================================================
//  watch-server  アクセスポイント監視スクリプト
//  http://watch.local:5000/
// ==================================================

// 日本時間に設定
process.env.TZ = 'Asia/Tokyo';

const express = require('express');
const app = express();
const PORT = 5000;
const net = require('net');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// EJSテンプレートエンジンの設定
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 静的ファイルの提供を有効化
app.use(express.static('public'));

// グローバル変数としてAPデータを保持
let apData = {
  mtime: Math.floor(Date.now() / 1000),
  aps: [],
  dhcpUtilization: 0 // DHCPプール使用率を追加
};
let isLogging = false;

// WebSocketサーバーの作成
const wss = new WebSocket.Server({ port: 5001 });

// WebSocketクライアントの管理
const clients = new Set();

// WebSocket接続の処理
wss.on('connection', (ws) => {
  clients.add(ws);
  addLogEntry('WebSocketクライアントが接続しました');

  ws.on('close', () => {
    clients.delete(ws);
    addLogEntry('WebSocketクライアントが切断しました');
  });
});

// データ更新を通知する関数
function notifyClients() {
  const message = JSON.stringify(apData);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

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
  if (isLogging) {
    addLogEntry('前回のログ収集プロセスが実行中のため、今回の実行をスキップします。');
    return;
  }
  isLogging = true;
  addLogEntry('ログ収集プロセスを開始します。');

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

    // SW10からDHCP情報を取得
    getDhcpInfo();

    isLogging = false;
    addLogEntry('ログ収集プロセスが完了しました。');
  });

  client.on('error', (err) => {
    console.error('エラーが発生しました:', err);
    logStream.write(`エラーが発生しました: ${err}\n`);
    logStream.end();
    addLogEntry(`エラーが発生しました: ${err}`, 'error');
  });
}

// SW10からDHCP情報を取得する関数
function getDhcpInfo() {
  const client = new net.Socket();
  let buffer = '';
  // ログストリームをまだ開かない！クライアント接続成功後に開く
  let logStreamDhcp = null;
  let currentState = 'login';
  const command = 'display dhcp server stat pool 0';
  let commandExecuted = false;
  let sessionEnded = false; // セッションが終了したかを追跡
  let loginAttempts = 0;
  const maxLoginAttempts = 3;

  addLogEntry('SW10に接続を試みています...');

  // クライアントの接続が閉じられたことを追跡する関数
  function endSession() {
    if (sessionEnded) {
      console.log('セッションは既に終了しています');
      return; // 既に終了処理済みなら何もしない
    }
    
    // セッション終了フラグを最初に設定
    sessionEnded = true;
    console.log('セッション終了処理を開始します');

    // ログストリームが存在し、まだwritableなら閉じる
    if (logStreamDhcp && logStreamDhcp.writable) {
      try {
        logStreamDhcp.end('SW10接続が閉じられました\n', () => {
          console.log('ログストリームを正常に閉じました');
          addLogEntry('SW10ログストリームを閉じました。データ抽出を開始します。');
          // データ抽出処理は別タイミングで実行
          process.nextTick(() => {
            try {
              extractor(); // ストリームが確実に閉じられた後にデータ抽出を実行
            } catch (extractErr) {
              console.error('データ抽出中にエラーが発生しました:', extractErr);
              addLogEntry(`データ抽出エラー: ${extractErr}`, 'error');
              isLogging = false; // 確実にフラグを下ろす
            }
          });
        });
      } catch (endErr) {
        console.error('ログストリーム終了エラー:', endErr);
        addLogEntry(`ログストリーム終了エラー: ${endErr}`, 'error');
        // エラーが発生した場合も、データ抽出を試みる
        try {
          extractor();
        } catch (extractErr) {
          console.error('データ抽出中にエラーが発生しました:', extractErr);
          isLogging = false;
        }
      }
    } else {
      // ストリームが存在しないか、既に閉じられている場合
      console.log('ログストリームは既に閉じられているか、利用できません');
      addLogEntry('SW10ログストリームが利用できないため、データ抽出を直接開始します。');
      try {
        extractor();
      } catch (extractErr) {
        console.error('データ抽出中にエラーが発生しました:', extractErr);
        addLogEntry(`データ抽出エラー: ${extractErr}`, 'error');
        isLogging = false; // 確実にフラグを下ろす
      }
    }
  }

  client.connect(23, '172.20.7.253', () => {
    // 接続が確立された後にログストリームを開く
    logStreamDhcp = fs.createWriteStream(path.join(logDir, 'ap.log'), { flags: 'a' });
    
    // ストリームエラーハンドラを追加
    logStreamDhcp.on('error', (streamErr) => {
      console.error('SW10ログストリームエラー:', streamErr);
      addLogEntry(`SW10ログストリームエラー: ${streamErr}`, 'error');
    });

    console.log('SW10に接続しました');
    logStreamDhcp.write('\nSW10に接続しました\n');
    addLogEntry('SW10に接続しました');
  });

  client.on('data', (data) => {
    if (sessionEnded) return; // セッション終了後のデータは無視

    const dataStr = data.toString();
    buffer += dataStr;
    console.log(`SW10受信データ: ${dataStr}`);

    // ログストリームが利用可能な場合のみ書き込み
    if (logStreamDhcp && logStreamDhcp.writable) {
      try {
        logStreamDhcp.write(dataStr);
      } catch (err) {
        console.error('ログストリーム書き込みエラー:', err);
      }
    }

    switch (currentState) {
      case 'login':
        if (buffer.includes('Password:')) {
          console.log('パスワードプロンプトを検出しました');
          client.write('CX1U53AM\r\n');
          buffer = '';
        } else if (buffer.includes('>') || buffer.includes('#')) {
          console.log('ログイン成功を検出しました');
          currentState = 'commands';
          buffer = '';
          // 少し待ってからコマンドを実行
          setTimeout(() => {
            console.log('コマンドを実行します');
            client.write(command + '\r\n');
            // ログストリームに書き込む際に安全性チェックを追加
            if (logStreamDhcp && logStreamDhcp.writable) {
              try {
                logStreamDhcp.write(`\n=== 実行コマンド: ${command} ===\n`);
              } catch (err) {
                console.error('コマンドログ書き込みエラー:', err);
              }
            }
            addLogEntry(`SW10コマンド実行: ${command}`);
            commandExecuted = true;
          }, 1000);
        } else if (buffer.includes('Login:') || buffer.includes('Username:')) {
          console.log('ユーザー名プロンプトを検出しました');
          // ユーザー名が不要な場合はEnterキーを送信
          client.write('\r\n');
          buffer = '';
        } else if (buffer.includes('incorrect') || buffer.includes('Invalid')) {
          console.log('ログイン失敗を検出しました');
          loginAttempts++;
          if (loginAttempts < maxLoginAttempts) {
            buffer = '';
            // 再試行
            setTimeout(() => {
              client.write('\r\n');
            }, 1000);
          } else {
            addLogEntry('SW10ログイン失敗: 最大試行回数を超えました', 'error');
            client.end();
          }
        }
        break;

      case 'commands':
        // プロンプトが表示されたらログアウト
        if ((buffer.includes('>') || buffer.includes('#')) && commandExecuted) {
          console.log('コマンド実行完了を検出しました');
          // 既にセッション終了処理が行われていないことを確認
          if (!sessionEnded) {
            try {
              client.write('exit\r\n');
              // すぐにclient.end()を呼ぶのではなく、少し待ってから閉じる
              setTimeout(() => {
                if (!sessionEnded) {
                  try {
                    client.end();
                    addLogEntry('SW10コマンド実行完了、ログアウトします');
                  } catch (endErr) {
                    console.error('接続終了エラー:', endErr);
                    // 接続を強制的に切断
                    client.destroy();
                  }
                }
              }, 500); // 500ms待機
            } catch (writeErr) {
              console.error('exit書き込みエラー:', writeErr);
              // 書き込みエラーの場合は接続を強制的に切断
              client.destroy();
              addLogEntry('SW10コマンド実行後の終了処理でエラーが発生しました');
            }
          }
        }
        break;
    }
  });

  client.on('close', () => {
    console.log('SW10接続が閉じられました');
    addLogEntry('SW10接続が閉じられました');
    endSession(); // 終了処理を集約
  });

  client.on('error', (err) => {
    console.error('SW10接続でエラーが発生しました:', err);
    addLogEntry(`SW10接続でエラーが発生しました: ${err}`, 'error');
    
    // エラー時のログ記録を試みる（書き込み可能な場合のみ）
    if (logStreamDhcp && logStreamDhcp.writable) {
      try {
        logStreamDhcp.write(`SW10接続でエラーが発生しました: ${err}\n`);
      } catch (writeErr) {
        console.error('エラーログ書き込み失敗:', writeErr);
      }
    }
    
    // client.destroy()によってclose イベントが発生するため、
    // ここではendSession()を直接呼び出さない
    client.destroy();
    
    // ただし、万が一closeイベントが発生しない場合に備えてフラグは設定
    isLogging = false;
  });

  // タイムアウト処理
  setTimeout(() => {
    if (!sessionEnded && !client.destroyed) {
      console.log('SW10接続がタイムアウトしました');
      addLogEntry('SW10接続がタイムアウトしました', 'error');
      
      if (logStreamDhcp && logStreamDhcp.writable) {
        try {
          logStreamDhcp.write('SW10接続がタイムアウトしました\n');
        } catch (writeErr) {
          console.error('タイムアウトログ書き込み失敗:', writeErr);
        }
      }
      
      client.destroy(); // これによりcloseイベントが発生する
    }
  }, 30000);
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

    // クライアント接続情報を抽出
    const clientCounts = extractClientInfo(lines);

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
            const apName = fields[0];
            const ssidString = fields[8];
            
            // APが存在しない場合は初期化
            if (!apInfo[apName]) {
              apInfo[apName] = {
                ch: fields[10],
                dbm: fields[11],
                ssids: []
              };
            }
            
            // SSIDをカンマで分割して処理
            const ssidList = ssidString.split(',').map(s => s.trim());
            for (const ssid of ssidList) {
              // 接続台数を取得
              const clientCount = clientCounts[apName]?.[ssid] || 0;
              
              // SSID情報を追加
              apInfo[apName].ssids.push({
                name: ssid,
                clientCount: clientCount
              });
            }
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
          const ssid = fields[4].trim();
          const accessPoint = fields[5].trim();

          if (!accessPoint.startsWith('ap_')) {
            continue;
          }

          if (!clientCounts[accessPoint]) {
            clientCounts[accessPoint] = {};
          }
          if (!clientCounts[accessPoint][ssid]) {
            clientCounts[accessPoint][ssid] = 0;
          }
          clientCounts[accessPoint][ssid]++;
        }
      }
    }

    return clientCounts;
  }

  // SSID最大接続数を抽出する関数
  function extractMaxClients(lines) {
    const maxClients = {};
    let inAmpAudit = false;
    let currentSsid = '';

    for (const line of lines) {
      if (line.includes('show amp-audit')) {
        inAmpAudit = true;
        continue;
      }

      if (inAmpAudit) {
        if (line.startsWith('wlan ssid-profile')) {
          currentSsid = line.split(' ').pop().trim();
        } else if (line.startsWith(' max-clients-threshold')) {
          const maxValue = parseInt(line.trim().split(' ')[1], 10);
          if (currentSsid) {
            maxClients[currentSsid] = maxValue;
          }
        }
        if (line.trim() === '') {
          inAmpAudit = false;
          currentSsid = '';
        }
      }
    }
    return maxClients;
  }

  // DHCPプール使用率を抽出する関数
  function extractDhcpUtilization(lines) {
    let utilization = 0;
    let inDhcpStat = false;
    
    for (const line of lines) {
      if (line.includes('display dhcp server stat')) {
        inDhcpStat = true;
        continue;
      }
      
      if (inDhcpStat && line.includes('Pool utilization')) {
        // "Pool utilization: 50%" のような形式から数値を抽出
        const match = line.match(/Pool utilization:\s*(\d+)%/);
        if (match && match[1]) {
          utilization = parseInt(match[1], 10);
        }
        inDhcpStat = false;
      }
    }
    
    return utilization;
  }

  // メイン処理
  fs.readFile(logFilePath, 'utf8', (err, data) => {
    if (err) {
      console.error('ログファイルの読み込み中にエラーが発生しました:', err);
      addLogEntry(`ログファイルの読み込みエラー: ${err}`, 'error');
      isLogging = false; // ファイル読み込みエラー時もフラグを下ろす
      addLogEntry('ログ収集プロセスがエラーで終了しました。');
      return;
    }

    try {
        const lines = data.split('\n');
        const apInfo = extractApStatus(lines);
        const clientCounts = extractClientInfo(lines);
        const maxClients = extractMaxClients(lines);
        const dhcpUtilization = extractDhcpUtilization(lines);

        updateApData(apInfo, clientCounts, maxClients, dhcpUtilization);

    } catch (parseError) {
        console.error('ログデータの解析中にエラーが発生しました:', parseError);
        addLogEntry(`ログデータの解析エラー: ${parseError}`, 'error');
    } finally {
        isLogging = false; // 抽出・更新処理完了または解析エラー時にフラグを下ろす
        addLogEntry('ログ収集プロセスが完了しました。');
    }
  });
}

// ================================================
//  メインルーチン
// ================================================

// 更新間隔（ミリ秒）
const UPDATE_INTERVAL = 60000; // 1分ごとに更新

// 機器からログを収集
logger();

// 定期的に更新を実行
setInterval(() => {
  if (!isLogging) {
    addLogEntry('定期的な更新を開始します');
    logger();
  } else {
    addLogEntry('前回のログ収集が完了していないため、定期更新をスキップします。');
  }
}, UPDATE_INTERVAL);

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT} で待機中`);
  addLogEntry(`サーバーを起動しました（更新間隔: ${UPDATE_INTERVAL/1000}秒）`);
});

// メイン処理
function updateApData(apStatusInfo, clientCounts, maxClients, dhcpUtilization) {
  // APデータの更新
  apData.mtime = Math.floor(Date.now() / 1000);
  apData.aps = [];
  apData.dhcpUtilization = dhcpUtilization; // DHCPプール使用率を設定

  // APデータの構築
  for (let i = 1; i <= 16; i++) {
    const apName = `ap_${String(i).padStart(2, '0')}`;
    const currentApInfo = apStatusInfo[apName] || { ch: '-', dbm: '-', ssids: [] };
    const ssids = [];

    // 現在のAPに割り当てられているSSIDの情報を追加
    for (const ssidInfo of currentApInfo.ssids) {
      const ssidName = ssidInfo.name;
      const count = ssidInfo.clientCount || 0;
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

    apData.aps.push({
      name: apName,
      channel: currentApInfo.ch,
      power: currentApInfo.dbm,
      ssids: ssids,
      level: ssids.length > 0 ? Math.max(...ssids.map(s => s.level)) : 0
    });
  }

  addLogEntry('APデータを更新しました');
  
  // クライアントに更新を通知
  notifyClients();
}