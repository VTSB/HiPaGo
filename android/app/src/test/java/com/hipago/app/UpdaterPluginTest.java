package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Pure JVM tests for release-asset selection before DownloadManager is used. */
public class UpdaterPluginTest {
    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    @Test
    public void selectsOnlyTheExactUniversalAssetForTheReleaseVersion() throws Exception {
        JSONArray assets = new JSONArray();
        assets.put(asset(
                "attacker.apk",
                "https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/attacker.apk"
        ));
        assets.put(asset(
                "HiPaGo_1.2.3_android_universal.apk",
                "https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/"
                        + "HiPaGo_1.2.3_android_universal.apk"
        ));

        assertEquals(
                "https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/"
                        + "HiPaGo_1.2.3_android_universal.apk",
                UpdaterPlugin.findApkAssetUrl(assets, "1.2.3")
        );
    }

    @Test
    public void returnsNullWhenTheApprovedAssetNameIsMissing() throws Exception {
        JSONArray assets = new JSONArray();
        assets.put(asset(
                "app-release.apk",
                "https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/app-release.apk"
        ));

        assertNull(UpdaterPlugin.findApkAssetUrl(assets, "1.2.3"));
    }

    @Test
    public void rejectsAnApprovedNameWithAnUnapprovedUrl() throws Exception {
        JSONArray assets = new JSONArray();
        assets.put(asset(
                "HiPaGo_1.2.3_android_universal.apk",
                "https://evil.example/HiPaGo_1.2.3_android_universal.apk"
        ));

        try {
            UpdaterPlugin.findApkAssetUrl(assets, "1.2.3");
            fail("Expected invalid release asset URL");
        } catch (IllegalArgumentException expected) {
            // expected
        }
    }

    @Test
    public void staleApkDeletionFailsClosed() throws Exception {
        File stale = temp.newFile("stale.apk");
        Files.write(stale.toPath(), "old".getBytes(StandardCharsets.UTF_8));
        assertTrue(UpdaterPlugin.removeStaleApk(stale));
        assertFalse(stale.exists());

        File missing = new File(temp.getRoot(), "missing.apk");
        assertTrue(UpdaterPlugin.removeStaleApk(missing));

        File nonEmptyDirectory = temp.newFolder("blocked.apk");
        Files.write(
                new File(nonEmptyDirectory, "child").toPath(),
                "x".getBytes(StandardCharsets.UTF_8)
        );
        assertFalse(UpdaterPlugin.removeStaleApk(nonEmptyDirectory));
        assertTrue(nonEmptyDirectory.exists());
    }

    private static JSONObject asset(String name, String url) throws Exception {
        JSONObject result = new JSONObject();
        result.put("name", name);
        result.put("browser_download_url", url);
        return result;
    }
}
