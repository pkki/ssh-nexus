# GitHubへ公開する

1. `SSH-Nexus-GitHub-Publish-<version>.zip` を展開します。
2. `publish.cmd` をダブルクリックします（文字コード問題を避けるため、英数字名のファイルを使用してください）。
3. 初回だけブラウザーでGitHubにログインします。
4. リポジトリ名を確認し、`PUBLIC` と入力します。

スクリプトはGitHub CLIの確認・インストール、公開先設定、テスト、Windowsインストーラー作成、ソースのpush、GitHub Releaseへのファイル登録、GitHub Pagesの準備まで実行します。

## 必要なもの

- Windows 11（wingetが利用できること）
- GitHubアカウント

GitHub CLI、Git、Node.jsが見つからない場合は、公開スクリプトがwingetで導入します。インストール直後にパスを認識できない場合だけ、`公開する.cmd`をもう一度実行してください。

公開後のアプリは設定したGitHub Releasesを起動時に確認し、新版がある場合はインストーラーのダウンロードを案内します。
