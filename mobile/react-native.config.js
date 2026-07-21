const path = require('path');

module.exports = {
  project: {
    ios: {},
    android: {},
  },
  // Ensure react-native-mmkv is autolinked from the correct location.
  dependencies: {
    'react-native-mmkv': {
      root: path.join(__dirname, 'node_modules', 'react-native-mmkv'),
    },
  },
};
