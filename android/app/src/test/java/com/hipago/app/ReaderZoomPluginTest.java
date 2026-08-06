package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 34)
public class ReaderZoomPluginTest {

    @Test
    public void disablingResetsScaleBeforeTurningOffZoomSupport() {
        FakeZoomTarget target = new FakeZoomTarget(2.5f);

        ReaderZoomPlugin.applyZoomState(target, false);

        assertEquals(0.4f, target.zoomFactor, 0.0001f);
        assertFalse(target.supportZoom);
        assertFalse(target.builtInZoomControls);
        assertFalse(target.displayZoomControls);
        assertEquals(
            List.of("getScale", "zoomBy", "setSupportZoom", "setBuiltInZoomControls", "setDisplayZoomControls"),
            target.events
        );
    }

    @Test
    public void invalidOrAlreadyResetScaleDoesNotIssueUnsafeZoom() {
        FakeZoomTarget invalidTarget = new FakeZoomTarget(Float.NaN);
        ReaderZoomPlugin.applyZoomState(invalidTarget, false);
        assertEquals(0, invalidTarget.zoomCalls);

        FakeZoomTarget resetTarget = new FakeZoomTarget(1.0f);
        ReaderZoomPlugin.applyZoomState(resetTarget, false);
        assertEquals(0, resetTarget.zoomCalls);
    }

    @Test
    public void latestDisableWinsWhenUiTasksRunOutOfOrder() {
        ReaderZoomPlugin plugin = new ReaderZoomPlugin();
        QueuedUiThread uiThread = new QueuedUiThread();
        FakeZoomTarget target = new FakeZoomTarget(2.0f);
        AtomicInteger completions = new AtomicInteger();

        plugin.enqueueZoomChange(true, uiThread, () -> target, completions::incrementAndGet);
        plugin.enqueueZoomChange(false, uiThread, () -> target, completions::incrementAndGet);

        uiThread.runAt(1);
        uiThread.runAt(0);

        assertFalse(target.supportZoom);
        assertFalse(target.builtInZoomControls);
        assertEquals(0.5f, target.zoomFactor, 0.0001f);
        assertEquals(2, completions.get());
    }

    @Test
    public void latestEnableWinsWhenOlderDisableRunsLast() {
        ReaderZoomPlugin plugin = new ReaderZoomPlugin();
        QueuedUiThread uiThread = new QueuedUiThread();
        FakeZoomTarget target = new FakeZoomTarget(2.0f);

        plugin.enqueueZoomChange(false, uiThread, () -> target, () -> {});
        plugin.enqueueZoomChange(true, uiThread, () -> target, () -> {});

        uiThread.runAt(1);
        uiThread.runAt(0);

        assertTrue(target.supportZoom);
        assertTrue(target.builtInZoomControls);
        assertFalse(target.displayZoomControls);
        assertEquals(0, target.zoomCalls);
    }

    private static final class QueuedUiThread implements ReaderZoomPlugin.UiThreadRunner {
        private final List<Runnable> tasks = new ArrayList<>();

        @Override
        public void run(Runnable action) {
            tasks.add(action);
        }

        void runAt(int index) {
            tasks.get(index).run();
        }
    }

    private static final class FakeZoomTarget implements ReaderZoomPlugin.ZoomTarget {
        private final float scale;
        private final List<String> events = new ArrayList<>();
        private float zoomFactor = 1.0f;
        private int zoomCalls;
        private boolean supportZoom;
        private boolean builtInZoomControls;
        private boolean displayZoomControls = true;

        FakeZoomTarget(float scale) {
            this.scale = scale;
        }

        @Override
        public float getScale() {
            events.add("getScale");
            return scale;
        }

        @Override
        public void zoomBy(float factor) {
            events.add("zoomBy");
            zoomFactor = factor;
            zoomCalls += 1;
        }

        @Override
        public void setSupportZoom(boolean enabled) {
            events.add("setSupportZoom");
            supportZoom = enabled;
        }

        @Override
        public void setBuiltInZoomControls(boolean enabled) {
            events.add("setBuiltInZoomControls");
            builtInZoomControls = enabled;
        }

        @Override
        public void setDisplayZoomControls(boolean enabled) {
            events.add("setDisplayZoomControls");
            displayZoomControls = enabled;
        }
    }
}
