const { app, BrowserWindow } = require('electron')

const path = require('path')
const url = require('url')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      //NB: Now using WebPack target: web, so we don't need nodeIntegration here.
      //any interface with node modules should be established in electron-preload.js
      // nodeIntegration: true,
      // webSecurity: false,
      // allowRunningInsecureContent: true, //tried briefly to see if it'd allow WASM to compile, it didn't
      
      worldSafeExecuteJavaScript: true, //"will be enabled by default in electron 12"
      contextIsolation: true, //required for preload, but having it enabled stops Wasm compile in electron@10.
      preload: path.join(__dirname, '../public/electron-preload.js'),
    },
  })

  mainWindow.loadURL(
    process.env.ELECTRON_START_URL ||
      url.format({
        pathname: path.join(__dirname, '/../public/index.html'),
        protocol: 'file:',
        slashes: true,
      })
  )

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // //attempt to modify headers specifically to allow openjpegwasm to compile
  // //https://github.com/kwonoj/electron-hunspell/issues/410
  // //https://github.com/chrisknepper/android-messages-desktop/blob/e4514428d2478a539ecd81f4c8d73e91619f48d1/src/app.js#L35
  // const pre = process.env.ELECTRON_START_URL;
  // const jpegWasm = pre + '/public/openjpegwasm.wasm';
  // const jpegWasmJS = pre + '/public/openjpegwasm.js';
  // const wildURL = "*://*/openjpeg*";
  // const wilderURL = "*://*/*";
  // mainWindow.webContents.session.webRequest.onHeadersReceived({urls: [wildURL]}, (details, callback) => {
  //   callback({
  //     responseHeaders: {
  //       ...details.responseHeaders,
  //       //https://www.aaron-powell.com/posts/2019-11-27-using-webassembly-with-csp-headers/
  //       //https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src
  //       'Content-Security-Policy': [`script-src 'self' 'unsafe-eval'`] //"you must include the single quotes"
  //     }
  //   });
  // });
}

app.on('ready', createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})
