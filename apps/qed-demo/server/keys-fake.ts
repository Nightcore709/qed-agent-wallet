/**
 * Test double for the macOS Keychain backend (keys.ts). It holds items in memory only; nothing here touches the
 * owner's login Keychain, which stays unread and unwritten until the owner decides (HO-022).
 */
import type { KeychainBackend } from './keys.ts'

export class MemoryKeychain implements KeychainBackend {
  private readonly items = new Map<string, string>()
  read(service: string, account: string): string | undefined { return this.items.get(`${service}\0${account}`) }
  write(service: string, account: string, secret: string): void { this.items.set(`${service}\0${account}`, secret) }
}
