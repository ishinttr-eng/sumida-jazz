# すみだジャズナビ 2026

「すみだストリートジャズフェスティバル2026」（2026年10月17日・18日、東京都墨田区）の非公式ナビゲーターPWA。
ビルド不要のvanilla JS。地図はOpenStreetMap＋Leaflet、天気はOpen-Meteo、徒歩ルートはOSRM（FOSSGIS）を使用し、APIキー・自前サーバーは不要。

## ローカルで動かす

```bash
cd /Users/rhio/projects/sumida-jazz
python3 -m http.server 8080
# http://localhost:8080/ を開く
```

Service Workerがルート相対パスでキャッシュするため、`file://` では正しく動かない。必ず簡易HTTPサーバー経由で開くこと。

## ファイル構成

```
index.html / manifest.webmanifest / sw.js / icon.svg
css/style.css
js/app.js      UI本体
js/store.js    状態管理・データ読み込み
js/util.js     汎用関数
data/          静的JSON（venues / performances / walktimes / routes / tieup / checked / changes / app_changelog）
tools/         開発用（公開ディレクトリからは除外）
  build_data.py    公式タイムテーブル → data/*.json 変換＋差分検出
  build_routes.py  全会場ペアの徒歩ルートをOSRMから一括取得
.github/workflows/
  update-data.yml   3時間ごとに公式データ再取得→自動コミット
  deploy-pages.yml  pushをトリガーにGitHub Pagesへデプロイ
```

## データについて

- `data/venues.json` / `data/performances.json` は公式サイト（https://sumida-jazz.jp/sj/ ）から2026-09-17時点の内容を収集したもの。会場座標は住所からのジオコーディングによる推定値、徒歩時間は直線距離ベースの概算（`tools/build_routes.py` 実行でOSRM実測値に更新可能）。
- 公式サイトの情報は開催直前まで変動するため、`tools/build_data.py` とGitHub Actionsで自動追従する運用を想定（要: GitHub Pages公開・Actions有効化）。
- HTMLマークアップの変化には `tools/build_data.py` 内の見出し・時刻パターンの正規表現が追従できていない可能性がある。差分検出が動かなくなった場合は `tools/raw/timetable.html` を取得し直してパターンを見直すこと。

## 免責事項

- 本アプリは有志による**非公式ファンアプリ**です。すみだストリートジャズフェスティバル実行委員会および関係団体とは一切関係ありません。
- 出演者、演奏スケジュール、会場等の最新・正確な情報は必ず [公式サイト（https://sumida-jazz.jp/sj/）](https://sumida-jazz.jp/sj/) をご確認ください。
- 本アプリの利用・情報によるいかなる損害についても制作者は責任を負いません。また、本アプリに関する問い合わせを公式運営事務局へ行うことはご遠慮ください。

## 個人データの扱い

お気に入り・感想メモ・評価・スタンプラリーの達成状況はすべて端末のlocalStorageにのみ保存され、外部には送信されません。

## クレジット・謝辞

- **地図**: [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL)
- **マップライブラリ**: [Leaflet](https://leafletjs.com/) (BSD 2-Clause License)
- **天気データ**: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0)
- **徒歩ルート計算**: [OSRM](http://project-osrm.org/) via [FOSSGIS e.V.](https://routing.openstreetmap.de/)
- **イベント情報**: [すみだストリートジャズフェスティバル公式サイト](https://sumida-jazz.jp/sj/)

## ライセンス

本プロジェクトのソースコードは [MIT License](LICENSE) の下で公開されています。

