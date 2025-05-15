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
const server = app.listen(PORT, () => {
  console.log(`http://localhost:${PORT} で待機中`);
  addLogEntry(`サーバーを起動しました（更新間隔: ${UPDATE_INTERVAL/1000}秒）`);
});
const wss = new WebSocket.Server({ server });

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

  // 共通変数
  const logPath = path.join(logDir, 'ap.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  let isComplete = false; // 収集処理が完了したかどうかを追跡

  // ログストリームエラーハンドラを追加
  logStream.on('error', (streamErr) => {
    console.error('ログストリームエラー:', streamErr);
    addLogEntry(`ログストリームエラー: ${streamErr}`, 'error');
  });

  // 最終的な処理終了と次ステップへの移行
  function finishCollection(success = true) {
    if (isComplete) return; // 既に完了処理済みなら何もしない
    isComplete = true;

    // ログストリームが存在し、まだwritableなら閉じる
    if (logStream.writable) {
      logStream.end('データ収集完了\n', () => {
        addLogEntry('ログストリームを閉じました。データ抽出を開始します。');
        // 少し遅延を入れてからデータ抽出を実行
        process.nextTick(() => {
          extractor();
        });
      });
    } else {
      addLogEntry('ログストリームが既に閉じられています。データ抽出を直接開始します。');
      extractor();
    }
  }

  // ----- 1. APサーバからの情報収集 -----
  function collectFromAP() {
    const client = new net.Socket();
    let buffer = '';
    let currentState = 'login';
    const commands = [
      'show aps',
      'show amp-audit | include (ssid-profile|max-clients-threshold)',
      'show clients',
      'show network'
    ];
    let currentCommand = 0;
    let apCollectionComplete = false; // AP情報収集が完了したかを追跡

    addLogEntry('APサーバに接続を試みています...');

    client.connect(23, '172.21.7.220', () => {
      addLogEntry('APサーバに接続しました');
      
      // ログに接続情報を記録
      if (logStream.writable) {
        try {
          logStream.write('APサーバに接続しました\n');
        } catch (err) {
          console.error('ログ書き込みエラー:', err);
        }
      }
    });

    client.on('data', (data) => {
      if (apCollectionComplete) return; // 収集完了後のデータは無視

      const dataStr = data.toString();
      buffer += dataStr;

      // ログに受信データを記録
      if (logStream.writable) {
        try {
          logStream.write(dataStr);
        } catch (err) {
          console.error('データログ書き込みエラー:', err);
        }
      }

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
            
            // ログにコマンド実行を記録
            if (logStream.writable) {
              try {
                logStream.write(`\n=== 実行コマンド: ${commands[currentCommand]} ===\n`);
              } catch (err) {
                console.error('コマンドログ書き込みエラー:', err);
              }
            }
            
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
              
              // ログにコマンド実行を記録
              if (logStream.writable) {
                try {
                  logStream.write(`\n=== 実行コマンド: ${commands[currentCommand]} ===\n`);
                } catch (err) {
                  console.error('コマンドログ書き込みエラー:', err);
                }
              }
              
              addLogEntry(`コマンド実行: ${commands[currentCommand]}`);
            } else {
              // 全コマンド完了後にログアウト
              apCollectionComplete = true; // 収集完了フラグを設定
              try {
                client.write('exit\r\n');
                client.end();
                addLogEntry('全コマンド実行完了、ログアウトします');
              } catch (err) {
                console.error('AP接続終了エラー:', err);
                client.destroy();
              }
            }
          }
          break;
      }
    });

    client.on('close', () => {
      addLogEntry('APサーバ接続が閉じられました');
      
      // ログに接続終了を記録
      if (logStream.writable) {
        try {
          logStream.write('APサーバ接続が閉じられました\n');
        } catch (err) {
          console.error('ログ書き込みエラー:', err);
        }
      }

      // AP情報収集完了、SW10からの情報収集に移行
      collectFromSW10();
    });

    client.on('error', (err) => {
      console.error('APサーバ接続でエラーが発生しました:', err);
      addLogEntry(`APサーバ接続でエラーが発生しました: ${err}`, 'error');
      
      // ログにエラーを記録
      if (logStream.writable) {
        try {
          logStream.write(`APサーバ接続でエラーが発生しました: ${err}\n`);
        } catch (writeErr) {
          console.error('エラーログ書き込み失敗:', writeErr);
        }
      }

      // エラーがあっても次のステップに進む
      collectFromSW10();
    });
  }

  // ----- 2. SW10からのDHCP情報収集 -----
  function collectFromSW10() {
    const client = new net.Socket();
    let buffer = '';
    let currentState = 'login';
    const command = 'display dhcp server stat pool 0';
    let commandExecuted = false;
    let sw10CollectionComplete = false; // SW10情報収集が完了したかを追跡
    let loginAttempts = 0;
    const maxLoginAttempts = 3;

    addLogEntry('SW10に接続を試みています...');

    client.connect(23, '172.20.7.253', () => {
      addLogEntry('SW10に接続しました');
      
      // ログに接続情報を記録（追記モード）
      if (logStream.writable) {
        try {
          logStream.write('\nSW10に接続しました\n');
        } catch (err) {
          console.error('ログ書き込みエラー:', err);
        }
      }
    });

    client.on('data', (data) => {
      if (sw10CollectionComplete) return; // 収集完了後のデータは無視

      const dataStr = data.toString();
      buffer += dataStr;
      console.log(`SW10受信データ: ${dataStr}`);

      // ログに受信データを記録
      if (logStream.writable) {
        try {
          logStream.write(dataStr);
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
              
              // ログにコマンド実行を記録
              if (logStream.writable) {
                try {
                  logStream.write(`\n=== 実行コマンド: ${command} ===\n`);
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
              sw10CollectionComplete = true;
              client.end();
            }
          }
          break;

        case 'commands':
          // プロンプトが表示されたらログアウト
          if ((buffer.includes('>') || buffer.includes('#')) && commandExecuted) {
            console.log('コマンド実行完了を検出しました');
            if (!sw10CollectionComplete) {
              sw10CollectionComplete = true; // 収集完了フラグを設定
              try {
                client.write('exit\r\n');
                // すぐにclient.end()を呼ぶのではなく、少し待ってから閉じる
                setTimeout(() => {
                  try {
                    client.end();
                    addLogEntry('SW10コマンド実行完了、ログアウトします');
                  } catch (endErr) {
                    console.error('接続終了エラー:', endErr);
                    client.destroy();
                  }
                }, 500);
              } catch (writeErr) {
                console.error('exit書き込みエラー:', writeErr);
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
      
      // ログに接続終了を記録
      if (logStream.writable) {
        try {
          logStream.write('SW10接続が閉じられました\n');
        } catch (err) {
          console.error('ログ書き込みエラー:', err);
        }
      }

      // 全ての情報収集完了、データ抽出に移行
      finishCollection();
    });

    client.on('error', (err) => {
      console.error('SW10接続でエラーが発生しました:', err);
      addLogEntry(`SW10接続でエラーが発生しました: ${err}`, 'error');
      
      // ログにエラーを記録
      if (logStream.writable) {
        try {
          logStream.write(`SW10接続でエラーが発生しました: ${err}\n`);
        } catch (writeErr) {
          console.error('エラーログ書き込み失敗:', writeErr);
        }
      }
      
      // エラーがあってもクローズイベントが発生するはず
      // client.destroy()によってcloseイベントが発生するため、直接finishCollectionは呼ばない
      client.destroy();
    });

    // タイムアウト処理
    setTimeout(() => {
      if (!sw10CollectionComplete && !client.destroyed) {
        console.log('SW10接続がタイムアウトしました');
        addLogEntry('SW10接続がタイムアウトしました', 'error');
        
        // ログにタイムアウトを記録
        if (logStream.writable) {
          try {
            logStream.write('SW10接続がタイムアウトしました\n');
          } catch (writeErr) {
            console.error('タイムアウトログ書き込み失敗:', writeErr);
          }
        }
        
        // 接続を強制的に切断
        client.destroy();
      }
    }, 30000);
  }

  // 処理の開始: APサーバからの情報収集を開始
  collectFromAP();
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
        // "Pool utilization:                  25.00%" のような形式から数値を抽出
        const match = line.match(/Pool utilization:\s*([\d.]+)%/);
        if (match && match[1]) {
          // 小数点を含む値をそのまま使用
          utilization = parseFloat(match[1]);
        }
        inDhcpStat = false;
      }
    }
    
    return utilization;
  }

  // ネットワーク情報を抽出する関数
  function extractNetworkInfo(lines) {
    const networkInfo = [];
    let inNetworkList = false;

    for (const line of lines) {
      if (line.includes('Networks')) {
        inNetworkList = true;
        continue;
      }

      if (inNetworkList) {
        if (line.trim() === '') {
          inNetworkList = false;
          continue;
        }

        // ネットワーク情報の行を解析
        const match = line.match(/^(\S+)\s+\S+\s+(\d+)\s+/);
        if (match && match[1] && match[2]) {
          const networkName = match[1];
          const clientCount = parseInt(match[2], 10);
          if (clientCount > 0) {
            networkInfo.push(`${networkName}:${clientCount}`);
          }
        }
      }
    }

    return networkInfo.join(' / ');
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
        const networkInfo = extractNetworkInfo(lines);

        updateApData(apInfo, clientCounts, maxClients, dhcpUtilization, networkInfo);

    } catch (parseError) {
        console.error('ログデータの解析中にエラーが発生しました:', parseError);
        addLogEntry(`ログデータの解析エラー: ${parseError}`, 'error');
    } finally {
        isLogging = false; // ログ収集プロセス全体の完了フラグをリセット
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

// メイン処理
function updateApData(apStatusInfo, clientCounts, maxClients, dhcpUtilization, networkInfo) {
  // APデータの更新
  apData.mtime = Math.floor(Date.now() / 1000);
  apData.aps = [];
  apData.dhcpUtilization = dhcpUtilization; // DHCPプール使用率を設定
  apData.networkInfo = networkInfo; // ネットワーク情報を設定

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