# Bypass HTTPS calls can use real ECH

**Date:** 2026-06-22
**Area:** bypass-core / DoH / ECH

Real ECH requires two pieces:

1. Resolve the target host's HTTPS/SVCB record and extract the `ech`
   ECHConfigList.
2. Pass that ECHConfigList into the TLS client's handshake configuration.

`bypass-core` now handles the first piece for both common DoH JSON shapes. Some
providers return HTTPS RR data as presentation text with `ech=<base64>`, while
Cloudflare can return opaque wire-format data such as `\# <len> <hex...>`.
The DoH resolver now parses that wire-format HTTPS RDATA and extracts SvcParam
key `5` (`ech`) directly.

For HTTPS calls, `bypass-core` now attempts a real ECH path when an
ECHConfigList is available. It connects directly to an address resolved through
the same DoH resolver, applies the ECHConfigList through rustls' public
`EchConfig` API, and only sends the HTTP request if rustls reports that ECH was
accepted. If the host has no ECHConfigList, or the ECH path fails before a
response is exposed, the request falls back to the existing `rquest` path.

The ECH transport now covers the buffered `Client::fetch()`, streaming
`Client::fetch_streaming()`, and file `Client::download_to_file()` paths. The
transport speaks HTTP/1.1 with `Accept-Encoding: identity`, parses headers before
returning streaming metadata, and decodes chunked/content-length/EOF-delimited
bodies without buffering full downloads in memory.

`rquest` 1.5.5 exposes ECH GREASE but not a host-specific ECHConfigList hook. To
avoid carrying a library fork, ECH-capable requests use the new direct rustls
transport while non-ECH hosts keep using the existing `rquest` fallback.
