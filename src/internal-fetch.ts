let authHeader: string | undefined;

export function initInternalFetch(password: string): void {
  // Basic Auth with an empty username: base64(":password").
  authHeader = `Basic ${Buffer.from(`:${password}`).toString("base64")}`;
}

export async function internalFetch(url: string, init?: RequestInit): Promise<Response> {
  if (authHeader === undefined) {
    throw new Error("internalFetch called before initInternalFetch");
  }

  const existingHeaders = init?.headers;
  let mergedHeaders: Record<string, string>;

  if (existingHeaders === undefined) {
    mergedHeaders = { "Authorization": authHeader };
  } else if (existingHeaders instanceof Headers) {
    mergedHeaders = { "Authorization": authHeader };
    existingHeaders.forEach((value, key) => {
      mergedHeaders[key] = value;
    });
  } else if (Array.isArray(existingHeaders)) {
    mergedHeaders = { "Authorization": authHeader };
    for (const [key, value] of existingHeaders) {
      mergedHeaders[key] = value;
    }
  } else {
    mergedHeaders = { "Authorization": authHeader, ...(existingHeaders as Record<string, string>) };
  }

  return fetch(url, { ...init, headers: mergedHeaders });
}
