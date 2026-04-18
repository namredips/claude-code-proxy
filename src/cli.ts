#!/usr/bin/env bun
import { runBrowserLogin } from "./auth/pkce.ts"
import { runDeviceLogin } from "./auth/device.ts"
import { persistInitialTokens } from "./auth/manager.ts"
import { loadAuth, authPath, clearAuth } from "./auth/token-store.ts"
import { startServer } from "./server.ts"
import { createLogger, logDir } from "./log.ts"

const log = createLogger("cli")

async function main() {
  const [, , cmd, sub] = process.argv
  switch (cmd) {
    case "serve":
    case undefined: {
      const port = Number(process.env.PORT ?? 11434)
      startServer({ port })
      console.log(`Proxy listening on http://localhost:${port}`)
      console.log(`Logs: ${logDir()}/proxy.log`)
      console.log()
      console.log("Configure Claude Code:")
      console.log(`  export ANTHROPIC_BASE_URL="http://localhost:${port}"`)
      console.log(`  export ANTHROPIC_AUTH_TOKEN="anything"`)
      console.log(`  export ANTHROPIC_MODEL="gpt-5.2-codex"`)
      console.log(`  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"`)
      return
    }
    case "auth": {
      if (sub === "login") {
        const tokens = await runBrowserLogin()
        const saved = await persistInitialTokens(tokens)
        console.log(`Auth saved to ${authPath()}`)
        if (saved.accountId) console.log(`Account: ${saved.accountId}`)
        return
      }
      if (sub === "device") {
        const tokens = await runDeviceLogin()
        const saved = await persistInitialTokens(tokens)
        console.log(`Auth saved to ${authPath()}`)
        if (saved.accountId) console.log(`Account: ${saved.accountId}`)
        return
      }
      if (sub === "status") {
        const auth = await loadAuth()
        if (!auth) {
          console.log("Not authenticated")
          process.exit(1)
        }
        const ms = auth.expires - Date.now()
        console.log(`Account: ${auth.accountId ?? "(none)"}`)
        console.log(`Expires: ${new Date(auth.expires).toISOString()} (in ${Math.floor(ms / 1000)}s)`)
        console.log(`File:    ${authPath()}`)
        return
      }
      if (sub === "logout") {
        await clearAuth()
        console.log("Logged out")
        return
      }
      usageAndExit()
      return
    }
    default:
      usageAndExit()
  }
}

function usageAndExit(): never {
  console.log(`Usage:
  ccxp serve                      Run proxy (PORT env, default 11434)
  ccxp auth login                 Browser OAuth (PKCE)
  ccxp auth device                Device-code OAuth
  ccxp auth status                Show current auth
  ccxp auth logout                Clear stored auth
`)
  process.exit(2)
}

main().catch((err) => {
  log.error("cli fatal", { err: String(err), stack: (err as Error)?.stack })
  console.error(err)
  process.exit(1)
})
