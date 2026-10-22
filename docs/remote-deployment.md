# 远程部署

WebUI 能开终端、能以跳过权限模式跑 Claude，拿到访问权就等于拿到这台机器的 shell。远程部署要同时做到两件事：

- **传输加密**：一律走 TLS。浏览器的 `crypto.subtle` 只在 HTTPS 页面可用，页面 JS 本身也要靠 TLS 防篡改，所以加密不在应用层做。
- **访问控制**：新设备用一次性**配对码**换一个设备 cookie（`HttpOnly`、`Secure`、`SameSite=Strict`，服务端只存哈希）。每台设备只配对一次。

server 绑定非 loopback 地址却没有配置证书时会拒绝启动。

## 1. 构建与启动

```bash
pnpm install
pnpm --filter @ccw/web build        # 产物在 packages/web/dist，由 server 直接托管
pnpm --filter @ccw/server start     # 只起 server；远程不要起 vite dev server
```

UI 和 API 同在一个端口（默认 3090）。不要把 Vite dev server（5190）暴露到网络上，原因见第 4 节。

## 2. TLS（三选一）

### A. Tailscale（推荐）

端口只对你自己的设备开放，证书由 Tailscale 签发，浏览器不会报警，手机装上 Tailscale App 就能访问。

```bash
tailscale cert my-box.tailnet-xxxx.ts.net          # 生成 .crt 和 .key
CCW_HOST=100.x.y.z \                               # 这台机器的 Tailscale IP，只监听 tailnet
CCW_TLS_CERT=/path/my-box.tailnet-xxxx.ts.net.crt \
CCW_TLS_KEY=/path/my-box.tailnet-xxxx.ts.net.key \
pnpm --filter @ccw/server start
```

访问 `https://my-box.tailnet-xxxx.ts.net:3090`。证书 90 天过期，续期需要重新运行 `tailscale cert` 并重启服务。

也可以让 server 留在 loopback，用 `tailscale serve` 反代。前提是它原样转发 `Host`，否则终端 tab 的 Origin 校验会失败；遇到这种情况就改回上面的证书文件方式。

### B. 域名 + Caddy

server 保持默认的 `CCW_HOST=127.0.0.1`，Caddy 负责签证书和终止 TLS：

```caddyfile
ccw.example.com {
    reverse_proxy 127.0.0.1:3090
    header Strict-Transport-Security "max-age=15552000"
}
```

Caddy 默认原样转发 `Host`，并附加 `X-Forwarded-For`，所以经它进来的请求一定要走配对。这种方式端口在公网可达，配对码和限速是唯一的门槛。

### C. 公网 IP + 自签证书

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
  -subj "/CN=ccw" -addext "subjectAltName=IP:203.0.113.10" \
  -keyout key.pem -out cert.pem
openssl x509 -in cert.pem -noout -fingerprint -sha256   # 记下指纹
CCW_HOST=0.0.0.0 CCW_TLS_CERT=cert.pem CCW_TLS_KEY=key.pem pnpm --filter @ccw/server start
```

每台新设备第一次访问都会看到浏览器的证书警告。放行之前，先在浏览器的证书详情里核对 SHA-256 指纹和上面记下的是否一致；不一致说明连接被人拦截了。

## 3. 配对

新设备打开 WebUI 会看到配对页。配对码有两个来源：

- **服务器上**：`pnpm pair`，加 `--url https://你的地址` 或设置 `CCW_PUBLIC_URL`，会同时打印终端二维码。需要用**和服务相同的用户**运行，因为配对码写在该用户的 `~/.config/claude-code-webui/` 下。
- **已配对的设备上**：侧栏底部「设备 → 生成配对码」。经远程地址访问时会显示二维码，手机扫码即可自动完成配对。

配对码的规则：

- 8 位，5 分钟内有效，只能使用一次。
- 15 分钟内累计输错 5 次，所有未使用的配对码全部作废，需要重新生成。

设备的规则：

- 30 天未使用自动失效；每次打开都会自动续期，所以常用的设备不会过期。
- 在「设备」里可以吊销任意设备，被吊销设备的连接会立即断开。

## 4. 本机免配对

同时满足以下三个条件的请求视为本机请求，不需要配对：

1. TCP 对端是 loopback；
2. `Host` 是 `localhost`、`127.0.0.1` 或 `[::1]`；
3. 请求没有 `X-Forwarded-For`、`Forwarded`、`X-Real-IP` 头。

本地开发（vite 5190 代理到 3090）和 `ssh -L 3090:127.0.0.1:3090` 隧道都属于本机请求。

以下情况需要设置 `CCW_REQUIRE_PAIRING=1`，让本机请求也必须配对：

- 同机的反向代理会把 `Host` 改写成 localhost，同时又不加转发头。外部请求经过这种代理后会被当成本机请求。
- 机器上有其他不可信的本地用户。他们也能访问 loopback 地址。

基于同样的原因，**绝不能把 vite dev server 暴露到网络上**：它转发时既不改写 `Host`，也不加转发头，外部请求经它转发后会被当成本机请求。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CCW_HOST` / `CCW_PORT` | 监听地址和端口，默认 `127.0.0.1:3090`；非 loopback 必须配 TLS |
| `CCW_TLS_CERT` / `CCW_TLS_KEY` | PEM 证书和私钥路径，两者需同时设置 |
| `CCW_REQUIRE_PAIRING=1` | 取消本机免配对 |
| `CCW_CONFIG_DIR` | 设备和配对码的存放目录，默认 `~/.config/claude-code-webui` |
| `CCW_PUBLIC_URL` | `pnpm pair` 打印二维码时使用的地址 |

旧的 `CCW_TOKEN` 和 URL 里的 `?token=` 已经移除，由配对机制取代。

另外，server 以 root 身份运行时，跳过权限模式下的 Claude 也拥有 root 权限。远程机器上建议用专门的普通用户来跑服务。
