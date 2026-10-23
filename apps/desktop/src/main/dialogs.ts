/** Pure dialog builders (electron-free, unit-tested). */

/**
 * Aegis #1 / N3: server change confirmation. Host (as parsed: punycode, port) on its own line, prominent in the
 * message, plus the full URL in the detail. Cancel is the default and the Escape action.
 */
export function serverChangeDialog(nextUrl: string, currentUrl: string | null) {
  const host = new URL(nextUrl).host;
  return {
    type: 'warning' as const, buttons: ['取消', '切换到该服务器'], defaultId: 0, cancelId: 0, noLink: true,
    message: `切换客户端连接的服务器？\n\n${host}`,
    detail: `主机：${host}\n完整地址：${nextUrl}\n当前服务器：${currentUrl ?? '(未配置)'}\n\n登录密码、会话与 API key 将发送到新服务器。只有你信任该地址时才继续。当前会话会被清除。`,
  };
}
