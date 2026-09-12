/**
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'com.sandbox-map.app',
  productName: 'SANDBOX MAP',
  copyright: 'Copyright © 2026 Smilegate',
  directories: {
    output: 'release',
  },
  files: [
    'dist/**/*',
    'electron/**/*',
    'public/ico2.png',
  ],
  win: {
    target: ['nsis', 'portable'],
    icon: 'ico2.png',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'SANDBOX MAP',
  },
  mac: {
    target: ['dmg'],
    icon: 'ico2.png',
    category: 'public.app-category.productivity',
  },
}
