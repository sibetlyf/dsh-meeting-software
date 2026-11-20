// a default import, so plain Node (local recording checks) can load this file too
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 将应用数据目录统一托管在 ~/.dsh/meeting-software-data（或通过 YOGURT_USER_DATA 覆写），避免 Windows AppData\Roaming 权限受限 */
export const userDataDir = (): string => process.env.YOGURT_USER_DATA?.trim() || join(homedir(), '.dsh', 'meeting-software-data')

/** Test mode: stand-ins for everything that needs a model, the microphone or a calendar */
export const isFake = (): boolean => process.env.YOGURT_FAKE === '1'
