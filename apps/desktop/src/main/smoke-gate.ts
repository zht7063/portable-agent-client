/**
 * Aegis M5: the only smoke bypass of a native confirmation ("Show key" auto-yes for the unattended dev UI smoke).
 * Requires all of: a dev/test build (__PA_SMOKE__, stripped from production builds), an unpackaged app
 * (!app.isPackaged), PA_SMOKE=1 and PA_SMOKE_UI=1.
 */
export function smokeAutoConfirmReveal(o: { smokeBuild: boolean; isPackaged: boolean; env: Record<string, string | undefined> }): boolean {
  return o.smokeBuild && !o.isPackaged && o.env.PA_SMOKE === '1' && o.env.PA_SMOKE_UI === '1';
}
