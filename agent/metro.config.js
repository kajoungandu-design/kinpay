// Le code partagé avec l'application client (client HTTP, formats, téléphone, QR) vit dans ../app/src/core.
// Ces fichiers n'importent aucun paquet : pas de risque de charger deux copies de React.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../app/src/core')];
module.exports = config;
