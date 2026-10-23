import product from './product.config.json' with { type: 'json' };

/** Product identity (placeholders). The only place to change name/appId is product.config.json. */
export interface ProductConfig {
  productName: string;
  appId: string;
  executableName: string;
  keychainService: string;
  protocolScheme: string;
  cliConfigDir: string;
  upstream: { name: string; author: string; repo: string; license: string };
  /** Public source URL once the repo is opened (AGPL §13); null while private. */
  sourceUrl: string | null;
}
export const PRODUCT: Readonly<ProductConfig> = Object.freeze(product as ProductConfig);
