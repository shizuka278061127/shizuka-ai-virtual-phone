import { lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";
import { cleanTtsText } from "@/lib/tts-text";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_URL = "https://api.fish.audio/v1/tts";
const blocked = new BlockList();
for (const [address, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
    ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
    ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");

// Validate the actual DNS lookup used by the connection, including retries.
// This prevents custom proxy URLs from reaching private networks via DNS rebinding.
const dispatcher = new Agent({
    connect: {
        lookup(hostname, options, callback) {
            lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
                if (error) return callback(error, "", 4);
                if (!addresses.length || addresses.some(({ address, family }) =>
                    family === 4 ? blocked.check(address, "ipv4")
                        : !globalV6.check(address, "ipv6") || blocked.check(address, "ipv6"))) {
                    return callback(new Error("不允许访问本机、内网或保留地址"), "", 4);
                }
                if (options.all) callback(null, addresses);
                else callback(null, addresses[0].address, addresses[0].family);
            });
        },
    },
});

function fail(error: string, status: number): Response {
    return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function string(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

const ERRORS: Record<number, string> = {
    400: "Fish Audio 请求参数错误，请检查文本、模型和音色 ID",
    401: "Fish Audio API Key 无效或已过期，请重新填写",
    402: "Fish Audio 余额不足，请检查账户余额或套餐",
    403: "Fish Audio 无权使用该音色或模型，请检查权限",
    404: "Fish Audio 接口或音色不存在，请检查接口地址和 Reference ID",
    422: "Fish Audio 参数校验失败，请检查模型和 Reference ID",
    429: "Fish Audio 请求过于频繁，请稍后重试",
    503: "Fish Audio 服务暂时不可用，请稍后重试",
};

export async function POST(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail("请求必须是 JSON 对象", 400);
    const data = body as Record<string, unknown>;
    const text = cleanTtsText(string(data.text));
    const apiKey = string(data.apiKey);
    const referenceId = string(data.referenceId);
    const model = string(data.model) || "s1";
    if (!text) return fail("清理动作和表情后没有可合成的文本", 400);
    if (text.length > 20_000) return fail("文本过长，请分段合成（每段最多 20000 字符）", 400);
    if (!apiKey || /[\r\n]/.test(apiKey)) return fail("请填写有效的 Fish Audio API Key", 400);
    if (!referenceId) return fail("请填写角色音色 ID 或默认 Reference ID", 400);
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model)) return fail("Fish Audio 模型名格式不正确", 400);

    let url: URL;
    try { url = new URL(string(data.baseUrl) || DEFAULT_URL); }
    catch { return fail("接口地址格式不正确，请填写完整的 HTTPS 地址", 400); }
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.hash
        || isIP(hostname) || hostname === "localhost" || /\.(localhost|local|internal)\.?$/.test(hostname)) {
        return fail("接口地址必须是公网 HTTPS 域名，不支持本机、内网地址或 URL 内的账号密码", 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55_000);
    try {
        const upstream = await fetch(url, {
            method: "POST",
            redirect: "error", // Never forward the user's key to a redirected host.
            cache: "no-store",
            signal: controller.signal,
            dispatcher,
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", model },
            body: JSON.stringify({ text, reference_id: referenceId, format: "mp3", mp3_bitrate: 128, normalize: true, latency: "normal" }),
        } as RequestInit);
        if (!upstream.ok) {
            await upstream.body?.cancel();
            return fail(ERRORS[upstream.status] || `Fish Audio 合成失败（HTTP ${upstream.status}），请稍后重试`, upstream.status);
        }
        const contentType = upstream.headers.get("content-type")?.split(";")[0].trim();
        if (contentType && !["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(contentType)) {
            await upstream.body?.cancel();
            return fail("Fish Audio 返回了非 MP3 数据，请检查接口地址和模型", 502);
        }
        const audio = await upstream.arrayBuffer();
        if (!audio.byteLength) return fail("Fish Audio 未返回音频数据", 502);
        return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
    } catch {
        return fail(controller.signal.aborted ? "Fish Audio 合成超时，请缩短文本后重试" : "无法连接 Fish Audio，请检查公网接口地址和网络", controller.signal.aborted ? 504 : 502);
    } finally {
        clearTimeout(timer);
    }
}
