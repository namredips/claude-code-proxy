import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export interface StoredAuth {
  access: string
  refresh: string
  expires: number
  accountId?: string
}

const DIR = join(homedir(), ".config", "claude-code-chatgpt-proxy")
const FILE = join(DIR, "auth.json")

export async function loadAuth(): Promise<StoredAuth | undefined> {
  try {
    const raw = await readFile(FILE, "utf8")
    return JSON.parse(raw) as StoredAuth
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined
    throw err
  }
}

export async function saveAuth(auth: StoredAuth): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true })
  await writeFile(FILE, JSON.stringify(auth, null, 2), "utf8")
  try {
    await chmod(FILE, 0o600)
  } catch {
    // best-effort
  }
}

export async function clearAuth(): Promise<void> {
  try {
    await unlink(FILE)
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err
  }
}

export function authPath(): string {
  return FILE
}
