/**
 * api 层的 fetch 基址。
 *
 * 浏览器里是 ''（相对路径，同源请求）；node 里（vite 中间件的 headless
 * runner 复用 agent 层时）是本机回环 + 端口——工具执行体走 HTTP 自调用，
 * 与浏览器完全同一执行面。端口由 vite.config.ts 启动时注入
 * globalThis.__WEBUI_PORT__，注入前回落 5180。
 */
export function apiBase(): string {
  if (typeof window !== 'undefined') return '';
  const port = (globalThis as { __WEBUI_PORT__?: number }).__WEBUI_PORT__ ?? 5180;
  return `http://127.0.0.1:${port}`;
}
