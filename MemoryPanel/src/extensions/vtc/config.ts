import { z } from 'zod';

export const vtcConfigSchema = z
  .object({
    SSO_BASE_URL: z.string().url(),
    SERVICE_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    PRIVATE_KEY: z.string().min(1),
    PUBLIC_BASE_URL: z.string().url(),
    SUCCESS_STATE: z.string().min(1).max(64).default('1'),
    INSTANCE_ID: z.string().min(1).optional(),
    KEY_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    LOGIN_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    DEVICE_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  })
  .superRefine((value, ctx) => {
    // Plain http is for local runs only; a real deployment uses https end to end.
    const localHosts = new Set(['localhost', '127.0.0.1']);
    const checks: Array<['SSO_BASE_URL' | 'PUBLIC_BASE_URL', string, boolean]> = [
      ['SSO_BASE_URL', value.SSO_BASE_URL, false],
      ['PUBLIC_BASE_URL', value.PUBLIC_BASE_URL, true],
    ];
    for (const [field, raw, originOnly] of checks) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        continue; // The url() check above already reported it.
      }
      const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && localHosts.has(url.hostname));
      const shapeOk = !originOnly || ((url.pathname === '/' || url.pathname === '') && !url.search && !url.hash);
      if (!schemeOk || !shapeOk) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field] });
    }
  })
  .transform(
    (value): VtcConfig => ({
      ssoBaseUrl: value.SSO_BASE_URL.replace(/\/+$/, ''),
      serviceId: value.SERVICE_ID,
      privateKey: value.PRIVATE_KEY,
      publicBaseUrl: value.PUBLIC_BASE_URL.replace(/\/+$/, ''),
      successState: value.SUCCESS_STATE,
      ...(value.INSTANCE_ID ? { instanceId: value.INSTANCE_ID } : {}),
      keyTtlDays: value.KEY_TTL_DAYS,
      loginMaxAgeSeconds: value.LOGIN_MAX_AGE_SECONDS,
      deviceCodeTtlSeconds: value.DEVICE_CODE_TTL_SECONDS,
    }),
  );

export type VtcConfig = {
  ssoBaseUrl: string;
  serviceId: string;
  privateKey: string;
  publicBaseUrl: string;
  successState: string;
  instanceId?: string;
  keyTtlDays: number;
  loginMaxAgeSeconds: number;
  deviceCodeTtlSeconds: number;
};
