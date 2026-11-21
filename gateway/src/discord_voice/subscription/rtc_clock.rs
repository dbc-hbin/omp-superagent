use tokio::time::{Instant, sleep_until};

use super::FRAME_DURATION;

pub(super) struct FrameClock {
    deadline: Instant,
}

impl FrameClock {
    pub(super) fn new() -> Self {
        Self {
            deadline: Instant::now(),
        }
    }

    pub(super) async fn tick(&mut self) {
        if Instant::now() < self.deadline {
            sleep_until(self.deadline).await;
        }
        // Keep the original phase through ordinary scheduling jitter; a larger
        // stall permits one immediate catch-up frame without replaying all misses.
        self.deadline = (self.deadline + FRAME_DURATION).max(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt as _;
    use std::time::Duration;
    use tokio::time::advance;

    #[tokio::test(start_paused = true)]
    async fn ordinary_lateness_keeps_phase_and_long_stalls_catch_up_only_once() {
        let mut clock = FrameClock::new();
        assert!(clock.tick().now_or_never().is_some());

        advance(Duration::from_millis(28)).await;
        assert!(clock.tick().now_or_never().is_some());
        advance(Duration::from_millis(11)).await;
        assert!(clock.tick().now_or_never().is_none());
        advance(Duration::from_millis(1)).await;
        assert!(clock.tick().now_or_never().is_some());

        advance(Duration::from_millis(101)).await;
        assert!(clock.tick().now_or_never().is_some());
        assert!(clock.tick().now_or_never().is_some());
        assert!(clock.tick().now_or_never().is_none());
        advance(Duration::from_millis(20)).await;
        assert!(clock.tick().now_or_never().is_some());
    }
}
