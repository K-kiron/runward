import { createClient } from './client.mjs';
import { mountPage } from './view.mjs';

export function activate(host) {
  if (host?.apiVersion !== '1' || typeof host.registerPage !== 'function' || typeof host.agentServer?.request !== 'function') {
    throw new Error('Runward requires Canvas host API 1 with an authenticated Agent Server request helper.');
  }
  return host.registerPage('timeline', ({ container }) => mountPage({
    container,
    client: createClient(options => host.agentServer.request(options)),
    backendLabel: typeof host.backend?.id === 'string' ? host.backend.id : 'Active backend',
  }));
}
