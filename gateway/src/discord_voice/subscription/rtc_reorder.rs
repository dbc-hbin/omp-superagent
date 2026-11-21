use std::{future::pending, time::Duration};
use tokio::time::{Instant, sleep_until};

const WINDOW: usize = 16;
const GAP_WAIT: Duration = Duration::from_millis(40);
const HALF_SEQUENCE_SPACE: u16 = 1 << 15;
const _: () = assert!(WINDOW.is_power_of_two());

struct Entry<T> {
    sequence: u16,
    arrived: Instant,
    value: T,
}

pub(super) struct RtpOrder<T> {
    next: Option<u16>,
    slots: [Option<Entry<T>>; WINDOW],
}

impl<T> Default for RtpOrder<T> {
    fn default() -> Self {
        Self {
            next: None,
            slots: std::array::from_fn(|_| None),
        }
    }
}

impl<T> RtpOrder<T> {
    pub(super) fn insert(&mut self, sequence: u16, arrived: Instant, value: T) {
        let next = self.next.get_or_insert(sequence);
        let distance = sequence.wrapping_sub(*next);
        if distance >= HALF_SEQUENCE_SPACE {
            return;
        }
        if usize::from(distance) >= WINDOW {
            // A large forward discontinuity overruns the window. Drop the old
            // pending packets rather than accumulating latency behind the gap.
            self.slots.fill_with(|| None);
            *next = sequence;
        }
        self.slots[usize::from(sequence) % WINDOW].get_or_insert(Entry {
            sequence,
            arrived,
            value,
        });
    }

    pub(super) fn pop_ready(&mut self, now: Instant) -> Option<T> {
        let next = self.next?;
        let next_slot = usize::from(next) % WINDOW;
        let entry = if let Some(entry) = self.slots[next_slot].take() {
            entry
        } else {
            if now < self.deadline()? {
                return None;
            }
            // Skip only to the nearest buffered sequence, even across wrap.
            let (index, _) = self
                .slots
                .iter()
                .enumerate()
                .filter_map(|(index, entry)| entry.as_ref().map(|entry| (index, entry)))
                .min_by_key(|(_, entry)| entry.sequence.wrapping_sub(next))?;
            self.slots[index].take()?
        };
        self.next = Some(entry.sequence.wrapping_add(1));
        Some(entry.value)
    }

    pub(super) async fn wait_for_gap(&self) {
        match self.deadline() {
            Some(deadline) => sleep_until(deadline).await,
            None => pending().await,
        }
    }

    fn deadline(&self) -> Option<Instant> {
        // Later arrivals and retransmissions never extend an existing gap.
        self.slots
            .iter()
            .flatten()
            .map(|entry| entry.arrived)
            .min()
            .map(|arrived| arrived + GAP_WAIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt as _;
    use tokio::time::timeout;

    #[test]
    fn reorders_across_wrap_and_never_replays_duplicates() {
        let now = Instant::now();
        let mut order = RtpOrder::default();
        order.insert(u16::MAX - 1, now, "first");
        assert_eq!(order.pop_ready(now), Some("first"));

        order.insert(0, now, "third");
        order.insert(0, now, "retransmitted");
        assert_eq!(order.pop_ready(now), None);
        order.insert(u16::MAX, now, "second");
        assert_eq!(order.pop_ready(now), Some("second"));
        assert_eq!(order.pop_ready(now), Some("third"));
        order.insert(u16::MAX, now, "late duplicate");
        assert_eq!(order.pop_ready(now + GAP_WAIT), None);
    }

    #[tokio::test(start_paused = true)]
    async fn loss_releases_the_nearest_packet_without_waiting_for_new_rtp() {
        let now = Instant::now();
        let mut order = RtpOrder::default();
        order.insert(10, now, "first");
        assert_eq!(order.pop_ready(now), Some("first"));

        order.insert(13, now, "fourth");
        order.insert(12, now + Duration::from_millis(5), "third");
        order.insert(13, now + Duration::from_millis(10), "retransmitted fourth");
        assert_eq!(
            order.pop_ready(now + GAP_WAIT - Duration::from_millis(1)),
            None
        );
        assert!(order.wait_for_gap().now_or_never().is_none());
        timeout(GAP_WAIT * 2, order.wait_for_gap()).await.unwrap();
        assert!(Instant::now() >= now + GAP_WAIT);
        assert_eq!(order.pop_ready(now + GAP_WAIT), Some("third"));
        assert_eq!(order.pop_ready(Instant::now()), Some("fourth"));
        order.insert(11, Instant::now(), "too late");
        order.insert(14, Instant::now(), "fifth");
        assert_eq!(order.pop_ready(Instant::now()), Some("fifth"));
        assert_eq!(order.pop_ready(Instant::now()), None);
    }

    #[test]
    fn a_forward_jump_overruns_the_window_without_waiting_for_missing_packets() {
        let now = Instant::now();
        let mut order = RtpOrder::default();
        order.insert(4, now, "first");
        assert_eq!(order.pop_ready(now), Some("first"));
        order.insert(6, now, "stranded");

        order.insert(40, now, "jump");
        assert_eq!(order.pop_ready(now), Some("jump"));
        assert_eq!(order.pop_ready(now + GAP_WAIT), None);
    }
}
