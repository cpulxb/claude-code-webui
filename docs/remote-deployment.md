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

## 2. TLS

**不需要自己有域名。** 下表里只有 B 需要域名，其余方案只有一个 IP 也能用。

| 方案 | 需要域名 | 浏览器警告 | 适合 |
| --- | --- | --- | --- |
| A. Tailscale | 否（Tailscale 分配 `*.ts.net`） | 无 | 只有自己的设备访问，端口不暴露在公网 |
| B. 域名 + Caddy | 是 | 无 | 已经有域名 |
| C. sslip.io + Caddy | 否 | 无 | 只有 IP，要公网直连，不想改任何配置 |
| D. Let's Encrypt IP 证书 | 否 | 无 | 只有 IP，不想依赖第三方 DNS 服务 |
| E. mkcert 自建 CA | 否 | 无（每台设备装一次根证书） | 只有 IP，设备少，不依赖任何外部服务 |
| F. 自签证书手动放行 | 否 | 每台新设备都有 | 不推荐 |

### A. Tailscale（推荐）

端口只对你自己的设备开放，证书由 Tailscale 签发，浏览器不会报警，手机装上 Tailscale App 就能访问。服务器只需要能联网，不需要公网 IP，也不需要域名。

```bash
tailscale cert my-box.tailnet-xxxx.ts.net          # 生成 .crt 和 .key
CCW_HOST=100.x.y.z \                               # 这台机器的 Tailscale IP，只监听 tailnet
CCW_TLS_CERT=/path/my-box.tailnet-xxxx.ts.net.crt \
CCW_TLS_KEY=/path/my-box.tailnet-xxxx.ts.net.key \
pnpm --filter @ccw/server start
```

访问 `https://my-box.tailnet-xxxx.ts.net:3090`。证书 90 天过期，续期需要重新运行 `tailscale cert` 并重启服务。

也可以让 server 留在 loopback，用 `tailscale serve` 反代。前提是它原样转发 `Host`，否则终端 tab 的 Origin 校验会失败；遇到这种情况就改回上面的证书文件方式。

### B. 有域名：Caddy

server 保持默认的 `CCW_HOST=127.0.0.1`，Caddy 负责签证书和终止 TLS：

```caddyfile
ccw.example.com {
    reverse_proxy 127.0.0.1:3090
    header Strict-Transport-Security "max-age=15552000"
}
```

Caddy 默认原样转发 `Host`，并附加 `X-Forwarded-For`，所以经它进来的请求一定要走配对。这种方式端口在公网可达，配对码和限速是唯一的门槛。

### C. 只有 IP：sslip.io + Caddy

[sslip.io](https://sslip.io)（与 nip.io 是同一个服务，两个域名可以互换）会把 IP 编码在主机名里，并解析回这个 IP：`203-0-113-10.sslip.io` 解析到 `203.0.113.10`。这样就等于有了一个域名，配置和 B 完全一样：

```caddyfile
203-0-113-10.sslip.io {
    reverse_proxy 127.0.0.1:3090
}
```

需要公网能访问 80 和 443 端口，Caddy 用它们向 Let's Encrypt 申请证书。证书的申请和续期都由 Caddy 自动完成，server 不需要任何改动。访问地址是 `https://203-0-113-10.sslip.io`。

代价是解析依赖 sslip.io 这个第三方服务一直在线。如果申请证书时碰到 Let's Encrypt 的频率限制，sslip.io 官方的建议是改用 D。

### D. 只有 IP：Let's Encrypt IP 证书

Let's Encrypt 从 2026-01-15 起正式签发 IP 地址证书（IPv4 和 IPv6 都支持），但只能使用 `shortlived` profile，有效期约 6 天（160 小时）。需要 certbot 5.3 或更高版本，并且公网 80 端口可达：

```bash
sudo certbot certonly --preferred-profile shortlived --standalone --ip-address 203.0.113.10
CCW_HOST=0.0.0.0 \
CCW_TLS_CERT=/etc/letsencrypt/live/203.0.113.10/fullchain.pem \
CCW_TLS_KEY=/etc/letsencrypt/live/203.0.113.10/privkey.pem \
pnpm --filter @ccw/server start
```

`--standalone` 会临时占用 80 端口。如果 80 端口上已经有 web 服务，改用 `--webroot`（需要 certbot 5.4 或更高版本）。

注意：server 目前**只在启动时读取证书**，而这种证书每隔几天就要续期。所以需要用 `certbot reconfigure --deploy-hook "systemctl restart <服务名>"` 让续期后自动重启服务，而每次重启都会断开所有正在运行的会话。如果 server 不是以 root 运行，deploy hook 里还要先把证书复制到服务用户能读的位置，因为 `/etc/letsencrypt` 只有 root 能读。如果介意频繁重启，就用 C 或 E。

### E. 只有 IP：mkcert 自建 CA

用 [mkcert](https://github.com/FiloSottile/mkcert) 建一个只有你自己的设备信任的 CA，再用它签发 IP 证书。证书有效期两年多，期间不需要续期，也不依赖任何外部服务：

```bash
mkcert -install                     # 生成本地 CA
mkcert 203.0.113.10                 # 生成 203.0.113.10.pem 和 203.0.113.10-key.pem
CCW_HOST=0.0.0.0 CCW_TLS_CERT=203.0.113.10.pem CCW_TLS_KEY=203.0.113.10-key.pem pnpm --filter @ccw/server start
mkcert -CAROOT                      # 根证书 rootCA.pem 所在的目录
```

把 `rootCA.pem` 安装到每台要访问的设备上，**只需要装一次**：

- **iPhone / iPad**：用 AirDrop 或邮件发送到设备上打开，在「设置」里安装描述文件；然后到「设置 → 通用 → 关于本机 → 证书信任设置」里打开对它的完全信任。漏了这一步，证书仍然不受信任。
- **Android**：「设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书」（不同厂商的菜单路径略有差异）。
- **Windows / macOS**：双击安装到「受信任的根证书颁发机构」，或者添加到「钥匙串」并设为始终信任。

**`rootCA-key.pem` 绝不能外泄。** 谁拿到它，谁就能给任意网站签发你的设备会信任的证书。它只需要留在签发证书的那台机器上，不要复制到其他地方。

### F. 自签证书手动放行（不推荐）

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
  -subj "/CN=ccw" -addext "subjectAltName=IP:203.0.113.10" \
  -keyout key.pem -out cert.pem
openssl x509 -in cert.pem -noout -fingerprint -sha256   # 记下指纹
CCW_HOST=0.0.0.0 CCW_TLS_CERT=cert.pem CCW_TLS_KEY=key.pem pnpm --filter @ccw/server start
```

每台新设备第一次访问都会看到浏览器的证书警告。放行之前，先在浏览器的证书详情里核对 SHA-256 指纹和上面记下的是否一致；不一致说明连接被人拦截了。

不推荐的原因：

- 每台设备都要手动核对指纹。一旦养成直接点「继续」的习惯，真遇到中间人攻击也察觉不到。
- iPhone 和 Mac 上的 Safari 对未受信任证书的放行，常常不覆盖 WebSocket（`wss`）连接。结果是页面能打开，却一直显示「连接断开」。要在 Safari 上使用，就得把证书装成受信任的，那样不如直接用 E。

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
