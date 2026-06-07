# Android API Bypass Pagination Regression

## Context

Commit `81fe9a2929292394b6b60bf2e767b30ef45fdb93` routed Capacitor API requests through `Bypass.fetch()` on Android and iOS. Later Android resource interception moved some traffic to `BypassWebViewClient`, and `apiClient.fetchUrl()` started using plain WebView `fetch()` on Android.

Gallery list pagination depends on ranged nozomi requests and the upstream `Content-Range` header. If the first page body is available but `Content-Range` is not visible to JavaScript, fallback slicing can make page 1 look correct while the virtual list infers a one-page total and never requests page 2+.

## Decision

Use the Capacitor Bypass plugin for JavaScript API fetches on all Capacitor platforms, including Android. Keep `BypassWebViewClient` for Android WebView resource loads such as direct image requests.

The split is intentional:

- JS API calls need reliable response headers, especially `Content-Range`.
- WebView resource loads need native bypass handling for direct `<img>` and resource URLs.
- Native Hitomi disguise headers (`Referer`, `Origin`) remain part of both API and WebView bypass paths.

## Verification Cue

Android API client tests should assert that ranged API fetches call `Bypass.fetch()` and preserve `Content-Range`. Android WebView interceptor tests should continue to assert forwarded request headers for resource interception.
