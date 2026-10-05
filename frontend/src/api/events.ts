import { WS_URL } from './config'
import { EventsSocket } from './ws'

/** Единственное WS-подключение приложения. */
export const events = new EventsSocket(WS_URL)
