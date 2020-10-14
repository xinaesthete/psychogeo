const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');
//temporary... hopefully introduce config file & interface soon...
const sourceFolder = "C:/Users/peter/Dropbox/BlenderGIS/pyUtil/images/web/";

contextBridge.exposeInMainWorld('electron', {
    //XXX: should really restrict access for security
    readTile: async tileName => {
        try {
            const fileName = path.join(sourceFolder, tileName.substring(5));
            // const f = await fs.promises.readFile(fileName);
            // at some point I was having trouble with async & resorted to this,
            // seems to've mysteriously fixed itself :? Or not.
            const f = fs.readFileSync(fileName);
            return f;
        } catch (e) {
            console.log('error in readTile: ' + e);
            throw(e);
        }
    },
    ping: 42
});
