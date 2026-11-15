/** A user's browser for OAuth flow tests: keeps cookies and never follows redirects. */
export class Browser {
  private readonly jar = new Map<string, string>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers as object), ...(cookie ? { cookie } : {}) } });
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(";");
      const [name, ...value] = pair.split("=");
      this.jar.set(name.trim(), value.join("="));
    }
    return res;
  }

  /** Sends the consent page's form with the given decision. */
  async answerConsent(page: Response, decision: "approve" | "deny", base: string): Promise<Response> {
    const request = (await page.text()).match(/name="request" value="([^"]+)"/)![1];
    return this.fetch(`${base}/oauth/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request, decision }).toString(),
    });
  }

  /** Opens an /authorize URL, approving the consent page if one is shown; returns where Infomaniak is reached. */
  async authorize(url: string, base: string): Promise<URL> {
    let res = await this.fetch(url);
    if (res.status === 200) res = await this.answerConsent(res, "approve", base);
    return new URL(res.headers.get("location")!);
  }
}
