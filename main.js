// main.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1200,
        minHeight: 800,
        frame: false, // Frame is false so we implement a custom titlebar
        titleBarStyle: 'hidden',
        webPreferences: {
            contextIsolation: false, // For simplicity in renderer require
            nodeIntegration: true,   // To use crypto module natively
            webSecurity: false       // Bypass CORS for local API access
        },
    });

    win.loadFile('index.html');
}

// Window control signals
ipcMain.on('minimize-window', (event) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.minimize();
});

ipcMain.on('close-window', (event) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.close();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});