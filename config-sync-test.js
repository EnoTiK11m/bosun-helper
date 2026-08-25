'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  loadConfigFile,
  synchronizeConfiguration
} = require('./scripts/config-sync');

function createConfigSource(config) {
  return `globalThis.BosunHelperLocalConfig = ${JSON.stringify(config, null, 2)};\n`;
}

function createManifest() {
  return {
    manifest_version: 3,
    name: 'Synthetic extension',
    description: 'Preserve this functional change',
    content_scripts: [
      {
        matches: ['https://old-bosun.invalid/*'],
        js: ['config.js', 'content.js'],
        run_at: 'document_idle'
      },
      {
        matches: ['https://old-grafana.invalid/*'],
        js: ['config.js', 'grafana-content.js'],
        run_at: 'document_idle'
      }
    ],
    web_accessible_resources: [
      {
        resources: ['bosun_notification_alert_chime.wav'],
        matches: ['https://old-bosun.invalid/*']
      },
      {
        resources: ['grafana-page.js'],
        matches: ['https://old-grafana.invalid/*']
      }
    ],
    permissions: ['storage']
  };
}

function createWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-helper-config-sync-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(root, name),
      typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`,
      'utf8'
    );
  }
  return root;
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function run(root, command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8'
  });
}

function runGit(root, args) {
  const result = run(root, 'git', args);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result;
}

function installConfigCli(root) {
  const scriptsDirectory = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  for (const name of ['config-sync.js', 'sync-config.js']) {
    fs.copyFileSync(path.join(__dirname, 'scripts', name), path.join(scriptsDirectory, name));
  }
}

{
  const root = createWorkspace({
    'config.local.js': createConfigSource({
      bosunHosts: ['WORK.ONE.TEST', 'work.one.test', 'work.two.test:8443'],
      grafanaHost: 'grafana.work.test:8443',
      grafanaPanelUrl: 'https://grafana.work.test:8443/d/work/panel?editPanel=1'
    }),
    'config.js': createConfigSource({
      bosunHosts: ['stale.test'],
      grafanaHost: 'stale.test',
      grafanaPanelUrl: 'https://stale.test/'
    }),
    'manifest.json': createManifest()
  });

  try {
    synchronizeConfiguration({
      rootDir: root,
      sourceFilename: 'config.local.js'
    });

    const generated = loadConfigFile(path.join(root, 'config.js'));
    assert.deepStrictEqual(generated.bosunHosts, ['work.one.test', 'work.two.test:8443']);
    assert.strictEqual(generated.grafanaHost, 'grafana.work.test:8443');
    assert.strictEqual(
      generated.grafanaPanelUrl,
      'https://grafana.work.test:8443/d/work/panel?editPanel=1'
    );

    const manifest = readManifest(root);
    assert.deepStrictEqual(
      manifest.content_scripts[0].matches,
      ['https://work.one.test/*', 'https://work.two.test/*'],
      'Bosun manifest matches must be normalized and deduplicated'
    );
    assert.deepStrictEqual(
      manifest.content_scripts[1].matches,
      ['https://grafana.work.test/*']
    );
  } finally {
    cleanup(root);
  }
}

{
  const localHost = 'private-runtime.internal.test';
  const localGrafanaHost = 'private-grafana.internal.test';
  const exampleConfig = {
    bosunHosts: ['bosun.example.com', 'bosun-stage.example.com'],
    grafanaHost: 'grafana.example.com',
    grafanaPanelUrl: 'https://grafana.example.com/d/example/panel?editPanel=1'
  };
  const manifest = createManifest();
  manifest.version = '9.9.9';
  manifest.content_scripts[0].exclude_matches = ['https://excluded.example.com/*'];
  manifest.content_scripts[0].matches = [`https://${localHost}/*`];
  manifest.content_scripts[1].matches = [`https://${localGrafanaHost}/*`];
  manifest.web_accessible_resources[0].matches = [`https://${localHost}/*`];
  manifest.web_accessible_resources[1].matches = [`https://${localGrafanaHost}/*`];

  const root = createWorkspace({
    'config.local.js': createConfigSource({
      bosunHosts: [localHost],
      grafanaHost: localGrafanaHost,
      grafanaPanelUrl: `https://${localGrafanaHost}/d/private/panel?editPanel=1`
    }),
    'config.example.js': createConfigSource(exampleConfig),
    'config.js': createConfigSource({
      bosunHosts: [localHost],
      grafanaHost: localGrafanaHost,
      grafanaPanelUrl: `https://${localGrafanaHost}/d/private/panel?editPanel=1`
    }),
    'manifest.json': manifest
  });

  try {
    synchronizeConfiguration({
      rootDir: root,
      sourceFilename: 'config.example.js',
      verifyPublic: true
    });

    assert.deepStrictEqual(loadConfigFile(path.join(root, 'config.js')), exampleConfig);
    const generatedManifest = readManifest(root);
    assert.strictEqual(generatedManifest.version, '9.9.9');
    assert.deepStrictEqual(
      generatedManifest.content_scripts[0].exclude_matches,
      ['https://excluded.example.com/*'],
      'Unrelated manifest changes must survive synchronization'
    );
    assert.deepStrictEqual(
      generatedManifest.content_scripts[0].matches,
      ['https://bosun.example.com/*', 'https://bosun-stage.example.com/*']
    );
    assert.deepStrictEqual(
      generatedManifest.content_scripts[1].matches,
      ['https://grafana.example.com/*']
    );

    const publicFiles = [
      fs.readFileSync(path.join(root, 'config.js'), 'utf8'),
      fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')
    ].join('\n').toLowerCase();
    assert.ok(!publicFiles.includes(localHost));
    assert.ok(!publicFiles.includes(localGrafanaHost));
    assert.ok(!publicFiles.includes('/d/private/panel'));
  } finally {
    cleanup(root);
  }
}

for (const invalidConfig of [
  {
    bosunHosts: [],
    grafanaHost: 'grafana.example.test',
    grafanaPanelUrl: 'https://grafana.example.test/d/example/panel'
  },
  {
    bosunHosts: ['bosun.example.test'],
    grafanaHost: 'grafana.example.test',
    grafanaPanelUrl: 'https://different-grafana.example.test/d/example/panel'
  }
]) {
  const manifestSource = `${JSON.stringify(createManifest(), null, 2)}\n`;
  const originalConfigSource = createConfigSource({
    bosunHosts: ['unchanged.example.test'],
    grafanaHost: 'unchanged.example.test',
    grafanaPanelUrl: 'https://unchanged.example.test/'
  });
  const root = createWorkspace({
    'invalid-source.js': createConfigSource(invalidConfig),
    'config.js': originalConfigSource,
    'manifest.json': manifestSource
  });

  try {
    assert.throws(
      () => synchronizeConfiguration({
        rootDir: root,
        sourceFilename: 'invalid-source.js'
      }),
      /configuration|bosunHosts|Grafana/i
    );
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), originalConfigSource);
    assert.strictEqual(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), manifestSource);
  } finally {
    cleanup(root);
  }
}

{
  const secretMarker = 'do-not-print-this-local-value';
  const manifestSource = `${JSON.stringify(createManifest(), null, 2)}\n`;
  const originalConfigSource = createConfigSource({
    bosunHosts: ['unchanged.example.test'],
    grafanaHost: 'unchanged.example.test',
    grafanaPanelUrl: 'https://unchanged.example.test/'
  });
  const root = createWorkspace({
    'executable-source.js': `globalThis.BosunHelperLocalConfig = { bosunHosts: ['safe.example.test'] };\nthrow new Error('${secretMarker}');\n`,
    'config.js': originalConfigSource,
    'manifest.json': manifestSource
  });

  try {
    assert.throws(
      () => synchronizeConfiguration({
        rootDir: root,
        sourceFilename: 'executable-source.js'
      }),
      (error) => !error.message.includes(secretMarker) && /declarative|syntax/i.test(error.message)
    );
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), originalConfigSource);
    assert.strictEqual(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), manifestSource);
  } finally {
    cleanup(root);
  }
}

{
  const localHost = 'leaked-local.internal.test';
  const manifest = createManifest();
  manifest.description = `Unrelated field with ${localHost}`;
  const originalManifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  const originalConfigSource = createConfigSource({
    bosunHosts: [localHost],
    grafanaHost: 'leaked-grafana.internal.test',
    grafanaPanelUrl: 'https://leaked-grafana.internal.test/d/private/panel'
  });
  const root = createWorkspace({
    'config.local.js': originalConfigSource,
    'config.example.js': createConfigSource({
      bosunHosts: ['bosun.example.com'],
      grafanaHost: 'grafana.example.com',
      grafanaPanelUrl: 'https://grafana.example.com/d/example/panel'
    }),
    'config.js': originalConfigSource,
    'manifest.json': originalManifestSource
  });

  try {
    assert.throws(
      () => synchronizeConfiguration({
        rootDir: root,
        sourceFilename: 'config.example.js',
        verifyPublic: true
      }),
      /Local configuration values remain/i
    );
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), originalConfigSource);
    assert.strictEqual(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), originalManifestSource);
  } finally {
    cleanup(root);
  }
}

{
  const manifest = createManifest();
  manifest.description = 'A stale URL must be rejected: https://retired-private.corp.test/dashboard';
  const originalManifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  const originalConfigSource = createConfigSource({
    bosunHosts: ['current-private.internal.test'],
    grafanaHost: 'current-grafana.internal.test',
    grafanaPanelUrl: 'https://current-grafana.internal.test/d/current/panel'
  });
  const root = createWorkspace({
    'config.local.js': originalConfigSource,
    'config.example.js': createConfigSource({
      bosunHosts: ['bosun.example.com'],
      grafanaHost: 'grafana.example.com',
      grafanaPanelUrl: 'https://grafana.example.com/d/example/panel'
    }),
    'config.js': originalConfigSource,
    'manifest.json': originalManifestSource
  });

  try {
    assert.throws(
      () => synchronizeConfiguration({
        rootDir: root,
        sourceFilename: 'config.example.js',
        verifyPublic: true
      }),
      /non-example URL host/i
    );
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), originalConfigSource);
    assert.strictEqual(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), originalManifestSource);
  } finally {
    cleanup(root);
  }
}

{
  const privateExampleHost = 'not-public.internal.test';
  const manifestSource = `${JSON.stringify(createManifest(), null, 2)}\n`;
  const originalConfigSource = createConfigSource({
    bosunHosts: ['current-private.internal.test'],
    grafanaHost: 'current-grafana.internal.test',
    grafanaPanelUrl: 'https://current-grafana.internal.test/d/current/panel'
  });
  const root = createWorkspace({
    'config.local.js': originalConfigSource,
    'config.example.js': createConfigSource({
      bosunHosts: [privateExampleHost],
      grafanaHost: privateExampleHost,
      grafanaPanelUrl: `https://${privateExampleHost}/d/private/panel`
    }),
    'config.js': originalConfigSource,
    'manifest.json': manifestSource
  });

  try {
    assert.throws(
      () => synchronizeConfiguration({
        rootDir: root,
        sourceFilename: 'config.example.js',
        verifyPublic: true
      }),
      (error) => /example domains/i.test(error.message) && !error.message.includes(privateExampleHost)
    );
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), originalConfigSource);
    assert.strictEqual(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), manifestSource);
  } finally {
    cleanup(root);
  }
}

{
  const wildcardPrivateHost = 'wildcard-private.corp.test';
  const manifest = createManifest();
  manifest.host_permissions = [`*://${wildcardPrivateHost}/*`];
  const originalManifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  const originalConfigSource = createConfigSource({
    bosunHosts: ['current-private.internal.test'],
    grafanaHost: 'current-grafana.internal.test',
    grafanaPanelUrl: 'https://current-grafana.internal.test/d/current/panel'
  });
  const root = createWorkspace({
    'config.local.js': originalConfigSource,
    'config.example.js': createConfigSource({
      bosunHosts: ['bosun.example.com'],
      grafanaHost: 'grafana.example.com',
      grafanaPanelUrl: 'https://grafana.example.com/d/example/panel'
    }),
    'config.js': originalConfigSource,
    'manifest.json': originalManifestSource
  });

  try {
    assert.throws(
      () => synchronizeConfiguration({
        rootDir: root,
        sourceFilename: 'config.example.js',
        verifyPublic: true
      }),
      (error) => /HTTPS|non-example/i.test(error.message) &&
        !error.message.includes(wildcardPrivateHost)
    );
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), originalConfigSource);
    assert.strictEqual(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), originalManifestSource);
  } finally {
    cleanup(root);
  }
}

{
  const manifestSource = `${JSON.stringify(createManifest(), null, 2)}\n`;
  const originalConfigSource = createConfigSource({
    bosunHosts: ['rollback-local.example.test'],
    grafanaHost: 'rollback-grafana.example.test',
    grafanaPanelUrl: 'https://rollback-grafana.example.test/d/local/panel'
  });
  const root = createWorkspace({
    'source.js': createConfigSource({
      bosunHosts: ['rollback-public.example.test'],
      grafanaHost: 'rollback-public-grafana.example.test',
      grafanaPanelUrl: 'https://rollback-public-grafana.example.test/d/public/panel'
    }),
    'config.js': originalConfigSource,
    'manifest.json': manifestSource
  });
  const originalWriteFileSync = fs.writeFileSync;
  let injectedFailure = false;

  try {
    fs.writeFileSync = function injectedWrite(filename, ...args) {
      if (!injectedFailure && path.basename(filename) === 'manifest.json') {
        injectedFailure = true;
        throw new Error('synthetic write failure');
      }
      return originalWriteFileSync.call(fs, filename, ...args);
    };
    assert.throws(
      () => synchronizeConfiguration({
        rootDir: root,
        sourceFilename: 'source.js'
      }),
      /could not be updated/i
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  try {
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), originalConfigSource);
    assert.strictEqual(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), manifestSource);
  } finally {
    cleanup(root);
  }
}

{
  const firstLocalHost = 'first-private.internal.test';
  const stagedLocalHost = 'staged-private.internal.test';
  const localGrafanaHost = 'private-grafana.internal.test';
  const manifest = createManifest();
  manifest.content_scripts[0].matches = [`https://${firstLocalHost}/*`];
  manifest.content_scripts[1].matches = [`https://${localGrafanaHost}/*`];
  manifest.web_accessible_resources[0].matches = [`https://${firstLocalHost}/*`];
  manifest.web_accessible_resources[1].matches = [`https://${localGrafanaHost}/*`];
  const root = createWorkspace({
    'config.local.js': createConfigSource({
      bosunHosts: [firstLocalHost],
      grafanaHost: localGrafanaHost,
      grafanaPanelUrl: `https://${localGrafanaHost}/d/private/panel`
    }),
    'config.example.js': createConfigSource({
      bosunHosts: ['bosun.example.com'],
      grafanaHost: 'grafana.example.com',
      grafanaPanelUrl: 'https://grafana.example.com/d/example/panel'
    }),
    'config.js': createConfigSource({
      bosunHosts: [firstLocalHost],
      grafanaHost: localGrafanaHost,
      grafanaPanelUrl: `https://${localGrafanaHost}/d/private/panel`
    }),
    'manifest.json': manifest
  });

  try {
    installConfigCli(root);
    runGit(root, ['init', '--quiet']);
    runGit(root, ['config', 'user.name', 'Synthetic Test']);
    runGit(root, ['config', 'user.email', 'synthetic@example.com']);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '--quiet', '-m', 'synthetic baseline']);

    const publicResult = run(root, process.execPath, ['scripts/sync-config.js', 'public']);
    assert.strictEqual(publicResult.status, 0, publicResult.stderr || publicResult.stdout);
    assert.match(publicResult.stdout, /Public commit configuration prepared/);
    assert.deepStrictEqual(
      loadConfigFile(path.join(root, 'config.js')),
      loadConfigFile(path.join(root, 'config.example.js')),
      'The public CLI must use config.example.js'
    );

    fs.writeFileSync(path.join(root, 'config.local.js'), createConfigSource({
      bosunHosts: [stagedLocalHost],
      grafanaHost: localGrafanaHost,
      grafanaPanelUrl: `https://${localGrafanaHost}/d/private/panel`
    }));
    const localResult = run(root, process.execPath, ['scripts/sync-config.js', 'local']);
    assert.strictEqual(localResult.status, 0, localResult.stderr || localResult.stdout);
    runGit(root, ['add', 'config.js', 'manifest.json']);
    const stagedConfigSource = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
    const stagedManifestSource = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');

    const blockedResult = run(root, process.execPath, ['scripts/sync-config.js', 'public']);
    assert.strictEqual(blockedResult.status, 1, 'Public CLI must reject staged generated files');
    assert.match(blockedResult.stderr, /has staged changes/i);
    assert.ok(!blockedResult.stderr.includes(stagedLocalHost));
    assert.ok(!blockedResult.stderr.includes(localGrafanaHost));
    assert.strictEqual(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), stagedConfigSource);
    assert.strictEqual(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), stagedManifestSource);
  } finally {
    cleanup(root);
  }
}

console.log('Config synchronization tests passed');
