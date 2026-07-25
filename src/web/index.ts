/**
 * src/web/ barrel — 本地服务器接入层
 *
 * 零依赖 node:http server，给前端提供真实数据（包一层 SessionStore）。
 * 只绑 127.0.0.1（local-first）。
 */

export { WebServer, startWebServer } from './server.js';
export type { WebServerOptions, ListenInfo } from './server.js';
