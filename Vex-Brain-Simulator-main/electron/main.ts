import { app, BrowserWindow, Menu } from 'electron';
import * as path from 'path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'VEX Brain Simulator',
    backgroundColor: '#14171c',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  Menu.setApplicationMenu(null);
  void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
