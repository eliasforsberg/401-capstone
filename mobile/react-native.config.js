const path = require('path');

// In an npm workspace the packages are hoisted to the repo root.
// React Native's autolinking needs to know where to find them.
const root = path.resolve(__dirname, '..');

module.exports = {
  project: {
    ios: {},
    android: {},
  },
  // Point autolinking at the workspace root node_modules so native
  // packages like react-native-mmkv are discovered correctly.
  dependencies: {
    'react-native-mmkv': {
      root: path.join(root, 'node_modules/react-native-mmkv'),
    },
  },
};
