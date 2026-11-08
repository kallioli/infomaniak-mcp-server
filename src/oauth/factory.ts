import type { Settings } from "../settings.js";
import type { Store } from "../store/db.js";
import { InfomaniakOAuthProvider } from "./provider.js";

/**
 * Returns the OAuth provider matching the current settings, or undefined while OAuth is not fully configured.
 * A new provider is built only when a relevant setting changes.
 */
export function oauthProviderFromSettings(settings: Settings, store: Store, fetchImpl?: typeof fetch) {
  let cached: { key: string; provider: InfomaniakOAuthProvider } | undefined;
  return (): InfomaniakOAuthProvider | undefined => {
    const { oauth, publicUrl } = settings.effective();
    if (!oauth || !publicUrl) return undefined;
    const key = JSON.stringify([oauth.clientId, oauth.clientSecret, oauth.secret, oauth.scopes, publicUrl.href]);
    if (cached?.key !== key) {
      cached = {
        key,
        provider: new InfomaniakOAuthProvider({
          ...oauth,
          publicUrl,
          authorizeLogin: (identity) => store.checkOAuthLogin(identity),
          fetch: fetchImpl,
        }),
      };
    }
    return cached.provider;
  };
}
