import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** A device unused this long has to pair again; every use extends it. */
export const DEVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000

/** `lastSeenAt` is persisted at most this often — it moves on every request. */
const TOUCH_PERSIST_MS = 60 * 60 * 1000

export type Device = {
  id: string
  name: string
  /** SHA-256 of the cookie value. The value itself is never stored. */
  tokenHash: string
  createdAt: number
  lastSeenAt: number
  lastIp: string
}

/**
 * Paired devices, kept in memory and mirrored to `devices.json`. Only the
 * server process writes the file, so there is no cross-process locking; writes
 * are chained so two renames never interleave.
 */
export class DeviceStore {
  readonly #path: string
  readonly #byHash = new Map<string, Device>()
  #writing: Promise<void> = Promise.resolve()

  private constructor(path: string, devices: Device[]) {
    this.#path = path
    for (const device of devices) this.#byHash.set(device.tokenHash, device)
  }

  static async open(dir: string): Promise<DeviceStore> {
    const path = join(dir, 'devices.json')
    let devices: Device[] = []
    try {
      devices = (JSON.parse(await readFile(path, 'utf8')) as { devices: Device[] }).devices
    } catch (error) {
      // A missing file is a fresh install. A corrupt one must not silently
      // become an empty store that the next write then makes permanent.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return new DeviceStore(path, devices)
  }

  /** The device a cookie value belongs to, or null when unknown or idle too long. */
  authenticate(token: string, ip: string, now = Date.now()): Device | null {
    const device = this.#byHash.get(hashToken(token))
    if (!device) return null
    if (now - device.lastSeenAt > DEVICE_IDLE_MS) {
      this.#byHash.delete(device.tokenHash)
      this.#persistInBackground()
      return null
    }
    const stale = now - device.lastSeenAt > TOUCH_PERSIST_MS || device.lastIp !== ip
    device.lastSeenAt = now
    device.lastIp = ip
    if (stale) this.#persistInBackground()
    return device
  }

  async add(name: string, ip: string, now = Date.now()): Promise<{ device: Device; token: string }> {
    const token = randomBytes(32).toString('base64url')
    const device: Device = { id: randomUUID(), name, tokenHash: hashToken(token), createdAt: now, lastSeenAt: now, lastIp: ip }
    this.#byHash.set(device.tokenHash, device)
    await this.#persist()
    return { device, token }
  }

  async revoke(id: string): Promise<boolean> {
    const device = this.list().find((candidate) => candidate.id === id)
    if (!device) return false
    this.#byHash.delete(device.tokenHash)
    await this.#persist()
    return true
  }

  /** Live devices, most recently used first. Idle ones are dropped on their next request. */
  list(now = Date.now()): Device[] {
    return [...this.#byHash.values()]
      .filter((device) => now - device.lastSeenAt <= DEVICE_IDLE_MS)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /** For writes a request does not wait on; a failure must not reject into nowhere. */
  #persistInBackground(): void {
    this.#persist().catch((error: unknown) => console.error('[ccw] saving devices.json failed', error))
  }

  #persist(): Promise<void> {
    const snapshot = JSON.stringify({ devices: [...this.#byHash.values()] }, null, 2)
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
      const temp = `${this.#path}.${process.pid}.tmp`
      await writeFile(temp, snapshot, { mode: 0o600 })
      await rename(temp, this.#path)
    }
    this.#writing = this.#writing.then(write, write)
    return this.#writing
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
