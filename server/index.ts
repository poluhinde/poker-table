import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { buildApp } from './app.js';
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный PORT');
if (!existsSync(resolve('dist/index.html'))) throw new Error('Сначала выполните npm run build');
const instance = await buildApp({
  file: resolve('data/table.json'),
  staticDir: resolve('dist'),
  port,
  quiet: true,
});
const url = 'http://localhost:' + port + '/host#' + instance.game.state.hostKey;
function openHost() {
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', "Start-Process '" + url + "'"], {
    windowsHide: true,
    stdio: 'ignore',
  });
  child.on('error', () => console.error('Не удалось открыть браузер.'));
}
try {
  await instance.app.listen({ port, host: '0.0.0.0' });
  console.log('\nЗА СТОЛОМ • Сервер работает на порту ' + port);
  console.log('Оставьте это окно открытым. Для остановки нажмите Ctrl+C.');
  console.log('Игроки подключаются по QR-коду из панели ведущего.');
  if (process.argv.includes('--open')) openHost();
  else console.log('Чтобы открыть панель ведущего, запустите Start Poker.cmd.');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && process.argv.includes('--open')) {
    try {
      const response = await fetch('http://localhost:' + port + '/api/host-info', {
        headers: { Authorization: 'Bearer ' + instance.game.state.hostKey },
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        openHost();
        console.log('Панель уже работающего сервера открыта.');
        await instance.close();
        process.exitCode = 0;
      } else throw new Error('Порт занят другим приложением');
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  } else {
    console.error('Не удалось запустить сервер:', e);
    process.exit(1);
  }
}
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await instance.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
