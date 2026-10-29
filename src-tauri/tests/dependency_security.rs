//! Regression evidence for the older block-buffer representation used by the
//! Ethereum keystore. GHSA-qwgh-2vcv-g2f7 describes a cursor stored inside the
//! caller-writable block; 0.10 keeps that cursor in a separate field.

use block_buffer::{EagerBuffer, generic_array::typenum::U4};
use std::panic::{AssertUnwindSafe, catch_unwind};

#[test]
fn legacy_block_buffer_keeps_its_cursor_valid_after_compression_panics() {
    let mut buffer = EagerBuffer::<U4>::new(&[1, 2]);
    let failure = catch_unwind(AssertUnwindSafe(|| {
        buffer.digest_blocks(&[3, 0xff], |_| panic!("compression failure"));
    }));
    assert!(failure.is_err());
    assert_eq!(buffer.get_pos(), 2);

    let mut blocks = Vec::new();
    buffer.digest_blocks(&[4, 5], |completed| {
        blocks.extend(completed.iter().map(|block| block.to_vec()));
    });
    assert_eq!(blocks, [vec![1, 2, 4, 5]]);
    assert_eq!(buffer.get_pos(), 0);
}
