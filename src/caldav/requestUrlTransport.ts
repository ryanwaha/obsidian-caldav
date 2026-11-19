import { requestUrl } from "obsidian";
import type { Transport } from "./http";

/** requestUrl 無法中途取消；逾時只是放棄等待結果。 */
export function requestUrlTransport(timeoutMs = 30000): Transport {
  return async (req) => {
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("timeout")), timeoutMs); });
    try {
      const r = await Promise.race([
        requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false }),
        timeout,
      ]);
      return { status: r.status, headers: r.headers, text: r.text };
    } finally {
      window.clearTimeout(timer);
    }
  };
}
