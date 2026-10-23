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
  /** AGPL-3.0 §6/§13 Corresponding Source location shown in About & licenses (placeholder: this repo). */
  sourceUrl: string | null;
  /** Human-readable source offer text shown next to sourceUrl (placeholder). */
  sourceOffer?: string;
}
export const PRODUCT: Readonly<ProductConfig> = Object.freeze(product as ProductConfig);
