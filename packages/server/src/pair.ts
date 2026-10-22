/**
 * `pnpm pair [--url https://host:port]` — mints a one-time pairing code for a
 * new device. Run it on the server machine as the user the service runs as:
 * the code is a file in that user's config directory, which the running
 * server reads, so no network call and no running UI are needed.
 */
import QRCode from 'qrcode'

import { CODE_TTL_MS, configDir, issueCode } from './auth/pairing.ts'

const args = process.argv.slice(2)
const flag = args.indexOf('--url')
const base = (flag >= 0 ? args[flag + 1] : undefined) ?? process.env['CCW_PUBLIC_URL']

const { code } = await issueCode()
console.log(`\n  配对码：${code}`)
console.log(`  ${CODE_TTL_MS / 60_000} 分钟内有效，只能使用一次（${configDir()}）\n`)

if (base) {
  // A fragment, not a query: it never reaches the server or a proxy's logs.
  const link = `${base.replace(/\/+$/, '')}/#pair=${code}`
  console.log(await QRCode.toString(link, { type: 'terminal', small: true }))
  console.log(`  扫码或打开：${link}\n`)
} else {
  console.log('  在新设备上打开 WebUI，输入上面的配对码。加 --url https://你的地址 可以同时打印二维码。\n')
}
