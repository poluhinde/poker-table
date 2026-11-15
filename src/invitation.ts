/** Credentials stay in the fragment: never sent in the initial URL or referrer. */
export function invitationLink(base: string, credential: string) {
  const url = new URL('/', base);
  url.hash = new URLSearchParams({ invite: credential }).toString();
  return url.toString();
}
