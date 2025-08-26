import { ProviderStrategy } from './strategies/ProviderStrategy';
import { AwsProviderStrategy } from './strategies/AwsProviderStrategy';
import { BareMetalProviderStrategy } from './strategies/BareMetalProviderStrategy';

export function createProviderStrategy(): ProviderStrategy {
  const ip = process.env.SERVER_IP;
  if (ip) {
    return new BareMetalProviderStrategy(ip);
  }
  return new AwsProviderStrategy();
}
