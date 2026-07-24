import { run as auditRun } from "./audit.js"

export interface DoctorOptions {
  cwd: string
  json?: boolean
}

/** Doctor is the audit's truth subset: "is the recorded reckoning still true?" */
export async function run(opts: DoctorOptions): Promise<void> {
  await auditRun({ cwd: opts.cwd, json: opts.json, truth: true })
}
