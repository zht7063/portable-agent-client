import committed from '../../build/server-origin.json';
declare const __SERVER_ORIGIN__: string;
/** Fixed at build time; JSON fallback exists only for unbundled unit tests. */
export const SERVER_ORIGIN = typeof __SERVER_ORIGIN__ === 'string' ? __SERVER_ORIGIN__ : committed.origin;
