import type { EditOp } from '@/shared/types.gen'

/** Ошибка применения edit-ops: вся транзакция отклоняется (CONTRACT §6). */
export class OpsError extends Error {
  readonly code: string
  readonly opIndex: number | undefined
  readonly op: EditOp | undefined
  readonly details: string[] | undefined

  constructor(
    code: string,
    message: string,
    opts: { opIndex?: number; op?: EditOp; details?: string[] } = {},
  ) {
    super(opts.opIndex !== undefined ? `op #${opts.opIndex} (${opts.op?.op ?? '?'}): ${message}` : message)
    this.name = 'OpsError'
    this.code = code
    this.opIndex = opts.opIndex
    this.op = opts.op
    this.details = opts.details
  }
}
