/** The public recovery entry point shared by status messages and the installer. */
export const ENTERPRISE_SETUP_COMMAND = 'plur-enterprise init'

export function enterpriseRecoveryHint(host: string): string {
  return `run \`${ENTERPRISE_SETUP_COMMAND}\` again — it adds a new key for this device and sends the queued saves (server: ${host})`
}
