const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { serverReady } = require('./index.js'); // ambil serverReady

let mainWindow;

async function createWindow() {
    const port = await serverReady; // tunggu server siap

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets/icon.png') // Optional
    });

    // Load the dashboard
    mainWindow.loadFile('login.html');

        // kirim port ke frontend (HTML)
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('server-port', port);
    });

    // Open DevTools (optional)
    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools();
    }


    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Handler untuk pilih file MBTiles
ipcMain.handle('select-mbtiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'MBTiles', extensions: ['mbtiles'] }]
    });

    if (result.canceled) return [];

    return result.filePaths.map(filePath => {
        const stats = fs.statSync(filePath);
        return {
            name: path.basename(filePath),
            path: filePath,
            size: stats.size
        };
    });
});

// Handler untuk XYZ
ipcMain.handle('select-xyz', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'XYZ Files', extensions: ['xyz'] }]
    });

    if (result.canceled) return [];

    return result.filePaths.map(filePath => {
        const stats = fs.statSync(filePath);
        return {
            name: path.basename(filePath),
            path: filePath,
            size: stats.size
        };
    });
});