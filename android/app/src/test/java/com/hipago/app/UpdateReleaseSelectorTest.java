package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class UpdateReleaseSelectorTest {
    @Test
    public void stableExcludesDraftsAndPrereleases() throws Exception {
        JSONArray releases = new JSONArray()
                .put(release("v0.0.10", true))
                .put(release("v0.0.11", false).put("draft", true))
                .put(release("v0.0.9", false));

        UpdateReleaseSelector.Update update = UpdateReleaseSelector.select(releases, "0.0.8", false);

        assertNotNull(update);
        assertEquals("0.0.9", update.version);
        assertFalse(update.prerelease);
    }

    @Test
    public void betaSelectsHighestNumericVersionRegardlessOfApiOrder() throws Exception {
        JSONArray releases = new JSONArray()
                .put(release("v0.0.9", false))
                .put(release("v0.0.12", true).put("body", "Beta notes"))
                .put(release("v0.0.10", false))
                .put(release("v0.0.99", true).put("draft", true));

        UpdateReleaseSelector.Update update = UpdateReleaseSelector.select(releases, "0.0.8", true);

        assertNotNull(update);
        assertEquals("0.0.12", update.version);
        assertEquals("Beta notes", update.notes);
        assertEquals("https://github.com/VTSB/HiPaGo/releases/download/v0.0.12/HiPaGo.apk", update.apkUrl);
        assertTrue(update.prerelease);
    }

    @Test
    public void betaAlsoOffersHigherStableVersion() throws Exception {
        UpdateReleaseSelector.Update update = UpdateReleaseSelector.select(new JSONArray()
                .put(release("v1.0.0", false))
                .put(release("v0.999.999", true)), "0.0.8", true);

        assertEquals("1.0.0", update.version);
        assertFalse(update.prerelease);
    }

    @Test
    public void optingOutNeverOffersEqualOrOlderStableToInstalledBeta() throws Exception {
        JSONArray releases = new JSONArray()
                .put(release("v0.0.8", false))
                .put(release("v0.0.9", false))
                .put(release("v0.0.10", true));

        assertNull(UpdateReleaseSelector.select(releases, "0.0.9", false));
        assertNull(UpdateReleaseSelector.select(releases, "0.0.10", true));
        assertEquals("0.0.11", UpdateReleaseSelector.select(
                releases.put(release("v0.0.11", false)), "0.0.10", false).version);
    }

    @Test
    public void ignoresMalformedNoncanonicalAndUninstallableVersions() throws Exception {
        String[] invalid = {
                "", "0.0.99", "v1", "v1.2", "v1.2.3.4", "v01.2.3", "v1.02.3", "v1.2.03",
                "v1.2.3-beta.1", "v1.2.3+build", "v1.2.-3", "v1.2.x", "v1.2.3\n",
                "v9999999999999999999999999.0.0", "v0.0.1000", "v0.1000.0", "v2100.0.1",
                "v2148.0.0", "v 1.2.3", " v1.2.3"
        };
        JSONArray releases = new JSONArray();
        for (String tag : invalid) {
            releases.put(release(tag, true));
        }
        releases.put(JSONObject.NULL).put("not a release").put(release("v0.0.9", false));

        assertEquals("0.0.9", UpdateReleaseSelector.select(releases, "0.0.8", true).version);
    }

    @Test
    public void handlesVersionCodeCeilingAndRolloverWithoutOverflow() throws Exception {
        assertEquals("2100.0.0", UpdateReleaseSelector.select(new JSONArray()
                .put(release("v2100.0.0", true)), "2099.999.999", true).version);
        assertNull(UpdateReleaseSelector.select(new JSONArray()
                .put(release("v2100.0.1", true)), "2100.0.0", true));
        assertEquals("0.1.0", UpdateReleaseSelector.select(new JSONArray()
                .put(release("v0.1.0", true)), "0.0.999", true).version);
    }

    @Test
    public void malformedInstalledVersionFailsClosed() throws Exception {
        JSONArray releases = new JSONArray().put(release("v0.0.9", false));
        for (String installed : new String[] { null, "", "unknown", "0.0.08", "0.0.8-beta", "0.0.1000" }) {
            assertNull(UpdateReleaseSelector.select(releases, installed, true));
        }
    }

    @Test
    public void skipsReleasesWithoutUsableApksAndContinuesAfterBadAssets() throws Exception {
        JSONArray assets = new JSONArray()
                .put(JSONObject.NULL)
                .put(asset("notes.txt", "https://github.com/notes"))
                .put(asset("empty.apk", "https://github.com/empty.apk").put("size", 0))
                .put(asset("pending.apk", "https://github.com/pending.apk").put("state", "starter"))
                .put(asset("blank.apk", ""))
                .put(asset("relative.apk", "/relative.apk"))
                .put(asset("http.apk", "http://github.com/insecure.apk"))
                .put(asset("file.apk", "file:///tmp/app.apk"))
                .put(asset("bad.apk", "https://github.com/a bad.apk"))
                .put(asset("auth.apk", "https://user@github.com/auth.apk"));
        JSONArray releases = new JSONArray()
                .put(release("v0.0.20", true).put("assets", assets))
                .put(release("v0.0.19", true).put("assets", JSONObject.NULL))
                .put(release("v0.0.18", true).put("assets", new JSONArray()))
                .put(release("v0.0.9", false));

        assertEquals("0.0.9", UpdateReleaseSelector.select(releases, "0.0.8", true).version);
        assets.put(asset("HiPaGo.APK", "https://github.com/valid.apk"));
        UpdateReleaseSelector.Update update = UpdateReleaseSelector.select(releases, "0.0.8", true);
        assertEquals("0.0.20", update.version);
        assertEquals("https://github.com/valid.apk", update.apkUrl);
    }

    @Test
    public void emptyOrMissingReleaseListHasNoUpdate() {
        assertNull(UpdateReleaseSelector.select(null, "0.0.8", true));
        assertNull(UpdateReleaseSelector.select(new JSONArray(), "0.0.8", true));
    }

    private static JSONObject release(String tag, boolean prerelease) throws Exception {
        return new JSONObject()
                .put("tag_name", tag)
                .put("draft", false)
                .put("prerelease", prerelease)
                .put("assets", new JSONArray().put(asset("HiPaGo.apk",
                        "https://github.com/VTSB/HiPaGo/releases/download/" + tag + "/HiPaGo.apk")));
    }

    private static JSONObject asset(String name, String url) throws Exception {
        return new JSONObject().put("name", name).put("browser_download_url", url)
                .put("state", "uploaded").put("size", 1234);
    }
}
