# Tag sync keeps Hitomi tag pages on HTTPS

**Date:** 2026-06-22
**Area:** tag sync / Android bypass / web proxy

Tag database live sync must request Hitomi tag-list pages over
`https://hitomi.la`, including native Tauri/Capacitor bypass fetches and the
web `/api/tags/fetch` proxy. The app must not downgrade tag-list requests to
plain HTTP because unencrypted traffic can be intercepted or redirected before
the bypass path can protect it.

The tag sync path also does not mark failed native HTTPS transport as complete
with a bundled tag cache. If the HTTPS bypass request fails, the sync error
stays visible so the transport problem can be diagnosed instead of hidden by
stale local data.
