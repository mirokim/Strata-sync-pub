/**
 * Electron launcher — VSCode 터미널에서 ELECTRON_RUN_AS_NODE=1이 상속되면
 * Electron이 browser process 대신 일반 Node.js로 시작되어 require('electron') 실패.
 * 이 래퍼가 해당 환경변수를 제거한 뒤 electron.exe를 spawn합니다.
 */
const { spawn } = require('child_process')
const electron = require('electron')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, process.argv.slice(2), {
  stdio: 'inherit',
  env,
  windowsHide: false,
})

child.on('close', (code, signal) => {
  if (code === null) {
    console.error('electron exited with signal', signal)
    process.exit(1)
  }
  process.exit(code)
})

process.on('SIGINT', () => { if (!child.killed) child.kill('SIGINT') })
process.on('SIGTERM', () => { if (!child.killed) child.kill('SIGTERM') })
