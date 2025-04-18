// WebSocket接続の確立
let ws;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 1000; // 1秒

function connectWebSocket() {
  ws = new WebSocket('ws://localhost:5001');

  // WebSocket接続が確立されたときの処理
  ws.onopen = () => {
    console.log('WebSocket接続が確立されました');
    reconnectAttempts = 0; // 接続成功時にリセット
  };

  // WebSocketからメッセージを受信したときの処理
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    updateDisplay(data);
  };

  // WebSocket接続が切断されたときの処理
  ws.onclose = () => {
    console.log('WebSocket接続が切断されました');
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
      console.log(`${delay/1000}秒後に再接続を試みます (試行回数: ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
      
      setTimeout(() => {
        reconnectAttempts++;
        connectWebSocket();
      }, delay);
    } else {
      console.log('最大再接続試行回数に達しました。ページをリロードします。');
      window.location.reload();
    }
  };

  // WebSocket接続でエラーが発生したときの処理
  ws.onerror = (error) => {
    console.error('WebSocketエラー:', error);
  };
}

// 初期接続
connectWebSocket();

// 表示を更新する関数
function updateDisplay(data) {
  console.log('データを受信しました:', data);
  
  // APデータの更新
  data.aps.forEach(ap => {
    // APの要素を探す
    const apElements = document.querySelectorAll('.ap');
    for (const apElement of apElements) {
      // AP名を取得
      const apNameElement = apElement.querySelector('.ap_name');
      if (apNameElement && apNameElement.textContent === ap.name) {
        // チャンネルと電力の更新
        const radioElement = apElement.querySelector('.radio');
        if (radioElement) {
          radioElement.textContent = `${ap.channel}ch/${ap.power}dBm`;
        }
        
        // SSID情報の更新
        const ssidContainer = apElement.querySelectorAll('.info_ssid');
        // 既存のSSID情報を削除
        ssidContainer.forEach(el => el.remove());
        
        // 新しいSSID情報を追加
        ap.ssids.forEach(ssid => {
          const ssidElement = document.createElement('div');
          ssidElement.className = `info_ssid lv${ssid.level}`;
          ssidElement.innerHTML = `
            <span class="ssid_name">${ssid.name}</span>
            <span class="maxcount">(${ssid.maxCount}台)</span>
            <br style="line-height:0.1em;">
            <span class="cnt">${ssid.count}<span>台</span>
          `;
          apElement.appendChild(ssidElement);
        });
        
        // AP全体のレベル表示の更新
        apElement.className = `ap lv${ap.level}`;
        break;
      }
    }
  });

  // 最終更新時刻の更新
  const mtime = new Date(data.mtime * 1000);
  const mtimeElement = document.getElementById('mtime');
  if (mtimeElement) {
    mtimeElement.value = data.mtime;
  }
  
  // 最終更新時刻の表示を更新
  const ptimeElement = document.getElementById('ptime');
  if (ptimeElement) {
    ptimeElement.textContent = mtime.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }
  
  // DHCPプール使用率の更新
  const dhcpInfoElement = document.getElementById('dhcp-info');
  if (dhcpInfoElement && data.dhcpUtilization !== undefined) {
    // DHCP使用率によって色を変更（lvクラスを設定）
    const dhcpLevel = Math.min(Math.ceil(data.dhcpUtilization / 10), 10);
    
    // 現在のlvクラスを削除
    for (let i = 0; i <= 10; i++) {
      dhcpInfoElement.classList.remove(`lv${i}`);
    }
    
    // 新しいlvクラスを追加
    dhcpInfoElement.classList.add(`lv${dhcpLevel}`);
    
    // 表示を更新
    dhcpInfoElement.innerHTML = `DHCP Pool: <span class="value">${data.dhcpUtilization.toFixed(2)}%</span>`;
  }
  
  console.log('表示を更新しました');
} 