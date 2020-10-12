const { contextBridge } = require('electron');
const fs = require('fs');

contextBridge.exposeInMainWorld('electron', {
    //XXX: should really restrict access for security
    readFile: path => fs.promises.readFile(path),
    ping: 42
});
window.electron = { ping: "hello" } //we see '42', not this.
// fs.writeFile('preload_test.txt', "hello");