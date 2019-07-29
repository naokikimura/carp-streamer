import BoxSDK from 'box-node-sdk';
import BoxClient from 'box-node-sdk/lib/box-client';
import { AppConfig } from 'box-node-sdk/lib/box-node-sdk';
import { TokenInfo } from 'box-node-sdk/lib/token-manager';

interface BoxClientConfiguration {
  kind: 'Basic' | 'Persistent' | 'AppAuth' | 'Anonymous';
  configurator?: (client: BoxClient) => void;
}

interface BoxBasicClientConfig extends BoxClientConfiguration {
  kind: 'Basic';
  accessToken: string;
}

interface BoxPersistentClientConfig extends BoxClientConfiguration {
  kind: 'Persistent';
  tokenInfo: TokenInfo;
}

interface BoxAppAuthClientConfig extends BoxClientConfiguration {
  kind: 'AppAuth';
  type: 'enterprise' | 'user';
  id?: string;
}

interface BoxAnonymousClientConfig extends BoxClientConfiguration {
  kind: 'Anonymous';
}

export type BoxClientConfig =
  BoxBasicClientConfig | BoxPersistentClientConfig | BoxAppAuthClientConfig | BoxAnonymousClientConfig;

const isBoxBasicClientConfig =
  (config: BoxClientConfig): config is BoxBasicClientConfig => config.kind === 'Basic';
const isBoxPersistentClientConfig =
  (config: BoxClientConfig): config is BoxPersistentClientConfig => config.kind === 'Persistent';
const isBoxAppAuthClientConfig =
  (config: BoxClientConfig): config is BoxAppAuthClientConfig => config.kind === 'AppAuth';
const isBoxAnonymousClientConfig =
  (config: BoxClientConfig): config is BoxAnonymousClientConfig => config.kind === 'Anonymous';

export default class BoxClientBuilder {
  private static build(sdk: BoxSDK, config: BoxClientConfig) {
    const client = (() => {
      if (isBoxBasicClientConfig(config)) {
        return sdk.getBasicClient(config.accessToken);
      } else if (isBoxPersistentClientConfig(config)) {
        return sdk.getPersistentClient(config.tokenInfo);
      } else if (isBoxAppAuthClientConfig(config)) {
        return sdk.getAppAuthClient(config.type, config.id);
      } else {
        return sdk.getAnonymousClient();
      }
    })();
    config.configurator && config.configurator(client);
    return client;
  }

  private sdk: BoxSDK;
  private config: BoxClientConfig;
  private client: BoxClient | undefined;

  constructor(appConfig?: AppConfig, clientConfig?: BoxClientConfig) {
    this.sdk = BoxSDK.getPreconfiguredInstance(appConfig || { boxAppSettings: { clientID: '', clientSecret: '' } });
    this.config = clientConfig || { kind: 'Anonymous' };
  }

  public build() {
    return this.client || (this.client = BoxClientBuilder.build(this.sdk, this.config));
  }
}
