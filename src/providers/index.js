import { zhipuAdapter } from './zhipu-config.js';

const providers = Object.freeze({
  mock: {
    envKeys: [],
    configure: () => ({}),
    create: () => null,
    publicConfig: () => ({ endpoint: null, apiKeyConfigured: false }),
  },
  zhipu: zhipuAdapter,
});

export const providerNames = Object.freeze(Object.keys(providers));
export const providerEnvKeys = Object.freeze([...new Set(Object.values(providers).flatMap(provider => provider.envKeys))]);

export function getProvider(name) {
  if (!Object.hasOwn(providers, name)) throw new Error(`Unknown provider ${name}. Available providers: ${providerNames.join(', ')}.`);
  return providers[name];
}
