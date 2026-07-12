use std::collections::HashMap;
use std::future::poll_fn;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::task::Poll;

use futures_util::task::AtomicWaker;

use crate::wallet::domain::BotKind;

/// Coordinates one fenced start/stop lifecycle for every wallet-bound bot.
#[derive(Clone, Default)]
pub(crate) struct BotLifecycleCoordinator {
    inner: Arc<BotLifecycleInner>,
}

#[derive(Default)]
struct BotLifecycleInner {
    state: Mutex<BotLifecycleState>,
    changed: Condvar,
}

#[derive(Default)]
struct BotLifecycleState {
    next_generation: u64,
    core_generation: u64,
    bots: HashMap<BotKind, BotLifecycleSlot>,
}

#[derive(Default)]
struct BotLifecycleSlot {
    operation: Option<BotLifecycleOperation>,
    active: Option<ActiveBotLifecycle>,
}

struct ActiveBotLifecycle {
    generation: u64,
    cancellation: BotStartCancellation,
}

enum BotLifecycleOperation {
    Starting {
        generation: u64,
        core_generation: u64,
        cancellation: BotStartCancellation,
    },
    Stopping {
        generation: u64,
    },
    Mutating {
        generation: u64,
    },
}

#[derive(Clone, Default)]
struct BotStartCancellation {
    inner: Arc<BotStartCancellationState>,
}

#[derive(Default)]
struct BotStartCancellationState {
    cancelled: AtomicBool,
    waker: AtomicWaker,
}

/// Exclusive, generation-fenced ownership of one bot start attempt.
pub(crate) struct BotStartReservation {
    coordinator: BotLifecycleCoordinator,
    bot_kind: BotKind,
    generation: u64,
    core_generation: u64,
    cancellation: BotStartCancellation,
}

/// Cancellation lease retained by the worker after its start reservation is released.
#[derive(Clone)]
pub(crate) struct BotWorkerLifecycleLease {
    generation: u64,
    cancellation: BotStartCancellation,
}

/// Exclusive ownership of one bot stop while pending starts unwind.
pub(crate) struct BotStopReservation {
    coordinator: BotLifecycleCoordinator,
    bot_kind: BotKind,
    generation: u64,
}

struct BotMutationReservation {
    coordinator: BotLifecycleCoordinator,
    bot_kind: BotKind,
    generation: u64,
}

impl BotLifecycleCoordinator {
    /// Reserves a bot generation before any asynchronous start work begins.
    pub(crate) fn reserve_start(&self, bot_kind: BotKind) -> Result<BotStartReservation, String> {
        let mut state = self.lock_state()?;
        let occupied = state
            .bots
            .get(&bot_kind)
            .is_some_and(|slot| slot.operation.is_some() || slot.active.is_some());
        if occupied {
            return Err("Bot is already active or changing state.".to_owned());
        }

        let generation = next_generation(&mut state);
        let core_generation = state.core_generation;
        let cancellation = BotStartCancellation::default();
        state.bots.entry(bot_kind).or_default().operation = Some(BotLifecycleOperation::Starting {
            generation,
            core_generation,
            cancellation: cancellation.clone(),
        });

        Ok(BotStartReservation {
            coordinator: self.clone(),
            bot_kind,
            generation,
            core_generation,
            cancellation,
        })
    }

    /// Cancels a pending start, then excludes new starts until the caller finishes stopping.
    pub(crate) fn reserve_stop(&self, bot_kind: BotKind) -> Result<BotStopReservation, String> {
        let mut state = self.lock_state()?;
        loop {
            match state
                .bots
                .get(&bot_kind)
                .and_then(|slot| slot.operation.as_ref())
            {
                Some(BotLifecycleOperation::Starting { cancellation, .. }) => {
                    cancellation.cancel();
                    state = self
                        .inner
                        .changed
                        .wait(state)
                        .map_err(|_| "Failed to wait for bot start cancellation".to_owned())?;
                }
                Some(BotLifecycleOperation::Stopping { .. }) => {
                    state = self
                        .inner
                        .changed
                        .wait(state)
                        .map_err(|_| "Failed to wait for the active bot stop".to_owned())?;
                }
                Some(BotLifecycleOperation::Mutating { .. }) => {
                    state = self
                        .inner
                        .changed
                        .wait(state)
                        .map_err(|_| "Failed to wait for the active bot update".to_owned())?;
                }
                None => {
                    if let Some(active) = state
                        .bots
                        .get(&bot_kind)
                        .and_then(|slot| slot.active.as_ref())
                    {
                        active.cancellation.cancel();
                    }
                    break;
                }
            }
        }

        let generation = next_generation(&mut state);
        state.bots.entry(bot_kind).or_default().operation =
            Some(BotLifecycleOperation::Stopping { generation });
        Ok(BotStopReservation {
            coordinator: self.clone(),
            bot_kind,
            generation,
        })
    }

    /// Excludes start/stop while one non-running bot mutation commits.
    pub(crate) fn with_idle_bot_mutation<T>(
        &self,
        bot_kind: BotKind,
        mutation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let reservation = self.reserve_mutation(bot_kind)?;
        let result = mutation();
        drop(reservation);
        result
    }

    /// Invalidates every pending start whenever the supervised core changes generation.
    pub(crate) fn invalidate_core(&self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.core_generation = state
                .core_generation
                .checked_add(1)
                .expect("core lifecycle generation exhausted");
            for slot in state.bots.values() {
                if let Some(BotLifecycleOperation::Starting { cancellation, .. }) =
                    slot.operation.as_ref()
                {
                    cancellation.cancel();
                }
                if let Some(active) = slot.active.as_ref() {
                    active.cancellation.cancel();
                }
            }
        }
    }

    /// Runs a state mutation only while the exact pending start still owns its generation.
    pub(crate) fn with_current_start<T>(
        &self,
        reservation: &BotStartReservation,
        mutation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self.lock_state()?;
        validate_start_state(&state, reservation)?;
        mutation()
    }

    /// Atomically publishes a controller before its worker may consume wallet material.
    pub(crate) fn commit_start<T>(
        &self,
        reservation: &BotStartReservation,
        publish: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.lock_state()?;
        validate_start_state(&state, reservation)?;
        state.bots.entry(reservation.bot_kind).or_default().active = Some(ActiveBotLifecycle {
            generation: reservation.generation,
            cancellation: reservation.cancellation.clone(),
        });
        match publish() {
            Ok(value) => Ok(value),
            Err(error) => {
                if let Some(slot) = state.bots.get_mut(&reservation.bot_kind)
                    && slot
                        .active
                        .as_ref()
                        .is_some_and(|active| active.generation == reservation.generation)
                {
                    slot.active = None;
                }
                Err(error)
            }
        }
    }

    /// Clears active ownership only when the exiting controller still owns the generation.
    pub(crate) fn finish_controller(&self, bot_kind: BotKind, generation: u64) {
        if let Ok(mut state) = self.inner.state.lock()
            && let Some(slot) = state.bots.get_mut(&bot_kind)
            && slot
                .active
                .as_ref()
                .is_some_and(|active| active.generation == generation)
        {
            slot.active = None;
            self.inner.changed.notify_all();
        }
    }

    fn validate_start(&self, reservation: &BotStartReservation) -> Result<(), String> {
        let state = self.lock_state()?;
        validate_start_state(&state, reservation)
    }

    fn reserve_mutation(&self, bot_kind: BotKind) -> Result<BotMutationReservation, String> {
        let mut state = self.lock_state()?;
        let occupied = state
            .bots
            .get(&bot_kind)
            .is_some_and(|slot| slot.operation.is_some() || slot.active.is_some());
        if occupied {
            return Err("Stop the bot before changing its wallet assignment.".to_owned());
        }
        let generation = next_generation(&mut state);
        state.bots.entry(bot_kind).or_default().operation =
            Some(BotLifecycleOperation::Mutating { generation });
        Ok(BotMutationReservation {
            coordinator: self.clone(),
            bot_kind,
            generation,
        })
    }

    fn finish_start(&self, bot_kind: BotKind, generation: u64) {
        if let Ok(mut state) = self.inner.state.lock()
            && let Some(slot) = state.bots.get_mut(&bot_kind)
            && matches!(
                slot.operation,
                Some(BotLifecycleOperation::Starting {
                    generation: current,
                    ..
                }) if current == generation
            )
        {
            slot.operation = None;
            self.inner.changed.notify_all();
        }
    }

    fn finish_stop(&self, bot_kind: BotKind, generation: u64) {
        if let Ok(mut state) = self.inner.state.lock()
            && let Some(slot) = state.bots.get_mut(&bot_kind)
            && matches!(
                slot.operation,
                Some(BotLifecycleOperation::Stopping {
                    generation: current,
                }) if current == generation
            )
        {
            slot.operation = None;
            slot.active = None;
            self.inner.changed.notify_all();
        }
    }

    fn finish_mutation(&self, bot_kind: BotKind, generation: u64) {
        if let Ok(mut state) = self.inner.state.lock()
            && let Some(slot) = state.bots.get_mut(&bot_kind)
            && matches!(
                slot.operation,
                Some(BotLifecycleOperation::Mutating {
                    generation: current,
                }) if current == generation
            )
        {
            slot.operation = None;
            self.inner.changed.notify_all();
        }
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, BotLifecycleState>, String> {
        self.inner
            .state
            .lock()
            .map_err(|_| "Failed to lock bot lifecycle state".to_owned())
    }
}

impl BotStartReservation {
    /// Returns the bot kind owned by this reservation.
    pub(crate) fn bot_kind(&self) -> BotKind {
        self.bot_kind
    }

    /// Returns the controller generation carried into the supervisor worker.
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// Creates the cancellation lease retained by the generation-tagged worker.
    pub(crate) fn worker_lease(&self) -> BotWorkerLifecycleLease {
        BotWorkerLifecycleLease {
            generation: self.generation,
            cancellation: self.cancellation.clone(),
        }
    }

    /// Returns true after bot stop or a core generation change cancels this start.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    /// Resolves as soon as bot stop or a core generation change cancels this start.
    pub(crate) async fn cancelled(&self) {
        self.cancellation.cancelled().await;
    }

    /// Verifies that this exact bot and core generation still owns the pending start.
    pub(crate) fn validate(&self) -> Result<(), String> {
        self.coordinator.validate_start(self)
    }
}

impl BotWorkerLifecycleLease {
    /// Returns the worker generation used for state and controller fencing.
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// Returns true after core invalidation or explicit bot stop.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }
}

impl Drop for BotStartReservation {
    fn drop(&mut self) {
        self.coordinator
            .finish_start(self.bot_kind, self.generation);
    }
}

impl Drop for BotStopReservation {
    fn drop(&mut self) {
        self.coordinator.finish_stop(self.bot_kind, self.generation);
    }
}

impl Drop for BotMutationReservation {
    fn drop(&mut self) {
        self.coordinator
            .finish_mutation(self.bot_kind, self.generation);
    }
}

impl BotStartCancellation {
    fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.waker.wake();
    }

    fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        poll_fn(|context| {
            if self.is_cancelled() {
                return Poll::Ready(());
            }
            self.inner.waker.register(context.waker());
            if self.is_cancelled() {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await
    }
}

fn validate_start_state(
    state: &BotLifecycleState,
    reservation: &BotStartReservation,
) -> Result<(), String> {
    if reservation.is_cancelled() || state.core_generation != reservation.core_generation {
        return Err("Bot start was cancelled because the desktop runtime changed.".to_owned());
    }
    let current = state
        .bots
        .get(&reservation.bot_kind)
        .and_then(|slot| slot.operation.as_ref());
    if !matches!(
        current,
        Some(BotLifecycleOperation::Starting {
            generation,
            core_generation,
            ..
        }) if *generation == reservation.generation
            && *core_generation == reservation.core_generation
    ) {
        return Err("Bot start no longer owns the active lifecycle generation.".to_owned());
    }
    Ok(())
}

fn next_generation(state: &mut BotLifecycleState) -> u64 {
    state.next_generation = state
        .next_generation
        .checked_add(1)
        .expect("bot lifecycle generation exhausted");
    state.next_generation
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::*;

    #[test]
    fn one_pending_start_owns_each_bot() {
        let lifecycle = BotLifecycleCoordinator::default();
        let first = lifecycle.reserve_start(BotKind::Bidding).unwrap();

        assert!(lifecycle.reserve_start(BotKind::Bidding).is_err());
        assert!(lifecycle.reserve_start(BotKind::Sniping).is_ok());
        assert!(first.validate().is_ok());
    }

    #[test]
    fn stop_cancels_and_waits_for_pending_start() {
        let lifecycle = BotLifecycleCoordinator::default();
        let start = lifecycle.reserve_start(BotKind::Bidding).unwrap();
        let stop_lifecycle = lifecycle.clone();
        let (stop_reserved_tx, stop_reserved_rx) = mpsc::channel();

        let stop_thread = thread::spawn(move || {
            let stop = stop_lifecycle.reserve_stop(BotKind::Bidding).unwrap();
            stop_reserved_tx.send(()).unwrap();
            drop(stop);
        });

        for _ in 0..100 {
            if start.is_cancelled() {
                break;
            }
            thread::sleep(Duration::from_millis(1));
        }
        assert!(start.is_cancelled());
        assert!(stop_reserved_rx.try_recv().is_err());

        drop(start);
        stop_reserved_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        stop_thread.join().unwrap();
    }

    #[test]
    fn core_generation_change_invalidates_pending_start() {
        let lifecycle = BotLifecycleCoordinator::default();
        let start = lifecycle.reserve_start(BotKind::Bidding).unwrap();

        lifecycle.invalidate_core();

        assert!(start.is_cancelled());
        assert!(start.validate().is_err());
    }

    #[test]
    fn core_generation_change_cancels_an_active_worker_lease() {
        let lifecycle = BotLifecycleCoordinator::default();
        let start = lifecycle.reserve_start(BotKind::Bidding).unwrap();
        let worker = start.worker_lease();
        lifecycle.commit_start(&start, || Ok(())).unwrap();
        drop(start);

        lifecycle.invalidate_core();

        assert!(worker.is_cancelled());
    }

    #[test]
    fn stop_cancels_an_active_worker_lease_and_excludes_restart() {
        let lifecycle = BotLifecycleCoordinator::default();
        let start = lifecycle.reserve_start(BotKind::Bidding).unwrap();
        let worker = start.worker_lease();
        lifecycle.commit_start(&start, || Ok(())).unwrap();
        drop(start);

        let stop = lifecycle.reserve_stop(BotKind::Bidding).unwrap();

        assert!(worker.is_cancelled());
        assert!(lifecycle.reserve_start(BotKind::Bidding).is_err());
        drop(stop);
        assert!(lifecycle.reserve_start(BotKind::Bidding).is_ok());
    }

    #[test]
    fn idle_mutation_excludes_a_concurrent_start() {
        let lifecycle = BotLifecycleCoordinator::default();
        let mutation_lifecycle = lifecycle.clone();

        lifecycle
            .with_idle_bot_mutation(BotKind::Bidding, || {
                assert!(mutation_lifecycle.reserve_start(BotKind::Bidding).is_err());
                Ok(())
            })
            .unwrap();

        assert!(lifecycle.reserve_start(BotKind::Bidding).is_ok());
    }

    #[test]
    fn stale_controller_cannot_mutate_a_new_generation() {
        let lifecycle = BotLifecycleCoordinator::default();
        let start = lifecycle.reserve_start(BotKind::Bidding).unwrap();
        let generation = start.generation();
        lifecycle.commit_start(&start, || Ok(())).unwrap();
        drop(start);

        lifecycle.finish_controller(BotKind::Bidding, generation);
        let next = lifecycle.reserve_start(BotKind::Bidding).unwrap();
        let next_generation = next.generation();
        lifecycle.commit_start(&next, || Ok(())).unwrap();
        drop(next);

        lifecycle.finish_controller(BotKind::Bidding, generation);
        assert!(lifecycle.reserve_start(BotKind::Bidding).is_err());

        lifecycle.finish_controller(BotKind::Bidding, next_generation);
        assert!(lifecycle.reserve_start(BotKind::Bidding).is_ok());
        assert!(next_generation > generation);
    }
}
