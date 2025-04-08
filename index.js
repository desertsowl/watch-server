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
  dhcp: {}
};

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

// ================================================
//  定数
// ================================================
const TELNET_HOST = '172.21.7.220';
const TELNET_PORT = 23;
const TELNET_USERNAME = 'admin';
const TELNET_PASSWORD = 'k1kuk@w@';

// スイッチ接続情報
const SWITCH_HOST = '172.20.7.253';
const SWITCH_PORT = 23;
const SWITCH_PASSWORD = 'CX1U53AM';

// ================================================
//  関数
// ================================================

// スイッチからDHCP情報を取得する関数
function getSwitchDhcpInfo() {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let data = '';
    
    client.connect(SWITCH_PORT, SWITCH_HOST, () => {
      addLogEntry(`スイッチ ${SWITCH_HOST} に接続しました`);
    });
    
    client.on('data', (chunk) => {
      data += chunk.toString();
    });
    
    client.on('end', () => {
      addLogEntry(`スイッチ ${SWITCH_HOST} との接続が終了しました`);
      
      // 改行コードを変換
      data = data.replace(/\r\n/g, '\n');
      
      // DHCP情報を抽出
      const dhcpInfo = extractDhcpInfo(data);
      resolve(dhcpInfo);
    });
    
    client.on('error', (err) => {
      addLogEntry(`スイッチ接続エラー: ${err.message}`);
      reject(err);
    });
    
    // ログインシーケンス
    setTimeout(() => {
      client.write(SWITCH_PASSWORD + '\r');
      setTimeout(() => {
        client.write('display dhcp server stat pool 0\r');
        setTimeout(() => {
          client.end();
        }, 3000);
      }, 1000);
    }, 1000);
  });
}

// DHCP情報を抽出する関数
function extractDhcpInfo(lines) {
  const dhcpInfo = {};
  let inDhcpInfo = false;
  let poolName = '';
  
  const lineArray = lines.split('\n');
  for (const line of lineArray) {
    if (line.includes('display dhcp server stat')) {
      inDhcpInfo = true;
      continue;
    }
    
    if (inDhcpInfo) {
      if (line.includes('Pool utilization')) {
        const match = line.match(/Pool utilization:\s+(\d+)%/);
        if (match && poolName) {
          dhcpInfo[poolName] = parseInt(match[1], 10);
        }
      } else if (line.includes('Pool')) {
        const match = line.match(/Pool\s+(\d+)/);
        if (match) {
          poolName = match[1];
        }
      }
      
      if (line.trim() === '') {
        inDhcpInfo = false;
        poolName = '';
      }
    }
  }
  
  return dhcpInfo;
}

// 機器からログを収集する関数
async function logger() {
  try {
    // APからログを取得
    const apLog = await getApLog();
    addLogEntry('APからログを取得しました');
    
    // スイッチからDHCP情報を取得
    const dhcpInfo = await getSwitchDhcpInfo();
    addLogEntry('スイッチからDHCP情報を取得しました');
    
    // AP情報を抽出
    const apStatusInfo = extractApStatus(apLog);
    addLogEntry('AP情報を抽出しました');
    
    // クライアント接続情報を抽出
    const clientCounts = extractClientInfo(apLog);
    addLogEntry('クライアント接続情報を抽出しました');
    
    // SSID最大接続数を抽出
    const maxClients = extractMaxClients(apLog);
    addLogEntry('SSID最大接続数を抽出しました');
    
    // APデータを更新
    updateApData(apStatusInfo, clientCounts, maxClients);
    
    // DHCP情報をAPデータに追加
    apData.dhcp = dhcpInfo;
    addLogEntry('DHCP情報を追加しました');
    
    // ログをファイルに保存
    fs.writeFileSync(path.join(__dirname, 'log', 'ap.log'), apLog);
    addLogEntry('ログをファイルに保存しました');
    
  } catch (error) {
    addLogEntry(`エラーが発生しました: ${error.message}`);
    console.error(error);
  }
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

// 更新間隔（ミリ秒）
const UPDATE_INTERVAL = 60000; // 1分ごとに更新

// 機器からログを収集
logger();

// 定期的に更新を実行
setInterval(() => {
  addLogEntry('定期的な更新を開始します');
  logger();
}, UPDATE_INTERVAL);

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT} で待機中`);
  addLogEntry(`サーバーを起動しました（更新間隔: ${UPDATE_INTERVAL/1000}秒）`);
});

// メイン処理
function updateApData(apStatusInfo, clientCounts, maxClients) {
  // APデータの更新
  apData.mtime = Math.floor(Date.now() / 1000);
  apData.aps = [];

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