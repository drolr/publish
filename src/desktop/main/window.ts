import { BrowserWindow, type Session } from 'electron';
export function protectSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.setPermissionCheckHandler(() => false);
}
export function createWindow(
  preloadPath: string,
  entryUrl: string,
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  protectSession(window.webContents.session);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== entryUrl) event.preventDefault();
  });
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || event.url !== entryUrl) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  );
  window.once('ready-to-show', () => window.show());
  return window;
}
