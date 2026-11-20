// OpenFOAM が見つからないときの案内（プラットフォーム別）。何をすれば使えるようになるかを具体的に書く。

export function openfoamInstallGuide(o: { platform: NodeJS.Platform | string; arch: string }): string {
  const dockerImage = 'opencfd/openfoam-default:2406';
  if (o.platform === 'darwin') {
    if (o.arch === 'arm64') {
      return (
        'OpenFOAM が見つかりません。Mac（Apple Silicon）では OpenFOAM.app を入れるのが簡単です（macOS 15 以降）。' +
        'ターミナルで `brew install gerlero/openfoam/openfoam@2606` を実行し、入ったら Studio M を再起動してください（/Applications/OpenFOAM-v2606.app を自動で見つけます）。' +
        `代わりに Docker Desktop を入れて ${dockerImage} イメージを使う方法もあります。`
      );
    }
    return (
      'OpenFOAM が見つかりません。Intel Mac では OpenFOAM.app が使えないので、Docker Desktop を入れてください。' +
      `入れたあと Studio M を再起動すると、${dockerImage}（opencfd のイメージ）を自動で使います（初回はイメージの取得に時間がかかります）。`
    );
  }
  if (o.platform === 'win32') {
    return (
      'OpenFOAM が見つかりません。Windows では WSL2 の Ubuntu に OpenFOAM（openfoam.com の apt リポジトリ）を入れ、' +
      'その Ubuntu の中で Node.js を入れて `npm run engine` を動かしてください。' +
      `または Docker Desktop を入れると、${dockerImage} イメージを自動で使います。`
    );
  }
  return (
    'OpenFOAM が見つかりません。Linux では openfoam.com の apt リポジトリから openfoam を入れるか（`apt install openfoam`、版が古い v1912 でも動きます）、' +
    `Docker を入れて ${dockerImage} イメージを使ってください。` +
    'Debian/Ubuntu のパッケージでは環境変数 WM_PROJECT_DIR=/usr/share/openfoam が必要な場合があります。'
  );
}
