'use strict';

const fs = require('fs');
const path = require('path');

class ConfigSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigSyncError';
  }
}

function ensure(condition, message) {
  if (!condition) throw new ConfigSyncError(message);
}

function extractConfigLiteral(source, filename) {
  const bareAssignment = /^\s*globalThis\s*\.\s*BosunHelperLocalConfig\s*=\s*([\s\S]*?)\s*;?\s*$/;
  const wrappedAssignment = /^\s*\(\s*\(\s*\)\s*=>\s*\{\s*(?:['"]use strict['"]\s*;\s*)?globalThis\s*\.\s*BosunHelperLocalConfig\s*=\s*([\s\S]*?)\s*;\s*\}\s*\)\s*\(\s*\)\s*;?\s*$/;
  const match = source.match(wrappedAssignment) || source.match(bareAssignment);
  ensure(match, `${path.basename(filename)} must contain only a declarative BosunHelperLocalConfig assignment.`);
  return match[1];
}

class ConfigLiteralParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  fail() {
    throw new ConfigSyncError('Configuration object syntax is invalid.');
  }

  skipWhitespaceAndComments() {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index])) {
        this.index += 1;
      } else if (this.source.startsWith('//', this.index)) {
        const newline = this.source.indexOf('\n', this.index + 2);
        this.index = newline < 0 ? this.source.length : newline + 1;
      } else if (this.source.startsWith('/*', this.index)) {
        const end = this.source.indexOf('*/', this.index + 2);
        if (end < 0) this.fail();
        this.index = end + 2;
      } else {
        break;
      }
    }
  }

  consume(character) {
    this.skipWhitespaceAndComments();
    if (this.source[this.index] !== character) this.fail();
    this.index += 1;
  }

  parseString() {
    this.skipWhitespaceAndComments();
    const quote = this.source[this.index];
    if (quote !== "'" && quote !== '"') this.fail();
    this.index += 1;
    let value = '';

    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === quote) return value;
      if (character === '\n' || character === '\r') this.fail();
      if (character !== '\\') {
        value += character;
        continue;
      }

      if (this.index >= this.source.length) this.fail();
      const escaped = this.source[this.index++];
      const simpleEscapes = {
        "'": "'",
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v'
      };
      if (Object.hasOwn(simpleEscapes, escaped)) {
        value += simpleEscapes[escaped];
      } else if (escaped === 'x') {
        const hex = this.source.slice(this.index, this.index + 2);
        if (!/^[0-9a-f]{2}$/i.test(hex)) this.fail();
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 2;
      } else if (escaped === 'u') {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9a-f]{4}$/i.test(hex)) this.fail();
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 4;
      } else {
        this.fail();
      }
    }

    this.fail();
  }

  parseKey() {
    this.skipWhitespaceAndComments();
    if (this.source[this.index] === "'" || this.source[this.index] === '"') {
      return this.parseString();
    }
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.source.slice(this.index));
    if (!match) this.fail();
    this.index += match[0].length;
    return match[0];
  }

  parseArray() {
    const values = [];
    this.consume('[');
    this.skipWhitespaceAndComments();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return values;
    }

    while (true) {
      values.push(this.parseString());
      this.skipWhitespaceAndComments();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return values;
      }
      this.consume(',');
      this.skipWhitespaceAndComments();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return values;
      }
    }
  }

  parseValue() {
    this.skipWhitespaceAndComments();
    if (this.source[this.index] === '[') return this.parseArray();
    return this.parseString();
  }

  parseObject() {
    const result = Object.create(null);
    this.consume('{');
    this.skipWhitespaceAndComments();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return result;
    }

    while (true) {
      const key = this.parseKey();
      ensure(!Object.hasOwn(result, key), 'Configuration contains a duplicate key.');
      this.consume(':');
      result[key] = this.parseValue();
      this.skipWhitespaceAndComments();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return result;
      }
      this.consume(',');
      this.skipWhitespaceAndComments();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return result;
      }
    }
  }

  parse() {
    const config = this.parseObject();
    this.skipWhitespaceAndComments();
    if (this.index !== this.source.length) this.fail();
    return config;
  }
}

function parseConfigSource(source, filename) {
  try {
    return new ConfigLiteralParser(extractConfigLiteral(source, filename)).parse();
  } catch (error) {
    if (error instanceof ConfigSyncError) throw error;
    throw new ConfigSyncError(`${path.basename(filename)} is not valid declarative configuration.`);
  }
}

function parseUrl(value, message) {
  try {
    return new URL(value);
  } catch (_error) {
    throw new ConfigSyncError(message);
  }
}

function normalizeConfig(config) {
  ensure(config && typeof config === 'object', 'BosunHelperLocalConfig was not defined.');
  const allowedKeys = new Set(['bosunHosts', 'grafanaHost', 'grafanaPanelUrl']);
  ensure(
    Object.keys(config).every((key) => allowedKeys.has(key)),
    'Configuration contains an unsupported key.'
  );
  ensure(Array.isArray(config.bosunHosts) && config.bosunHosts.length > 0, 'bosunHosts is empty.');

  const hostPattern = /^[a-z0-9.-]+(?::\d+)?$/;
  const bosunHosts = Array.from(new Set(config.bosunHosts.map((host) => {
    ensure(typeof host === 'string', 'A Bosun host is invalid.');
    const normalized = host.trim().toLowerCase();
    ensure(normalized.length > 0 && hostPattern.test(normalized), 'A Bosun host is invalid.');
    return normalized;
  })));

  ensure(typeof config.grafanaHost === 'string', 'The Grafana host is invalid.');
  const grafanaHost = config.grafanaHost.trim().toLowerCase();
  ensure(grafanaHost.length > 0 && hostPattern.test(grafanaHost), 'The Grafana host is invalid.');

  ensure(typeof config.grafanaPanelUrl === 'string', 'The Grafana panel URL is invalid.');
  const grafanaPanelUrl = parseUrl(
    config.grafanaPanelUrl.trim(),
    'The Grafana panel URL is invalid.'
  );
  ensure(grafanaPanelUrl.protocol === 'https:', 'Grafana URL must use HTTPS.');
  ensure(!grafanaPanelUrl.username && !grafanaPanelUrl.password, 'Grafana URL must not contain credentials.');
  ensure(grafanaPanelUrl.host.toLowerCase() === grafanaHost, 'Grafana URL host mismatch.');

  return {
    bosunHosts,
    grafanaHost,
    grafanaPanelUrl: grafanaPanelUrl.toString()
  };
}

function loadConfigFile(filename) {
  ensure(fs.existsSync(filename), `${path.basename(filename)} is missing.`);

  let source;
  try {
    source = fs.readFileSync(filename, 'utf8');
  } catch (_error) {
    throw new ConfigSyncError(`${path.basename(filename)} could not be read.`);
  }

  return normalizeConfig(parseConfigSource(source, filename));
}

function loadConfigSource(source, filename = 'config.js') {
  return normalizeConfig(parseConfigSource(source, filename));
}

function hostToMatchPattern(host) {
  const hostname = parseUrl(`https://${host}`, 'A configured host is invalid.').hostname;
  return `https://${hostname}/*`;
}

function expectedManifestMatches(config) {
  return {
    bosun: Array.from(new Set(config.bosunHosts.map(hostToMatchPattern))),
    grafana: [hostToMatchPattern(config.grafanaHost)]
  };
}

function findOwnedEntry(entries, predicate, missingMessage, ambiguousMessage) {
  const owned = entries.filter(predicate);
  ensure(owned.length > 0, missingMessage);
  ensure(owned.length === 1, ambiguousMessage);
  return owned[0];
}

function getHostDependentEntries(manifest) {
  ensure(Array.isArray(manifest.content_scripts), 'Manifest content_scripts is missing.');
  ensure(Array.isArray(manifest.web_accessible_resources), 'Manifest web_accessible_resources is missing.');

  const entries = {
    bosunContent: findOwnedEntry(
      manifest.content_scripts,
      (entry) => Array.isArray(entry.js) && entry.js.includes('content.js'),
      'Bosun content script entry is missing.',
      'Bosun content script entry is ambiguous.'
    ),
    grafanaContent: findOwnedEntry(
      manifest.content_scripts,
      (entry) => Array.isArray(entry.js) && entry.js.includes('grafana-content.js'),
      'Grafana content script entry is missing.',
      'Grafana content script entry is ambiguous.'
    ),
    bosunResources: findOwnedEntry(
      manifest.web_accessible_resources,
      (entry) => Array.isArray(entry.resources) &&
        entry.resources.some((resource) => resource === 'bosun_notification_alert_chime.wav'),
      'Audio resource entry is missing.',
      'Audio resource entry is ambiguous.'
    ),
    grafanaResources: findOwnedEntry(
      manifest.web_accessible_resources,
      (entry) => Array.isArray(entry.resources) && entry.resources.includes('grafana-page.js'),
      'Grafana bridge resource entry is missing.',
      'Grafana bridge resource entry is ambiguous.'
    )
  };
  ensure(entries.bosunContent !== entries.grafanaContent, 'Manifest content script roles overlap.');
  ensure(entries.bosunResources !== entries.grafanaResources, 'Manifest resource roles overlap.');
  ensure(entries.bosunContent.js.includes('config.js'), 'Bosun content script config entry is missing.');
  ensure(entries.grafanaContent.js.includes('config.js'), 'Grafana content script config entry is missing.');
  return entries;
}

function updateManifest(manifest, config) {
  const entries = getHostDependentEntries(manifest);
  const matches = expectedManifestMatches(config);
  entries.bosunContent.matches = matches.bosun.slice();
  entries.grafanaContent.matches = matches.grafana.slice();
  entries.bosunResources.matches = matches.bosun.slice();
  entries.grafanaResources.matches = matches.grafana.slice();
  return manifest;
}

function buildConfigSource(config) {
  return `(() => {
  'use strict';

  globalThis.BosunHelperLocalConfig = ${JSON.stringify(config, null, 2)};
})();
`;
}

function parseManifest(source) {
  try {
    return JSON.parse(source);
  } catch (_error) {
    throw new ConfigSyncError('manifest.json is not valid JSON.');
  }
}

function configsEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function arraysEqual(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function verifyGeneratedContents(configSource, manifestSource, expectedConfig) {
  const actualConfig = loadConfigSource(configSource);
  ensure(
    configsEqual(actualConfig, expectedConfig),
    'Generated config.js does not match the normalized source configuration.'
  );

  const manifest = parseManifest(manifestSource);
  const entries = getHostDependentEntries(manifest);
  const expected = expectedManifestMatches(expectedConfig);
  ensure(
    arraysEqual(entries.bosunContent.matches, expected.bosun) &&
      arraysEqual(entries.bosunResources.matches, expected.bosun),
    'Bosun manifest matches do not match the source configuration.'
  );
  ensure(
    arraysEqual(entries.grafanaContent.matches, expected.grafana) &&
      arraysEqual(entries.grafanaResources.matches, expected.grafana),
    'Grafana manifest matches do not match the source configuration.'
  );
}

function collectConfigLiterals(config) {
  const literals = new Set();
  const addHost = (host) => {
    literals.add(host.toLowerCase());
    literals.add(parseUrl(`https://${host}`, 'A configured host is invalid.').hostname.toLowerCase());
  };

  for (const host of config.bosunHosts) addHost(host);
  addHost(config.grafanaHost);

  const panelUrl = parseUrl(config.grafanaPanelUrl, 'The Grafana panel URL is invalid.');
  literals.add(panelUrl.toString().toLowerCase());
  literals.add(panelUrl.origin.toLowerCase());
  if (panelUrl.pathname.length >= 4) literals.add(panelUrl.pathname.toLowerCase());
  if (panelUrl.search.length >= 4) literals.add(panelUrl.search.toLowerCase());
  for (const segment of panelUrl.pathname.split('/')) {
    if (segment.length >= 4) literals.add(segment.toLowerCase());
  }
  for (const value of panelUrl.searchParams.values()) {
    if (value.length >= 4) literals.add(value.toLowerCase());
  }
  return literals;
}

function verifyNoLocalConfigValues(configSource, manifestSource, localConfigs, publicConfig) {
  const publicLiterals = collectConfigLiterals(publicConfig);
  const candidate = `${configSource}\n${manifestSource}`.toLowerCase();
  for (const localConfig of localConfigs) {
    for (const literal of collectConfigLiterals(localConfig)) {
      if (!publicLiterals.has(literal) && candidate.includes(literal)) {
        throw new ConfigSyncError('Local configuration values remain in generated public files.');
      }
    }
  }
}

function isReservedExampleHost(host) {
  return /(?:^|\.)example\.(?:com|net|org)$/.test(host);
}

function verifyPublicConfigHosts(publicConfig) {
  for (const host of [...publicConfig.bosunHosts, publicConfig.grafanaHost]) {
    const hostname = parseUrl(`https://${host}`, 'A configured host is invalid.').hostname.toLowerCase();
    ensure(isReservedExampleHost(hostname), 'Public source configuration must use example domains.');
  }
}

function verifyPublicUrlHosts(manifestSource, publicConfig) {
  const allowedHosts = new Set([
    ...publicConfig.bosunHosts.map((host) => hostToMatchPattern(host).slice(8, -2)),
    hostToMatchPattern(publicConfig.grafanaHost).slice(8, -2)
  ]);
  const manifest = parseManifest(manifestSource);
  const matchPatternKeys = new Set([
    'matches',
    'exclude_matches',
    'host_permissions',
    'optional_host_permissions'
  ]);

  const verifyAllowedHost = (hostname) => {
    const normalized = hostname.toLowerCase();
    ensure(
      allowedHosts.has(normalized) || isReservedExampleHost(normalized),
      'Manifest contains a non-example URL host.'
    );
  };

  const verifyMatchPattern = (pattern) => {
    ensure(typeof pattern === 'string', 'Manifest contains an invalid match pattern.');
    ensure(pattern !== '<all_urls>', 'Public manifest must not use <all_urls>.');
    const match = /^(https|\*):\/\/(\*\.)?([^/]+)\/.*$/i.exec(pattern);
    ensure(match, 'Manifest contains an invalid match pattern.');
    ensure(match[1].toLowerCase() === 'https', 'Public manifest match patterns must use HTTPS.');
    ensure(match[3] !== '*', 'Public manifest match patterns must use an explicit host.');
    const hostname = parseUrl(`https://${match[3]}`, 'Manifest contains an invalid match pattern.')
      .hostname;
    verifyAllowedHost(hostname);
  };

  const visit = (value, key = '') => {
    if (matchPatternKeys.has(key)) {
      ensure(Array.isArray(value), 'Manifest match patterns must be an array.');
      for (const pattern of value) verifyMatchPattern(pattern);
      return;
    }
    if (typeof value === 'string') {
      for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
        const url = parseUrl(match[0], 'Manifest contains an invalid URL.');
        ensure(url.protocol === 'https:', 'Public manifest URLs must use HTTPS.');
        verifyAllowedHost(url.hostname);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      for (const [childKey, item] of Object.entries(value)) visit(item, childKey);
    }
  };

  visit(manifest);
}

function verifyPublicContents(configSource, manifestSource, expectedConfig, localConfigs) {
  verifyPublicConfigHosts(expectedConfig);
  verifyGeneratedContents(configSource, manifestSource, expectedConfig);
  verifyNoLocalConfigValues(configSource, manifestSource, localConfigs, expectedConfig);
  verifyPublicUrlHosts(manifestSource, expectedConfig);
}

function synchronizeConfiguration(options) {
  const rootDir = path.resolve(options.rootDir);
  const sourcePath = path.join(rootDir, options.sourceFilename);
  const configPath = path.join(rootDir, 'config.js');
  const manifestPath = path.join(rootDir, 'manifest.json');
  const localConfigPath = path.join(rootDir, options.localFilename || 'config.local.js');

  const normalizedConfig = loadConfigFile(sourcePath);

  const configExisted = fs.existsSync(configPath);
  let originalConfigSource = null;
  let originalManifestSource;
  try {
    if (configExisted) originalConfigSource = fs.readFileSync(configPath, 'utf8');
    originalManifestSource = fs.readFileSync(manifestPath, 'utf8');
  } catch (_error) {
    throw new ConfigSyncError('Generated configuration files could not be read.');
  }

  const manifest = parseManifest(originalManifestSource);
  updateManifest(manifest, normalizedConfig);
  const nextConfigSource = buildConfigSource(normalizedConfig);
  const nextManifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  let localConfigs = [];
  if (options.verifyPublic) {
    ensure(fs.existsSync(localConfigPath), 'config.local.js is required for public verification.');
    localConfigs = [loadConfigFile(localConfigPath)];
    if (originalConfigSource !== null) {
      localConfigs.push(loadConfigSource(originalConfigSource));
    }
  }

  if (options.verifyPublic) {
    verifyPublicContents(nextConfigSource, nextManifestSource, normalizedConfig, localConfigs);
  } else {
    verifyGeneratedContents(nextConfigSource, nextManifestSource, normalizedConfig);
  }

  try {
    fs.writeFileSync(configPath, nextConfigSource, 'utf8');
    fs.writeFileSync(manifestPath, nextManifestSource, 'utf8');

    const writtenConfigSource = fs.readFileSync(configPath, 'utf8');
    const writtenManifestSource = fs.readFileSync(manifestPath, 'utf8');
    if (options.verifyPublic) {
      verifyPublicContents(writtenConfigSource, writtenManifestSource, normalizedConfig, localConfigs);
    } else {
      verifyGeneratedContents(writtenConfigSource, writtenManifestSource, normalizedConfig);
    }
  } catch (error) {
    try {
      if (configExisted) {
        fs.writeFileSync(configPath, originalConfigSource, 'utf8');
      } else if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }
      fs.writeFileSync(manifestPath, originalManifestSource, 'utf8');
    } catch (_rollbackError) {
      throw new ConfigSyncError('Configuration update failed and the original files could not be restored.');
    }

    if (error instanceof ConfigSyncError) throw error;
    throw new ConfigSyncError('Configuration files could not be updated.');
  }

  return normalizedConfig;
}

module.exports = {
  ConfigSyncError,
  buildConfigSource,
  expectedManifestMatches,
  loadConfigFile,
  normalizeConfig,
  synchronizeConfiguration,
  updateManifest,
  verifyGeneratedContents,
  verifyNoLocalConfigValues
};
