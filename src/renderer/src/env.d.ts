import type { EverlookApi } from '../../shared/types'

declare global {
  interface Window {
    everlook: EverlookApi
  }
}

export {}
