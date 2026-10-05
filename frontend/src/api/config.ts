export const API_BASE: string = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8765/api'
export const WS_URL: string = API_BASE.replace(/^http/, 'ws') + '/ws'
export const IS_MOCK: boolean = import.meta.env.VITE_MOCK === '1'
