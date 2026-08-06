package com.hipago.app;

import java.io.File;
import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure-Java policy boundary for renderer-controlled native network requests.
 *
 * <p>Capacitor plugin arguments are untrusted even when the current TypeScript
 * callers construct them correctly: any script running in the WebView can call
 * a registered native plugin. Keep the allowlist here so direct plugin calls,
 * background work orders, and their JVM tests share the same contract.</p>
 */
final class NativeRequestPolicy {
    private static final int MAX_HEADER_COUNT = 16;
    private static final int MAX_HEADER_NAME_LENGTH = 64;
    private static final int MAX_HEADER_VALUE_LENGTH = 4096;
    private static final int MAX_CACHE_KEY_LENGTH = 200;
    private static final BigInteger MAX_UNSIGNED_LONG =
            new BigInteger("18446744073709551615");

    private static final Set<String> ALLOWED_HEADERS = Collections.unmodifiableSet(
            new LinkedHashSet<>(Arrays.asList(
                    "accept",
                    "accept-language",
                    "origin",
                    "range",
                    "referer",
                    "sec-fetch-dest",
                    "sec-fetch-mode",
                    "sec-fetch-site",
                    "user-agent"
            ))
    );

    private static final Pattern BYTE_RANGE = Pattern.compile("^bytes=([0-9]+)-([0-9]+)$");
    private static final Pattern STABLE_VERSION = Pattern.compile(
            "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)"
    );
    private static final Pattern UPDATE_ASSET_PATH = Pattern.compile(
            "^/VTSB/HiPaGo/releases/download/v(" + STABLE_VERSION.pattern() + ")/"
                    + "HiPaGo_\\1_android_universal\\.apk$"
    );

    private NativeRequestPolicy() {}

    static void requireAllowedBypassUrl(String rawUrl) {
        URI uri = parseHierarchicalHttpsUri(rawUrl, "Bypass URL");
        String host = normalizedHost(uri, "Bypass URL");
        boolean allowed = host.equals("hitomi.la")
                || host.equals("tagindex.hitomi.la")
                || (host.endsWith(".gold-usergeneratedcontent.net")
                    && !host.equals("gold-usergeneratedcontent.net"));
        if (!allowed) {
            throw new IllegalArgumentException("Bypass URL host is not allowed: " + host);
        }
    }

    static boolean isAllowedBypassUrl(String rawUrl) {
        try {
            requireAllowedBypassUrl(rawUrl);
            return true;
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    /**
     * Validate and normalize request header names. A case-insensitive duplicate
     * is rejected instead of allowing map iteration order to choose a winner.
     */
    static Map<String, String> validateHeaders(Map<String, String> headers) {
        if (headers == null) return null;
        if (headers.size() > MAX_HEADER_COUNT) {
            throw new IllegalArgumentException("Too many bypass request headers.");
        }

        Map<String, String> normalized = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            String name = entry.getKey();
            String value = entry.getValue();
            if (name == null || value == null || name.isEmpty()) {
                throw new IllegalArgumentException("Bypass request header is invalid.");
            }
            String lowerName = name.toLowerCase(Locale.ROOT);
            if (!ALLOWED_HEADERS.contains(lowerName)) {
                throw new IllegalArgumentException(
                        "Bypass request header is not allowed: " + name
                );
            }
            if (name.length() > MAX_HEADER_NAME_LENGTH
                    || value.length() > MAX_HEADER_VALUE_LENGTH
                    || containsLineBreak(name)
                    || containsLineBreak(value)) {
                throw new IllegalArgumentException(
                        "Bypass request header is invalid: " + name
                );
            }
            if (normalized.containsKey(lowerName)) {
                throw new IllegalArgumentException(
                        "Duplicate bypass request header: " + name
                );
            }
            if (lowerName.equals("range") && !isValidByteRange(value)) {
                throw new IllegalArgumentException(
                        "Bypass Range header must match bytes=<start>-<end>."
                );
            }
            if (lowerName.equals("origin") && !value.equals("https://hitomi.la")) {
                throw new IllegalArgumentException(
                        "Bypass Origin header must be https://hitomi.la."
                );
            }
            if (lowerName.equals("referer") && !value.equals("https://hitomi.la/")) {
                throw new IllegalArgumentException(
                        "Bypass Referer header must be https://hitomi.la/."
                );
            }
            normalized.put(lowerName, value);
        }
        return normalized.isEmpty()
                ? null
                : Collections.unmodifiableMap(normalized);
    }

    /**
     * Resolve a renderer-supplied absolute path to one direct child of
     * {@code <app cache>/image-cache}. Canonical comparison closes traversal
     * and symlink escapes; filename validation mirrors the desktop cache key.
     */
    static File resolveImageCacheDestination(File appCacheDir, String requestedPath)
            throws IOException {
        if (appCacheDir == null || requestedPath == null || requestedPath.isEmpty()) {
            throw new IllegalArgumentException("Image cache destination is required.");
        }
        File requested = new File(requestedPath);
        if (!requested.isAbsolute()) {
            throw new IllegalArgumentException("Image cache destination must be absolute.");
        }

        File root = new File(appCacheDir, "image-cache").getCanonicalFile();
        File destination = requested.getCanonicalFile();
        File parent = destination.getParentFile();
        if (parent == null || !parent.equals(root)) {
            throw new SecurityException("Image cache destination escapes the cache directory.");
        }
        validateCacheKey(destination.getName());
        return destination;
    }

    /**
     * Validate the one Android release asset shape produced by release.yml and
     * return its semantic version for archive verification after download.
     */
    static String requireAllowedUpdaterAssetUrl(String rawUrl) {
        URI uri = parseHierarchicalHttpsUri(rawUrl, "Updater URL");
        String host = normalizedHost(uri, "Updater URL");
        if (!host.equals("github.com") || uri.getRawQuery() != null) {
            throw new IllegalArgumentException("Updater URL is not an approved GitHub asset.");
        }
        String rawPath = uri.getRawPath();
        if (rawPath == null) {
            throw new IllegalArgumentException("Updater URL is missing an asset path.");
        }
        Matcher match = UPDATE_ASSET_PATH.matcher(rawPath);
        if (!match.matches()) {
            throw new IllegalArgumentException("Updater URL is not the Android universal asset.");
        }
        return match.group(1);
    }

    static void requireValidUpdateArchive(
            String installedPackage,
            long installedVersionCode,
            String archivePackage,
            String archiveVersion,
            long archiveVersionCode,
            String expectedVersion
    ) {
        if (installedPackage == null || !installedPackage.equals(archivePackage)) {
            throw new IllegalArgumentException("package name does not match HiPaGo");
        }
        if (expectedVersion == null || !expectedVersion.equals(archiveVersion)) {
            throw new IllegalArgumentException("package version does not match release asset");
        }
        if (archiveVersionCode <= installedVersionCode) {
            throw new IllegalArgumentException(
                    "package version is not newer than the installed app"
            );
        }
    }

    private static URI parseHierarchicalHttpsUri(String rawUrl, String label) {
        if (rawUrl == null || rawUrl.isEmpty()) {
            throw new IllegalArgumentException(label + " is required.");
        }
        final URI uri;
        try {
            uri = new URI(rawUrl);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException(label + " is invalid.", e);
        }
        if (uri.isOpaque() || uri.getScheme() == null
                || !uri.getScheme().equalsIgnoreCase("https")) {
            throw new IllegalArgumentException(label + " must use HTTPS.");
        }
        if (uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException(label + " must not contain user information.");
        }
        if (uri.getRawFragment() != null) {
            throw new IllegalArgumentException(label + " must not contain a fragment.");
        }
        int port = uri.getPort();
        if (port != -1 && port != 443) {
            throw new IllegalArgumentException(label + " must use HTTPS port 443.");
        }
        return uri;
    }

    private static String normalizedHost(URI uri, String label) {
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            throw new IllegalArgumentException(label + " must contain a valid host.");
        }
        return host.toLowerCase(Locale.ROOT);
    }

    private static boolean containsLineBreak(String value) {
        return value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0;
    }

    private static boolean isValidByteRange(String value) {
        Matcher match = BYTE_RANGE.matcher(value);
        if (!match.matches()) return false;
        try {
            BigInteger start = new BigInteger(match.group(1));
            BigInteger end = new BigInteger(match.group(2));
            return start.compareTo(MAX_UNSIGNED_LONG) <= 0
                    && end.compareTo(MAX_UNSIGNED_LONG) <= 0
                    && start.compareTo(end) <= 0;
        } catch (NumberFormatException ignored) {
            return false;
        }
    }

    private static void validateCacheKey(String cacheKey) {
        if (cacheKey == null || cacheKey.isEmpty()
                || cacheKey.length() > MAX_CACHE_KEY_LENGTH
                || cacheKey.equals(".") || cacheKey.equals("..")) {
            throw new IllegalArgumentException(
                    "Image cache key is empty, reserved, or too long."
            );
        }
        for (int i = 0; i < cacheKey.length(); i++) {
            char c = cacheKey.charAt(i);
            boolean alpha = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
            boolean digit = c >= '0' && c <= '9';
            if (!alpha && !digit && c != '.' && c != '_' && c != '-') {
                throw new IllegalArgumentException(
                        "Image cache key contains unsupported characters."
                );
            }
        }
    }
}
