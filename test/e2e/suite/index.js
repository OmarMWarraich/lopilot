const path = require('node:path');
const Mocha = require('mocha');

exports.run = function run() {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000 });
  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} E2E test(s) failed.`));
        return;
      }

      resolve();
    });
  });
};