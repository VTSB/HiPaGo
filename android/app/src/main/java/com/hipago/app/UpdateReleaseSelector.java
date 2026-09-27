package com.hipago.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.regex.Pattern;

/** Selects an installable newer Android release without Android runtime dependencies. */
final class UpdateReleaseSelector {
    private static final Pattern VERSION = Pattern.compile("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)");
    private static final long MAX_VERSION_CODE = 2_100_000_000L;

    private UpdateReleaseSelector() {}

    static final class Update {
        final String version;
        final String notes;
        final String apkUrl;
        final boolean prerelease;

        Update(String version, String notes, String apkUrl, boolean prerelease) {
            this.version = version;
            this.notes = notes;
            this.apkUrl = apkUrl;
            this.prerelease = prerelease;
        }
    }

    static Update select(JSONArray releases, String currentVersion, boolean includePrereleases) {
        long newestCode = versionCode(currentVersion);
        if (newestCode < 0 || releases == null) {
            return null;
        }
        Update newest = null;
        for (int i = 0; i < releases.length(); i++) {
            JSONObject release = releases.optJSONObject(i);
            if (release == null || release.optBoolean("draft", false)) {
                continue;
            }
            boolean prerelease = release.optBoolean("prerelease", false);
            if (prerelease && !includePrereleases) {
                continue;
            }
            String tag = release.optString("tag_name", "");
            if (!tag.startsWith("v")) {
                continue;
            }
            String version = tag.substring(1);
            long code = versionCode(version);
            if (code <= newestCode) {
                continue;
            }
            String apkUrl = findApkAssetUrl(release.optJSONArray("assets"));
            if (apkUrl == null) {
                continue;
            }
            newest = new Update(version, release.optString("body", ""), apkUrl, prerelease);
            newestCode = code;
        }
        return newest;
    }

    private static long versionCode(String version) {
        if (version == null || !VERSION.matcher(version).matches()) {
            return -1;
        }
        String[] parts = version.split("\\.");
        try {
            long major = Long.parseLong(parts[0]);
            long minor = Long.parseLong(parts[1]);
            long patch = Long.parseLong(parts[2]);
            // Match the release allocator so numeric comparison cannot offer a
            // lower Android versionCode after a minor/major rollover.
            if (major > 2100 || minor > 999 || patch > 999) {
                return -1;
            }
            long code = major * 1_000_000L + minor * 1_000L + patch;
            return code <= MAX_VERSION_CODE ? code : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static String findApkAssetUrl(JSONArray assets) {
        if (assets == null) {
            return null;
        }
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.optJSONObject(i);
            if (asset == null
                    || !asset.optString("name", "").toLowerCase(Locale.ROOT).endsWith(".apk")
                    || !"uploaded".equals(asset.optString("state", ""))
                    || asset.optLong("size", 0) <= 0) {
                continue;
            }
            String url = asset.optString("browser_download_url", "");
            try {
                URI uri = new URI(url);
                if ("https".equalsIgnoreCase(uri.getScheme())
                        && uri.getHost() != null && uri.getUserInfo() == null) {
                    return url;
                }
            } catch (URISyntaxException ignored) {
                // A malformed asset must not hide another usable APK.
            }
        }
        return null;
    }
}
