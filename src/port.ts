/**
 * port.ts — 释放被占用的端口（跨平台）。
 *
 * 插件被 `Ctrl+C` 或异常终止时可能留下僵尸监听进程，下次启动会 EADDRINUSE。
 * 启动前先杀掉占用者；**排除自身 PID**，避免热重启场景下自杀。
 */

import { spawn } from 'node:child_process';

export function killPortProcess(port: number): Promise<void> {
  const selfPid = String(process.pid);

  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const netstat = spawn('netstat', ['-ano']);
      let output = '';
      netstat.stdout.on('data', (d) => {
        output += d.toString();
      });
      netstat.on('error', () => resolve());
      netstat.on('close', () => {
        const pids: string[] = [];
        for (const line of output.split('\n')) {
          if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue;
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== selfPid && !pids.includes(pid)) pids.push(pid);
        }
        if (pids.length === 0) return resolve();
        const taskkill = spawn('taskkill', ['/F', '/PID', ...pids]);
        taskkill.on('error', () => resolve());
        taskkill.on('close', () => resolve());
      });
      return;
    }

    const lsof = spawn('lsof', ['-ti', `:${port}`]);
    let pids = '';
    lsof.stdout.on('data', (d) => {
      pids += d.toString();
    });
    lsof.stderr.on('data', () => {});
    lsof.on('error', () => resolve());
    lsof.on('close', (code) => {
      if (code !== 0 || !pids.trim()) return resolve();
      const list = pids
        .trim()
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p && p !== selfPid);
      if (list.length === 0) return resolve();
      const kill = spawn('kill', ['-9', ...list]);
      kill.on('error', () => resolve());
      kill.on('close', () => resolve());
    });
  });
}
