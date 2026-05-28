(() => {
  'use strict';

  globalThis.BosunHelperLocalConfig = {
    bosunHosts: ['bosun.example.com', 'bosun-test.example.com'],
    grafanaHost: 'grafana.example.com',
    grafanaPanelUrl: 'https://grafana.example.com/d/example/example?orgId=1&from=now-1h&to=now&timezone=browser&editPanel=1&refresh=30s'
  };
})();
