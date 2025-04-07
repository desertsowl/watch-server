# AP監視システム

## 概要

このプロジェクトは、WiFiアクセスポイント（AP）の状態を監視するためのWebアプリケーションです。各APの接続状況、チャンネル、電力、SSIDごとの接続数などをリアルタイムで表示します。

## 機能

- アクセスポイントの状態監視
- SSIDごとの接続数表示
- 接続率に基づくヒートマップ表示
- リアルタイム更新

## 必要条件

- Node.js (v12以上)
- npm (v6以上)

## インストール方法

1. リポジトリをクローンします
   ```
   git clone https://github.com/yourusername/watch-server.git
   cd watch-server
   ```

2. 依存関係をインストールします
   ```
   npm install
   ```

## 使用方法

1. サーバーを起動します
   ```
   node index.js
   ```

2. ブラウザで以下のURLにアクセスします
   ```
   http://localhost:5000
   ```

## 設定

設定を変更する場合は、`index.js`ファイルを編集してください。

- `PORT`: サーバーのポート番号（デフォルト: 5000）
- `TELNET_HOST`: Telnet接続先のホスト名またはIPアドレス
- `TELNET_PORT`: Telnet接続先のポート番号（デフォルト: 23）
- `TELNET_USERNAME`: Telnet接続用のユーザー名
- `TELNET_PASSWORD`: Telnet接続用のパスワード

## ディレクトリ構造

```
watch-server/
├── index.js          # メインアプリケーション
├── views/            # EJSテンプレート
│   └── index.ejs     # メインページのテンプレート
├── public/           # 静的ファイル
└── log/              # ログファイル
```

## ライセンス

このプロジェクトは[MITライセンス](LICENSE)の下で公開されています。

## 作者

[あなたの名前]

## 謝辞

このプロジェクトの開発に協力してくださった方々に感謝します。 