package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import net.zetetic.database.sqlcipher.SQLiteCursor;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import org.junit.After;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Device-side coverage for the Capacitor 6 SQLCipher API backport. */
@RunWith(AndroidJUnit4.class)
public class SqlCipherCompatibilityInstrumentedTest {
    private static final String ENCRYPTED_DB = "sqlcipher-encrypted.db";
    private static final String PLAIN_DB = "sqlcipher-plain.db";

    @BeforeClass
    public static void loadSqlCipher() {
        System.loadLibrary("sqlcipher");
    }

    @After
    public void removeTestDatabases() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.deleteDatabase(ENCRYPTED_DB);
        context.deleteDatabase(PLAIN_DB);
    }

    @Test
    public void createsAndReopensEncryptedAndPlainDatabases() {
        assertDatabaseRoundTrip(ENCRYPTED_DB, "hipago-test-passphrase");
        assertDatabaseRoundTrip(PLAIN_DB, "");
    }

    private static void assertDatabaseRoundTrip(String name, String password) {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File file = context.getDatabasePath(name);
        assertTrue(file.getParentFile() == null || file.getParentFile().exists()
                || file.getParentFile().mkdirs());

        SQLiteDatabase database = SQLiteDatabase.openOrCreateDatabase(file, password, null, null);
        database.execSQL("CREATE TABLE state (value TEXT NOT NULL)");
        database.execSQL("INSERT INTO state(value) VALUES (?)", new Object[] { "preserved" });
        database.close();

        SQLiteDatabase reopened = SQLiteDatabase.openDatabase(
                file.getAbsolutePath(),
                password,
                null,
                SQLiteDatabase.OPEN_READWRITE,
                null
        );
        try (SQLiteCursor cursor = (SQLiteCursor) reopened.query("SELECT value FROM state")) {
            assertTrue(cursor.moveToFirst());
            assertEquals("preserved", cursor.getString(0));
        } finally {
            reopened.close();
        }
    }
}
