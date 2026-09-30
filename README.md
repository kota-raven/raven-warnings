# raven-warnings

RAVENアプリ用に、海上保安庁の航行警報(NAVAREA XI・日本航行警報・NAVTEX)を
定期的に取得し、`warnings.json` として保存するリポジトリです。

- 取得は GitHub Actions が1時間に1回程度の頻度で自動実行します(`.github/workflows/scrape.yml`)。
- データは海上保安庁の公開ページを要約・構造化したものです。**公式情報は必ず各警報のsourceUrl(一次情報源)でご確認ください。**
- 座標は原文中のDMS(度分秒)表記を自動変換したもので、誤りを含む可能性があります。
- 商用・大量アクセスは行わず、個人開発・非商用のプロトタイプとして利用しています。

## 構成
- `scrape.js` — 取得・変換スクリプト(Node.js、追加ライブラリ不要)
- `warnings.json` — 生成される最新データ
- `.github/workflows/scrape.yml` — 定期実行の設定
