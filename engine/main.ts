// Studio M Engine の入口。`npm run engine` で起動する（Node.js 22 以上、追加の npm パッケージなし）。
import { HELP_TEXT, parseArgs } from './server/args';
import { loadAdapters } from './server/adapters';
import { generateToken, writeTokenFile } from './server/auth';
import { createEngineService } from './server/service';
import { ENGINE_VERSION } from './server/version';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.errors.length > 0) {
    for (const e of args.errors) console.error(`エラー: ${e}`);
    console.log(HELP_TEXT);
    process.exit(args.errors.length > 0 ? 2 : 0);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`Node.js 22 以上が必要です（いまは ${process.versions.node}）。https://nodejs.org/ から入れ直してください`);
    process.exit(1);
  }

  const fixed = process.env.STUDIO_M_ENGINE_TOKEN;
  const token = fixed && fixed.length >= 16 ? fixed : generateToken();
  const adapters = loadAdapters();
  const service = createEngineService({
    adapters,
    token,
    port: args.port,
    maxConcurrentJobs: args.maxJobs,
    keep: args.keep,
    ttlHours: args.ttlHours,
    commandTimeoutMs: args.timeoutMin * 60_000,
  });

  console.log('エンジンの検出中…');
  let port: number;
  try {
    port = await service.listen();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`ポート ${args.port} はすでに使われています。別のエンジンが動いていないか確認するか、--port で別の番号を指定してください`);
    } else {
      console.error(`エンジンを始められませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(1);
  }

  let tokenFile = '';
  try {
    tokenFile = await writeTokenFile(token);
  } catch (e) {
    console.warn(`合言葉をファイルに保存できませんでした（${e instanceof Error ? e.message : String(e)}）。画面の合言葉をそのまま使ってください`);
  }

  const status = await service.status(false);
  const line = '='.repeat(64);
  console.log(`\n${line}`);
  console.log(` Studio M Engine ${ENGINE_VERSION} が起動しました`);
  console.log(line);
  console.log(` URL     : http://127.0.0.1:${port}`);
  console.log(` 合言葉  : ${token}`);
  console.log(' ');
  console.log(' Studio M の設定（⚙）→「PCのエンジン」に、この URL と合言葉を貼り付けて');
  console.log(' 「接続を確認」を押してください。合言葉は他の人に教えないでください。');
  if (tokenFile) console.log(` （合言葉は ${tokenFile} にも保存しました）`);
  console.log(' ');
  console.log(' 見つかったエンジン:');
  for (const e of status.engines) {
    const mark = e.available ? '✓' : '✗';
    const via = e.available ? `（${e.via === 'docker' ? 'Docker' : 'PC に直接'}）` : '';
    console.log(`   ${mark} ${e.name}${e.version ? ` ${e.version}` : ''}${via}${!e.available && e.note ? ` — ${e.note}` : ''}`);
  }
  if (adapters.length === 0) console.log('   （アダプターが組み込まれていません）');
  console.log(' ');
  console.log(` このエンジンはこの PC（127.0.0.1）からの接続だけを受け付けます。止めるときは Ctrl+C。`);
  console.log(`${line}\n`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    console.log('\n終了しています…');
    void service.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();

