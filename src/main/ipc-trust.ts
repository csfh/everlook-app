/**
 * Which window may call into the main process.
 * A packaged app only trusts its own file URL. Development trusts the dev server origin.
 */
export function isTrustedIpcSender(senderUrl: string, options: {
  packaged: boolean
  rendererUrl: string | undefined
}): boolean {
  let sender: URL
  try {
    sender = new URL(senderUrl)
  } catch {
    return false
  }
  if (options.packaged) return sender.protocol === 'file:'
  if (options.rendererUrl === undefined) return false
  try {
    return sender.origin === new URL(options.rendererUrl).origin
  } catch {
    return false
  }
}
