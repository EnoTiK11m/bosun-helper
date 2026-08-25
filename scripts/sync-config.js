'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const {
  ConfigSyncError,
  synchronizeConfiguration
} = require('./config-sync');

const root = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'local';

function assertPublicTargetsUnstaged() {
  const result = spawnSync(
    'git',
    ['diff', '--cached', '--quiet', '--', 'config.js', 'manifest.json'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: 'ignore'
    }
  );
  if (result.error || result.status === null || result.status > 1) {
    throw new ConfigSyncError('The Git index could not be verified.');
  }
  if (result.status === 1) {
    throw new ConfigSyncError(
      'config.js or manifest.json has staged changes. Unstage them, rerun prepare-commit, then stage the reviewed public files.'
    );
  }
}

try {
  if (mode === 'local') {
    synchronizeConfiguration({
      rootDir: root,
      sourceFilename: 'config.local.js'
    });
    console.log('config.js and manifest.json were synchronized from config.local.js');
  } else if (mode === 'public') {
    assertPublicTargetsUnstaged();
    synchronizeConfiguration({
      rootDir: root,
      sourceFilename: 'config.example.js',
      verifyPublic: true
    });
    assertPublicTargetsUnstaged();
    console.log('Public commit configuration prepared.');
    console.log('Review config.js and manifest.json before staging.');
    console.log('Run "npm run sync-config" after the commit to restore local runtime configuration.');
  } else {
    throw new ConfigSyncError('Unknown configuration synchronization mode.');
  }
} catch (error) {
  const message = error instanceof ConfigSyncError
    ? error.message
    : 'Unexpected configuration synchronization failure.';
  console.error(`Configuration synchronization failed: ${message}`);
  process.exitCode = 1;
}
