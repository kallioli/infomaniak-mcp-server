import type { Express, NextFunction, Request, Response } from "express";

/**
 * Applies the "trust proxy" setting, re-reading it on every request so that a change made in the admin portal
 * takes effect without restart (Express recompiles it only when the value differs).
 */
export function dynamicTrustProxy(app: Express, current: () => string | undefined) {
  let applied: string | undefined | null = null;
  return (_req: Request, _res: Response, next: NextFunction) => {
    const value = current();
    if (value !== applied) {
      app.set("trust proxy", value === undefined ? false : /^\d+$/.test(value) ? Number(value) : value);
      applied = value;
    }
    next();
  };
}
