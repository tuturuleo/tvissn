/** Fragment credentials stay out of HTTP request URLs and Referer headers. */
export function inviteFromUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      new URLSearchParams(url.hash.slice(1)).get("invite")?.slice(0, 128) || ""
    );
  } catch {
    return "";
  }
}
export function invitationLink(origin: string, code: string) {
  const url = new URL("/", origin);
  url.hash = new URLSearchParams({ invite: code }).toString();
  return url.toString();
}
export function takeInvitation() {
  const code = inviteFromUrl(location.href);
  if (code) {
    sessionStorage.setItem("tvissn-invite", code);
    history.replaceState(null, "", location.pathname + location.search);
  }
  return sessionStorage.getItem("tvissn-invite") || "";
}
