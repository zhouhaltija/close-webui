import { setupWorker } from 'msw/browser';
import { Repository } from './repository';
import { createMockService, type Scenario } from './handlers';
import { runtime, useRuntime } from '../core/runtime';

export async function startMock() {
  const storage = { getItem: (key: string) => window.localStorage.getItem(key), setItem: (key: string, value: string) => window.localStorage.setItem(key, value) };
  const repo = new Repository(storage, (blocked, warning) => useRuntime.setState({ blocked, warning }));
  useRuntime.setState({ blocked: repo.blocked, warning: repo.warning });
  // Capture the scenario once so navigation to a chat does not lose the query override.
  const selected = new URLSearchParams(location.search).get('mockScenario') || import.meta.env.VITE_MOCK_SCENARIO || 'normal';
  const scenario: Scenario = selected === 'slow' || selected === 'failure' ? selected : 'normal';
  const service = createMockService(repo, () => scenario);
  runtime.install({ reset: () => repo.reset(), terminate: service.terminate });
  const worker = setupWorker(...service.handlers);
  await worker.start({ quiet: true, onUnhandledRequest: 'bypass', serviceWorker: { url: '/mockServiceWorker.js' } });
}
