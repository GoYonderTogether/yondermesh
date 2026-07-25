/**
 * Web server 测试辅助：零依赖 HTTP 客户端
 *
 * 仅用 node:http（不引入 axios / node-fetch / undici），
 * 与 src/web/ 的零依赖约束一致。
 */

import { request, type IncomingMessage } from 'node:http';

/** JSON 响应体类型（宽松，测试用） */
export type JsonResp<T = Record<string, unknown>> = {
  status: number;
  body: T;
};

/**
 * 发送 HTTP GET（或指定方法）请求，解析 JSON 响应。
 * 失败（连接 / 解析）reject。
 */
export function get<T = Record<string, unknown>>(
  url: string,
  method: 'GET' | 'POST' | 'OPTIONS' | 'PUT' | 'DELETE' = 'GET',
): Promise<JsonResp<T>> {
  return new Promise<JsonResp<T>>((resolve, reject) => {
    const req = request(url, { method }, (res: IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        // 防止超大响应拖垮测试
        if (data.length > 1_000_000) req.destroy();
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        // 204 No Content 等无 body 场景
        if (!data) {
          resolve({ status, body: {} as T });
          return;
        }
        try {
          const body = JSON.parse(data) as T;
          resolve({ status, body });
        } catch (err) {
          // 非 JSON 响应也接受（测试可按 status 判定）
          resolve({ status, body: { _raw: data, _parseError: String(err) } as unknown as T });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
