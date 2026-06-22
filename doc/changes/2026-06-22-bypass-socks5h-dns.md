# Route bypass client DNS through local SOCKS proxy

**Date:** 2026-06-22
**Area:** bypass-core / Android tag sync / DoH

The Rust HTTP client now connects to the in-process proxy with `socks5h://`
instead of `socks5://`.

`rquest` treats plain `socks5://` as local-DNS mode. In that mode the client can
resolve `hitomi.la` before the request reaches HiPaGo's SOCKS proxy, which
bypasses the DoH resolver and can fail on Android networks where the system DNS
answer is blocked or poisoned. `socks5h://` keeps the hostname in the SOCKS
CONNECT request, so the proxy receives `hitomi.la` and resolves it through the
DoH path before applying TLS ClientHello fragmentation.

This matters for Android tag sync because `allartists-*.html` and tag pages are
fetched through the Capacitor Bypass plugin. A local-DNS SOCKS client can surface
only as a generic native `Connect` failure, even though the intended bypass path
was never used.
