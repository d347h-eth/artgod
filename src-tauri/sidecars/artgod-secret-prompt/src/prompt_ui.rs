use std::cmp::{max, min};
use std::num::NonZeroU32;
use std::rc::Rc;
use std::time::{Duration, Instant};

use arboard::Clipboard;
use softbuffer::{Context, Surface};
use thiserror::Error;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::window::{Window, WindowAttributes, WindowId};
use zeroize::{Zeroize, Zeroizing};

use crate::generated_font::{
    ADVANCE_WIDTH, ASCII_END, ASCII_GLYPHS, ASCII_START, CELL_HEIGHT, CELL_WIDTH,
};
use crate::owner_liveness::{OwnerLiveness, OwnerLivenessEvent};

mod generated_window_size {
    include!(concat!(env!("OUT_DIR"), "/generated_window_size.rs"));
}

const BACKGROUND: u32 = 0x101317;
const PANEL: u32 = 0x171C22;
const PANEL_MUTED: u32 = 0x1F2630;
const PANEL_BORDER: u32 = 0x2F3945;
const PANEL_BORDER_ACTIVE: u32 = 0xC6D2E0;
const TEXT: u32 = 0xF3F5F7;
const TEXT_MUTED: u32 = 0x95A1B0;
const BUTTON_PRIMARY: u32 = 0xD1E4FF;
const BUTTON_PRIMARY_TEXT: u32 = 0x0F1822;
const BUTTON_SECONDARY: u32 = 0x26303B;
const BUTTON_SECONDARY_TEXT: u32 = 0xE6EBF1;
const BUTTON_DISABLED: u32 = 0x1E242C;
const BUTTON_DISABLED_TEXT: u32 = 0x667381;
const CARET: u32 = 0xF3F5F7;
const MASK: u32 = 0xE6EBF1;
const WARNING: u32 = 0xF4D35E;
const ARTGOD_CYAN: u32 = 0x93D1DE;
const ARTGOD_YELLOW: u32 = 0xF6E518;
const SUCCESS: u32 = ARTGOD_CYAN;
const BIDDING_REVIEW_LABEL: u32 = ARTGOD_CYAN;
const BIDDING_REVIEW_AMOUNT: u32 = ARTGOD_YELLOW;

const LINE_HEIGHT: i32 = CELL_HEIGHT as i32;
const BUTTON_HEIGHT: i32 = 48;
const BUTTON_GAP: i32 = 16;
const BUTTON_WIDTH: i32 = 164;
const CONTENT_MARGIN: i32 = 28;
const BUTTON_EDGE_INSET: i32 = 18;
const FIELD_INNER_PADDING_X: i32 = 18;
const FIELD_INNER_PADDING_Y: i32 = 10;
const CARET_TEXT_GAP_PX: i32 = 4;
const FIELD_HEIGHT: i32 = CELL_HEIGHT as i32 + (FIELD_INNER_PADDING_Y * 2);
const TEXT_WINDOW_SIZE: (u32, u32) = (820, 360);
const UNLOCK_WINDOW_SIZE: (u32, u32) = (920, 460);
// Uses the canonical Admin launch dimensions for complete bidding authorization pages.
const BIDDING_REVIEW_WINDOW_SIZE: (u32, u32) = generated_window_size::ADMIN_WINDOW_SIZE;
const REVEAL_WINDOW_SIZE: (u32, u32) = (920, 420);
const STARTUP_SUBMIT_GUARD: Duration = Duration::from_millis(250);
const REVIEW_NEXT_LABEL: &str = "Next";

pub struct TextPromptSpec<'a> {
    pub title: &'a str,
    pub message: &'a str,
    pub initial_value: &'a str,
    pub mode: TextPromptMode,
    pub ok_label: &'a str,
    pub cancel_label: &'a str,
    pub input_kind: TextInputKind,
    pub max_len: usize,
    pub validation: TextValidationSpec<'a>,
}

pub struct UnlockPromptSpec<'a> {
    pub title: &'a str,
    pub passphrase_message: &'a str,
    pub review_pages: Vec<BiddingReviewPage>,
    pub unlock_label: &'a str,
    pub cancel_label: &'a str,
}

/// One trusted bidding-authorization review page rendered before wallet unlock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BiddingReviewPage {
    pub heading: Option<String>,
    pub rows: Vec<BiddingReviewRow>,
}

/// One label and its styled values on a bidding-authorization review page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BiddingReviewRow {
    pub indentation_columns: usize,
    pub label: String,
    pub values: Vec<BiddingReviewValue>,
}

impl BiddingReviewRow {
    /// Builds a non-price row whose value keeps the ordinary text color.
    pub(crate) fn plain(label: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            indentation_columns: 0,
            label: label.into(),
            values: vec![BiddingReviewValue::Plain(value.into())],
        }
    }

    /// Builds a nested non-price row for collection scope details.
    pub(crate) fn indented_plain(
        indentation_columns: usize,
        label: impl Into<String>,
        value: impl Into<String>,
    ) -> Self {
        Self {
            indentation_columns,
            label: label.into(),
            values: vec![BiddingReviewValue::Plain(value.into())],
        }
    }

    /// Builds a row with explicitly typed plain and highlighted value segments.
    pub(crate) fn with_values(label: impl Into<String>, values: Vec<BiddingReviewValue>) -> Self {
        Self {
            indentation_columns: 0,
            label: label.into(),
            values,
        }
    }
}

/// A plain or exclusively highlighted value segment in a bidding review row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BiddingReviewValue {
    Plain(String),
    Amount(String),
}

impl BiddingReviewValue {
    /// Keeps contextual value text in the ordinary text color.
    pub(crate) fn plain(value: impl Into<String>) -> Self {
        Self::Plain(value.into())
    }

    /// Highlights one exact amount and its unit with the bidding amount color.
    pub(crate) fn amount(value: impl Into<String>) -> Self {
        Self::Amount(value.into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextPromptMode {
    Plain,
    Secret,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextInputKind {
    Label,
    PrivateKey,
    Passphrase,
    Confirmation,
}

pub struct ConfirmPromptSpec<'a> {
    pub title: &'a str,
    pub message: &'a str,
    pub confirm_label: &'a str,
    pub cancel_label: &'a str,
}

pub struct RevealPromptSpec<'a> {
    pub title: &'a str,
    pub message: &'a str,
    pub acknowledge_label: &'a str,
}

pub struct ImportPromptSpec<'a> {
    pub title: &'a str,
    pub wallet_label_hint: &'a str,
    pub passphrase_min_length: usize,
    pub ok_label: &'a str,
    pub cancel_label: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextValidationSpec<'a> {
    None,
    MinLength { min_length: usize },
    MatchesValue { expected: &'a str },
    ExactValue { expected: &'a str },
}

#[derive(Debug)]
pub struct ImportPromptOutput {
    pub label: String,
    pub private_key: Zeroizing<String>,
    pub passphrase: Zeroizing<String>,
    pub passphrase_confirmation: Zeroizing<String>,
}

pub struct RemoveConfirmPromptSpec<'a> {
    pub title: &'a str,
    pub message: &'a str,
    pub confirm_label: &'a str,
    pub cancel_label: &'a str,
    pub typed_confirmation_message: &'a str,
    pub typed_confirmation_ok_label: &'a str,
    pub expected_confirmation: &'a str,
    pub passphrase_message: &'a str,
    pub passphrase_ok_label: &'a str,
}

#[derive(Debug)]
pub struct RemoveConfirmPromptOutput {
    pub typed_confirmation: String,
    pub passphrase: Zeroizing<String>,
}

pub struct ExportConfirmPromptSpec<'a> {
    pub title: &'a str,
    pub message: &'a str,
    pub confirm_label: &'a str,
    pub cancel_label: &'a str,
    pub typed_confirmation_message: &'a str,
    pub typed_confirmation_ok_label: &'a str,
    pub expected_confirmation: &'a str,
    pub passphrase_message: &'a str,
    pub passphrase_ok_label: &'a str,
}

#[derive(Debug)]
pub struct ExportConfirmPromptOutput {
    pub typed_confirmation: String,
    pub passphrase: Zeroizing<String>,
}

#[derive(Debug, Error)]
pub enum PromptUiError {
    #[error("Secret prompt owner was lost")]
    OwnerLost,
    #[error("Secret prompt received unexpected additional input")]
    ProtocolViolation,
    #[error("Failed to start prompt owner-liveness watcher: {0}")]
    OwnerLiveness(String),
    #[error("Failed to create prompt event loop: {0}")]
    EventLoop(String),
    #[error("Failed to create prompt window: {0}")]
    Window(String),
    #[error("Failed to initialize prompt surface: {0}")]
    Surface(String),
    #[error("Prompt rendering failed: {0}")]
    Render(String),
}

pub fn prompt_unlock(
    spec: UnlockPromptSpec<'_>,
    owner_liveness: &OwnerLiveness,
) -> Result<Option<Zeroizing<String>>, PromptUiError> {
    let title = spec.title.to_owned();
    let window_size = resolve_unlock_window_size(&spec.review_pages)?;
    let initial_screen = if let Some(page) = spec.review_pages.first() {
        build_bidding_review_screen(spec.title, page, REVIEW_NEXT_LABEL, spec.cancel_label)
    } else {
        build_text_screen(TextPromptSpec {
            title: spec.title,
            message: spec.passphrase_message,
            initial_value: "",
            mode: TextPromptMode::Secret,
            ok_label: spec.unlock_label,
            cancel_label: spec.cancel_label,
            input_kind: TextInputKind::Passphrase,
            max_len: 256,
            validation: TextValidationSpec::None,
        })
    };
    let flow = PromptFlow::Unlock(UnlockFlowState {
        title: spec.title.to_owned(),
        passphrase_message: spec.passphrase_message.to_owned(),
        review_pages: spec.review_pages,
        page_index: 0,
        unlock_label: spec.unlock_label.to_owned(),
        cancel_label: spec.cancel_label.to_owned(),
    });
    match run_flow(title, flow, initial_screen, window_size, owner_liveness)? {
        FlowResult::UnlockSubmitted(passphrase) => Ok(Some(passphrase)),
        FlowResult::Cancelled => Ok(None),
        other => Err(PromptUiError::Render(format!(
            "Prompt returned unexpected unlock result: {other:?}"
        ))),
    }
}

fn resolve_unlock_window_size(
    review_pages: &[BiddingReviewPage],
) -> Result<(u32, u32), PromptUiError> {
    if review_pages.is_empty() {
        return Ok(UNLOCK_WINDOW_SIZE);
    }
    validate_bidding_review_pages(review_pages)?;
    Ok(BIDDING_REVIEW_WINDOW_SIZE)
}

/// Rejects bidding review pages that would collide with the prompt controls.
pub(crate) fn validate_bidding_review_pages(
    review_pages: &[BiddingReviewPage],
) -> Result<(), PromptUiError> {
    let size = PhysicalSize::new(BIDDING_REVIEW_WINDOW_SIZE.0, BIDDING_REVIEW_WINDOW_SIZE.1);
    let layout = ConfirmScreenLayout::for_size(size);
    for (index, page) in review_pages.iter().enumerate() {
        if !layout.bidding_review_fits(page) {
            return Err(PromptUiError::Render(format!(
                "Bidding authorization page {} is too large to display safely",
                index + 1
            )));
        }
    }
    Ok(())
}

pub fn prompt_import(
    spec: ImportPromptSpec<'_>,
    owner_liveness: &OwnerLiveness,
) -> Result<Option<ImportPromptOutput>, PromptUiError> {
    let title = spec.title.to_owned();
    let flow = PromptFlow::Import(ImportFlowState {
        title: spec.title.to_owned(),
        ok_label: spec.ok_label.to_owned(),
        cancel_label: spec.cancel_label.to_owned(),
        passphrase_min_length: spec.passphrase_min_length,
        label: None,
        private_key: None,
        passphrase: None,
    });
    let initial_screen = build_text_screen(TextPromptSpec {
        title: spec.title,
        message: "Wallet label",
        initial_value: spec.wallet_label_hint,
        mode: TextPromptMode::Plain,
        ok_label: spec.ok_label,
        cancel_label: spec.cancel_label,
        input_kind: TextInputKind::Label,
        max_len: 64,
        validation: TextValidationSpec::None,
    });
    match run_flow(
        title,
        flow,
        initial_screen,
        TEXT_WINDOW_SIZE,
        owner_liveness,
    )? {
        FlowResult::ImportSubmitted(output) => Ok(Some(output)),
        FlowResult::Cancelled => Ok(None),
        other => Err(PromptUiError::Render(format!(
            "Prompt returned unexpected import result: {other:?}"
        ))),
    }
}

pub fn prompt_remove_confirmation(
    spec: RemoveConfirmPromptSpec<'_>,
    owner_liveness: &OwnerLiveness,
) -> Result<Option<RemoveConfirmPromptOutput>, PromptUiError> {
    let title = spec.title.to_owned();
    let flow = PromptFlow::Remove(RemoveFlowState {
        title: spec.title.to_owned(),
        cancel_label: spec.cancel_label.to_owned(),
        typed_confirmation_message: spec.typed_confirmation_message.to_owned(),
        typed_confirmation_ok_label: spec.typed_confirmation_ok_label.to_owned(),
        expected_confirmation: spec.expected_confirmation.to_owned(),
        passphrase_message: spec.passphrase_message.to_owned(),
        passphrase_ok_label: spec.passphrase_ok_label.to_owned(),
        confirmed: false,
        typed_confirmation: None,
    });
    let initial_screen = build_confirm_screen(ConfirmPromptSpec {
        title: spec.title,
        message: spec.message,
        confirm_label: spec.confirm_label,
        cancel_label: spec.cancel_label,
    });
    match run_flow(
        title,
        flow,
        initial_screen,
        TEXT_WINDOW_SIZE,
        owner_liveness,
    )? {
        FlowResult::RemoveConfirmSubmitted(output) => Ok(Some(output)),
        FlowResult::Cancelled => Ok(None),
        other => Err(PromptUiError::Render(format!(
            "Prompt returned unexpected remove result: {other:?}"
        ))),
    }
}

pub fn prompt_export_confirmation(
    spec: ExportConfirmPromptSpec<'_>,
    owner_liveness: &OwnerLiveness,
) -> Result<Option<ExportConfirmPromptOutput>, PromptUiError> {
    let title = spec.title.to_owned();
    let flow = PromptFlow::ExportConfirm(ExportConfirmFlowState {
        title: spec.title.to_owned(),
        cancel_label: spec.cancel_label.to_owned(),
        typed_confirmation_message: spec.typed_confirmation_message.to_owned(),
        typed_confirmation_ok_label: spec.typed_confirmation_ok_label.to_owned(),
        expected_confirmation: spec.expected_confirmation.to_owned(),
        passphrase_message: spec.passphrase_message.to_owned(),
        passphrase_ok_label: spec.passphrase_ok_label.to_owned(),
        typed_confirmation: None,
    });
    let initial_screen = build_confirm_screen(ConfirmPromptSpec {
        title: spec.title,
        message: spec.message,
        confirm_label: spec.confirm_label,
        cancel_label: spec.cancel_label,
    });
    match run_flow(
        title,
        flow,
        initial_screen,
        TEXT_WINDOW_SIZE,
        owner_liveness,
    )? {
        FlowResult::ExportConfirmSubmitted(output) => Ok(Some(output)),
        FlowResult::Cancelled => Ok(None),
        other => Err(PromptUiError::Render(format!(
            "Prompt returned unexpected export confirm result: {other:?}"
        ))),
    }
}

pub fn reveal(
    spec: RevealPromptSpec<'_>,
    owner_liveness: &OwnerLiveness,
) -> Result<(), PromptUiError> {
    let title = spec.title.to_owned();
    match run_flow(
        title,
        PromptFlow::SingleReveal,
        build_reveal_screen(spec),
        REVEAL_WINDOW_SIZE,
        owner_liveness,
    )? {
        FlowResult::RevealAcknowledged => Ok(()),
        FlowResult::Cancelled => Err(PromptUiError::Render(
            "Reveal prompt was closed before acknowledgement".to_owned(),
        )),
        other => Err(PromptUiError::Render(format!(
            "Prompt returned unexpected reveal result: {other:?}"
        ))),
    }
}

fn run_flow(
    title: String,
    flow: PromptFlow,
    screen: ScreenState,
    window_size: (u32, u32),
    owner_liveness: &OwnerLiveness,
) -> Result<FlowResult, PromptUiError> {
    let event_loop = EventLoop::<OwnerLivenessEvent>::with_user_event()
        .build()
        .map_err(|error| PromptUiError::EventLoop(error.to_string()))?;
    // Arm stdin ownership before winit is allowed to create the native window.
    owner_liveness
        .start_stdin_watcher(event_loop.create_proxy())
        .map_err(|error| PromptUiError::OwnerLiveness(error.to_string()))?;
    let mut app = PromptApp::new(title, flow, screen, window_size, owner_liveness.clone());
    let run_result = event_loop.run_app(&mut app);
    if let Some(event) = owner_liveness.forced_event() {
        app.scrub_secret_state();
        return Err(prompt_error_for_owner_event(event));
    }
    if let Err(error) = run_result {
        if owner_liveness.claim_ui_completion() {
            return Err(PromptUiError::EventLoop(error.to_string()));
        }
        if let Some(event) = owner_liveness.forced_event() {
            app.scrub_secret_state();
            return Err(prompt_error_for_owner_event(event));
        }
        return Err(PromptUiError::EventLoop(error.to_string()));
    }
    if let Some(error) = app.error {
        return Err(error);
    }
    if app.result.is_none() && !owner_liveness.claim_ui_completion() {
        if let Some(event) = owner_liveness.forced_event() {
            app.scrub_secret_state();
            return Err(prompt_error_for_owner_event(event));
        }
    }
    Ok(app.result.unwrap_or(FlowResult::Cancelled))
}

fn prompt_error_for_owner_event(event: OwnerLivenessEvent) -> PromptUiError {
    match event {
        OwnerLivenessEvent::OwnerLost => PromptUiError::OwnerLost,
        OwnerLivenessEvent::ProtocolViolation => PromptUiError::ProtocolViolation,
    }
}

fn build_text_screen(spec: TextPromptSpec<'_>) -> ScreenState {
    let initial_value = sanitize_initial_value(spec.initial_value, spec.input_kind, spec.max_len);
    let cursor_index = initial_value.len();
    ScreenState::Text(TextScreenState {
        title: spec.title.to_owned(),
        message: spec.message.to_owned(),
        value: initial_value,
        mode: spec.mode,
        ok_label: spec.ok_label.to_owned(),
        cancel_label: spec.cancel_label.to_owned(),
        input_kind: spec.input_kind,
        max_len: spec.max_len,
        validation: TextValidation::from_spec(spec.validation),
        focus: TextFocus::Input,
        cursor_index,
        scroll_offset: 0,
    })
}

fn build_confirm_screen(spec: ConfirmPromptSpec<'_>) -> ScreenState {
    ScreenState::Confirm(ConfirmScreenState {
        title: spec.title.to_owned(),
        content: ConfirmScreenContent::Plain(spec.message.to_owned()),
        confirm_label: spec.confirm_label.to_owned(),
        cancel_label: spec.cancel_label.to_owned(),
        focus: ConfirmFocus::Cancel,
    })
}

fn build_bidding_review_screen(
    title: &str,
    page: &BiddingReviewPage,
    confirm_label: &str,
    cancel_label: &str,
) -> ScreenState {
    ScreenState::Confirm(ConfirmScreenState {
        title: title.to_owned(),
        content: ConfirmScreenContent::BiddingReview(page.clone()),
        confirm_label: confirm_label.to_owned(),
        cancel_label: cancel_label.to_owned(),
        focus: ConfirmFocus::Cancel,
    })
}

fn build_reveal_screen(spec: RevealPromptSpec<'_>) -> ScreenState {
    ScreenState::Reveal(RevealScreenState {
        title: spec.title.to_owned(),
        message: Zeroizing::new(spec.message.to_owned()),
        acknowledge_label: spec.acknowledge_label.to_owned(),
    })
}

#[derive(Debug)]
enum FlowResult {
    UnlockSubmitted(Zeroizing<String>),
    RevealAcknowledged,
    ImportSubmitted(ImportPromptOutput),
    RemoveConfirmSubmitted(RemoveConfirmPromptOutput),
    ExportConfirmSubmitted(ExportConfirmPromptOutput),
    Cancelled,
}

impl FlowResult {
    fn scrub_secrets(&mut self) {
        match self {
            Self::UnlockSubmitted(passphrase) => passphrase.zeroize(),
            Self::ImportSubmitted(output) => {
                output.private_key.zeroize();
                output.passphrase.zeroize();
                output.passphrase_confirmation.zeroize();
            }
            Self::RemoveConfirmSubmitted(output) => output.passphrase.zeroize(),
            Self::ExportConfirmSubmitted(output) => output.passphrase.zeroize(),
            Self::RevealAcknowledged | Self::Cancelled => {}
        }
    }
}

enum FlowTransition {
    Continue(ScreenState),
    Finish(FlowResult),
}

enum PromptFlow {
    Unlock(UnlockFlowState),
    SingleReveal,
    Import(ImportFlowState),
    Remove(RemoveFlowState),
    ExportConfirm(ExportConfirmFlowState),
}

struct UnlockFlowState {
    title: String,
    passphrase_message: String,
    review_pages: Vec<BiddingReviewPage>,
    page_index: usize,
    unlock_label: String,
    cancel_label: String,
}

struct ImportFlowState {
    title: String,
    ok_label: String,
    cancel_label: String,
    passphrase_min_length: usize,
    label: Option<String>,
    private_key: Option<Zeroizing<String>>,
    passphrase: Option<Zeroizing<String>>,
}

struct RemoveFlowState {
    title: String,
    cancel_label: String,
    typed_confirmation_message: String,
    typed_confirmation_ok_label: String,
    expected_confirmation: String,
    passphrase_message: String,
    passphrase_ok_label: String,
    confirmed: bool,
    typed_confirmation: Option<Zeroizing<String>>,
}

struct ExportConfirmFlowState {
    title: String,
    cancel_label: String,
    typed_confirmation_message: String,
    typed_confirmation_ok_label: String,
    expected_confirmation: String,
    passphrase_message: String,
    passphrase_ok_label: String,
    typed_confirmation: Option<Zeroizing<String>>,
}

impl PromptFlow {
    fn on_result(&mut self, result: ScreenResult) -> Result<FlowTransition, PromptUiError> {
        match self {
            Self::Unlock(state) => state.on_result(result),
            Self::SingleReveal => Ok(match result {
                ScreenResult::Acknowledged => {
                    FlowTransition::Finish(FlowResult::RevealAcknowledged)
                }
                ScreenResult::Cancelled => FlowTransition::Finish(FlowResult::Cancelled),
                other => {
                    return Err(PromptUiError::Render(format!(
                        "Unexpected single reveal screen result: {other:?}"
                    )));
                }
            }),
            Self::Import(flow) => flow.on_result(result),
            Self::Remove(flow) => flow.on_result(result),
            Self::ExportConfirm(flow) => flow.on_result(result),
        }
    }

    fn scrub_secrets(&mut self) {
        match self {
            Self::Import(state) => {
                zeroize_optional_text(&mut state.private_key);
                zeroize_optional_text(&mut state.passphrase);
            }
            Self::Remove(state) => zeroize_optional_text(&mut state.typed_confirmation),
            Self::ExportConfirm(state) => zeroize_optional_text(&mut state.typed_confirmation),
            Self::Unlock(_) | Self::SingleReveal => {}
        }
    }
}

impl UnlockFlowState {
    fn on_result(&mut self, result: ScreenResult) -> Result<FlowTransition, PromptUiError> {
        match result {
            ScreenResult::Cancelled => Ok(FlowTransition::Finish(FlowResult::Cancelled)),
            ScreenResult::Confirmed if !self.review_pages.is_empty() => {
                self.page_index += 1;
                if let Some(page) = self.review_pages.get(self.page_index) {
                    return Ok(FlowTransition::Continue(build_bidding_review_screen(
                        &self.title,
                        page,
                        REVIEW_NEXT_LABEL,
                        &self.cancel_label,
                    )));
                }
                Ok(FlowTransition::Continue(build_text_screen(
                    TextPromptSpec {
                        title: &self.title,
                        message: &self.passphrase_message,
                        initial_value: "",
                        mode: TextPromptMode::Secret,
                        ok_label: &self.unlock_label,
                        cancel_label: &self.cancel_label,
                        input_kind: TextInputKind::Passphrase,
                        max_len: 256,
                        validation: TextValidationSpec::None,
                    },
                )))
            }
            ScreenResult::Submitted(passphrase) => Ok(FlowTransition::Finish(
                FlowResult::UnlockSubmitted(passphrase),
            )),
            other => Err(PromptUiError::Render(format!(
                "Unexpected unlock screen result: {other:?}"
            ))),
        }
    }
}

impl ImportFlowState {
    fn on_result(&mut self, result: ScreenResult) -> Result<FlowTransition, PromptUiError> {
        match result {
            ScreenResult::Cancelled => Ok(FlowTransition::Finish(FlowResult::Cancelled)),
            ScreenResult::Submitted(value) => {
                if self.label.is_none() {
                    self.label = Some(take_sensitive_text(value));
                    return Ok(FlowTransition::Continue(build_text_screen(
                        TextPromptSpec {
                            title: &self.title,
                            message: "Private key (hex, 0x...)",
                            initial_value: "",
                            mode: TextPromptMode::Secret,
                            ok_label: &self.ok_label,
                            cancel_label: &self.cancel_label,
                            input_kind: TextInputKind::PrivateKey,
                            max_len: 132,
                            validation: TextValidationSpec::None,
                        },
                    )));
                }
                if self.private_key.is_none() {
                    self.private_key = Some(value);
                    return Ok(FlowTransition::Continue(build_text_screen(
                        TextPromptSpec {
                            title: &self.title,
                            message: "Keystore passphrase",
                            initial_value: "",
                            mode: TextPromptMode::Secret,
                            ok_label: &self.ok_label,
                            cancel_label: &self.cancel_label,
                            input_kind: TextInputKind::Passphrase,
                            max_len: 256,
                            validation: TextValidationSpec::MinLength {
                                min_length: self.passphrase_min_length,
                            },
                        },
                    )));
                }
                if self.passphrase.is_none() {
                    self.passphrase = Some(value);
                    return Ok(FlowTransition::Continue(build_text_screen(
                        TextPromptSpec {
                            title: &self.title,
                            message: "Confirm keystore passphrase",
                            initial_value: "",
                            mode: TextPromptMode::Secret,
                            ok_label: &self.ok_label,
                            cancel_label: &self.cancel_label,
                            input_kind: TextInputKind::Passphrase,
                            max_len: 256,
                            validation: TextValidationSpec::MatchesValue {
                                expected: self
                                    .passphrase
                                    .as_ref()
                                    .map(|passphrase| passphrase.as_str())
                                    .unwrap_or_default(),
                            },
                        },
                    )));
                }
                Ok(FlowTransition::Finish(FlowResult::ImportSubmitted(
                    ImportPromptOutput {
                        label: self.label.take().unwrap_or_default(),
                        private_key: self.private_key.take().unwrap_or_default(),
                        passphrase: self.passphrase.take().unwrap_or_default(),
                        passphrase_confirmation: value,
                    },
                )))
            }
            other => Err(PromptUiError::Render(format!(
                "Unexpected import screen result: {other:?}"
            ))),
        }
    }
}

impl RemoveFlowState {
    fn on_result(&mut self, result: ScreenResult) -> Result<FlowTransition, PromptUiError> {
        match result {
            ScreenResult::Cancelled => Ok(FlowTransition::Finish(FlowResult::Cancelled)),
            ScreenResult::Confirmed if !self.confirmed => {
                self.confirmed = true;
                Ok(FlowTransition::Continue(build_text_screen(
                    TextPromptSpec {
                        title: &self.title,
                        message: &self.typed_confirmation_message,
                        initial_value: "",
                        mode: TextPromptMode::Plain,
                        ok_label: &self.typed_confirmation_ok_label,
                        cancel_label: &self.cancel_label,
                        input_kind: TextInputKind::Confirmation,
                        max_len: 64,
                        validation: TextValidationSpec::ExactValue {
                            expected: &self.expected_confirmation,
                        },
                    },
                )))
            }
            ScreenResult::Submitted(value)
                if self.confirmed && self.typed_confirmation.is_none() =>
            {
                self.typed_confirmation = Some(value);
                Ok(FlowTransition::Continue(build_text_screen(
                    TextPromptSpec {
                        title: &self.title,
                        message: &self.passphrase_message,
                        initial_value: "",
                        mode: TextPromptMode::Secret,
                        ok_label: &self.passphrase_ok_label,
                        cancel_label: &self.cancel_label,
                        input_kind: TextInputKind::Passphrase,
                        max_len: 256,
                        validation: TextValidationSpec::None,
                    },
                )))
            }
            ScreenResult::Submitted(passphrase) if self.confirmed => Ok(FlowTransition::Finish(
                FlowResult::RemoveConfirmSubmitted(RemoveConfirmPromptOutput {
                    typed_confirmation: take_optional_sensitive_text(&mut self.typed_confirmation),
                    passphrase,
                }),
            )),
            other => Err(PromptUiError::Render(format!(
                "Unexpected remove confirm result: {other:?}"
            ))),
        }
    }
}

impl ExportConfirmFlowState {
    fn on_result(&mut self, result: ScreenResult) -> Result<FlowTransition, PromptUiError> {
        match result {
            ScreenResult::Cancelled => Ok(FlowTransition::Finish(FlowResult::Cancelled)),
            ScreenResult::Confirmed if self.typed_confirmation.is_none() => Ok(
                FlowTransition::Continue(build_text_screen(TextPromptSpec {
                    title: &self.title,
                    message: &self.typed_confirmation_message,
                    initial_value: "",
                    mode: TextPromptMode::Plain,
                    ok_label: &self.typed_confirmation_ok_label,
                    cancel_label: &self.cancel_label,
                    input_kind: TextInputKind::Confirmation,
                    max_len: 64,
                    validation: TextValidationSpec::ExactValue {
                        expected: &self.expected_confirmation,
                    },
                })),
            ),
            ScreenResult::Submitted(value) if self.typed_confirmation.is_none() => {
                self.typed_confirmation = Some(value);
                Ok(FlowTransition::Continue(build_text_screen(
                    TextPromptSpec {
                        title: &self.title,
                        message: &self.passphrase_message,
                        initial_value: "",
                        mode: TextPromptMode::Secret,
                        ok_label: &self.passphrase_ok_label,
                        cancel_label: &self.cancel_label,
                        input_kind: TextInputKind::Passphrase,
                        max_len: 256,
                        validation: TextValidationSpec::None,
                    },
                )))
            }
            ScreenResult::Submitted(passphrase) => Ok(FlowTransition::Finish(
                FlowResult::ExportConfirmSubmitted(ExportConfirmPromptOutput {
                    typed_confirmation: take_optional_sensitive_text(&mut self.typed_confirmation),
                    passphrase,
                }),
            )),
            other => Err(PromptUiError::Render(format!(
                "Unexpected export confirm result: {other:?}"
            ))),
        }
    }
}

struct PromptApp {
    title: String,
    flow: PromptFlow,
    screen: ScreenState,
    window_size: (u32, u32),
    result: Option<FlowResult>,
    error: Option<PromptUiError>,
    window: Option<Rc<Window>>,
    surface: Option<RenderSurface>,
    modifiers: ModifiersState,
    cursor_position: PhysicalPosition<f64>,
    clipboard: Option<Clipboard>,
    screen_started_at: Instant,
    screen_interacted: bool,
    owner_liveness: OwnerLiveness,
}

impl PromptApp {
    fn new(
        title: String,
        flow: PromptFlow,
        screen: ScreenState,
        window_size: (u32, u32),
        owner_liveness: OwnerLiveness,
    ) -> Self {
        Self {
            title,
            flow,
            screen,
            window_size,
            result: None,
            error: None,
            window: None,
            surface: None,
            modifiers: ModifiersState::default(),
            cursor_position: PhysicalPosition::new(0.0, 0.0),
            clipboard: Clipboard::new().ok(),
            screen_started_at: Instant::now(),
            screen_interacted: false,
            owner_liveness,
        }
    }

    fn request_redraw(&self) {
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }

    fn finish(&mut self, event_loop: &ActiveEventLoop, result: FlowResult) {
        if !self.owner_liveness.claim_ui_completion() {
            self.force_close_for_owner(event_loop);
            return;
        }
        self.result = Some(result);
        event_loop.exit();
    }

    fn cancel(&mut self, event_loop: &ActiveEventLoop) {
        self.finish(event_loop, FlowResult::Cancelled);
    }

    fn reset_screen_guard(&mut self) {
        self.screen_started_at = Instant::now();
        self.screen_interacted = false;
    }

    fn mark_interaction(&mut self) {
        self.screen_interacted = true;
    }

    fn should_ignore_startup_submit(&self, key: &Key) -> bool {
        if self.screen_interacted || self.screen_started_at.elapsed() >= STARTUP_SUBMIT_GUARD {
            return false;
        }
        matches!(
            key,
            Key::Named(NamedKey::Enter) | Key::Named(NamedKey::Escape)
        )
    }

    fn advance(&mut self, event_loop: &ActiveEventLoop, result: ScreenResult) {
        if self.owner_liveness.forced_event().is_some() {
            self.force_close_for_owner(event_loop);
            return;
        }
        match self.flow.on_result(result) {
            Ok(FlowTransition::Continue(next_screen)) => {
                if self.owner_liveness.forced_event().is_some() {
                    self.force_close_for_owner(event_loop);
                    return;
                }
                self.screen = next_screen;
                self.reset_screen_guard();
                self.request_redraw();
            }
            Ok(FlowTransition::Finish(result)) => self.finish(event_loop, result),
            Err(error) => {
                self.fail(event_loop, error);
            }
        }
    }

    fn fail(&mut self, event_loop: &ActiveEventLoop, error: PromptUiError) {
        if self.owner_liveness.claim_ui_completion() {
            self.error = Some(error);
            event_loop.exit();
        } else {
            self.force_close_for_owner(event_loop);
        }
    }

    fn force_close_for_owner(&mut self, event_loop: &ActiveEventLoop) {
        let Some(event) = self.owner_liveness.forced_event() else {
            return;
        };
        self.scrub_secret_state();
        self.surface = None;
        self.window = None;
        self.error = Some(prompt_error_for_owner_event(event));
        event_loop.exit();
    }

    fn scrub_secret_state(&mut self) {
        self.flow.scrub_secrets();
        self.screen.scrub_secrets();
        if let Some(result) = &mut self.result {
            result.scrub_secrets();
        }
        self.result = None;
    }

    fn render(&mut self) -> Result<(), PromptUiError> {
        let Some(window) = &self.window else {
            return Ok(());
        };
        let Some(surface) = &mut self.surface else {
            return Ok(());
        };
        let size = window.inner_size();
        if size.width == 0 || size.height == 0 {
            return Ok(());
        }
        surface.resize(size)?;
        let mut pixels = Zeroizing::new(vec![
            BACKGROUND;
            (size.width as usize) * (size.height as usize)
        ]);
        {
            let mut canvas = Canvas::new(&mut pixels, size.width as usize, size.height as usize);
            self.screen.render(&mut canvas, size);
        }
        surface.present(&pixels)
    }

    fn paste_into_text_screen(&mut self) {
        let Some(clipboard) = &mut self.clipboard else {
            return;
        };
        let Ok(text) = clipboard.get_text() else {
            return;
        };
        let text = Zeroizing::new(text);
        if let ScreenState::Text(screen) = &mut self.screen {
            screen.insert_text(&normalize_paste(&text, screen.input_kind));
        }
    }
}

impl ApplicationHandler<OwnerLivenessEvent> for PromptApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.owner_liveness.forced_event().is_some() {
            self.force_close_for_owner(event_loop);
            return;
        }
        let attributes = WindowAttributes::default()
            .with_title(self.title.clone())
            .with_resizable(false)
            .with_inner_size(LogicalSize::new(
                f64::from(self.window_size.0),
                f64::from(self.window_size.1),
            ));
        let window = match event_loop.create_window(attributes) {
            Ok(window) => Rc::new(window),
            Err(error) => {
                self.fail(event_loop, PromptUiError::Window(error.to_string()));
                return;
            }
        };
        let surface = match RenderSurface::new(window.clone()) {
            Ok(surface) => surface,
            Err(error) => {
                self.fail(event_loop, error);
                return;
            }
        };
        self.surface = Some(surface);
        self.window = Some(window);
        self.request_redraw();
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => match self.screen {
                ScreenState::Reveal(_) => self.advance(event_loop, ScreenResult::Acknowledged),
                _ => self.cancel(event_loop),
            },
            WindowEvent::RedrawRequested => {
                if let Err(error) = self.render() {
                    self.fail(event_loop, error);
                }
            }
            WindowEvent::Resized(_) => self.request_redraw(),
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor_position = position;
            }
            WindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
            }
            WindowEvent::MouseInput {
                state: ElementState::Released,
                button: MouseButton::Left,
                ..
            } => {
                self.mark_interaction();
                let window_size = self
                    .window
                    .as_ref()
                    .map(|window| window.inner_size())
                    .unwrap_or(PhysicalSize::new(self.window_size.0, self.window_size.1));
                if let Some(result) = self.screen.handle_click(self.cursor_position, window_size) {
                    self.advance(event_loop, result);
                    return;
                }
                self.request_redraw();
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                if self.should_ignore_startup_submit(&event.logical_key) {
                    return;
                }
                self.mark_interaction();
                if self.screen.handle_keyboard_navigation(
                    &event.logical_key,
                    self.modifiers,
                    self.cursor_position,
                ) {
                    self.request_redraw();
                    return;
                }

                match &event.logical_key {
                    Key::Named(NamedKey::Escape) => match self.screen {
                        ScreenState::Reveal(_) => {
                            self.advance(event_loop, ScreenResult::Acknowledged)
                        }
                        _ => self.cancel(event_loop),
                    },
                    Key::Named(NamedKey::Enter) => {
                        if let Some(result) = self.screen.activate_focused() {
                            self.advance(event_loop, result);
                            return;
                        }
                        self.request_redraw();
                    }
                    Key::Named(NamedKey::Backspace) => {
                        if let ScreenState::Text(screen) = &mut self.screen {
                            screen.backspace();
                            self.request_redraw();
                        }
                    }
                    Key::Named(NamedKey::Delete) => {
                        if let ScreenState::Text(screen) = &mut self.screen {
                            screen.delete();
                            self.request_redraw();
                        }
                    }
                    Key::Character(ch) if is_paste_shortcut(self.modifiers, ch.as_str()) => {
                        self.paste_into_text_screen();
                        self.request_redraw();
                    }
                    Key::Character(_) => {
                        if let Some(text) = event.text.as_ref()
                            && let ScreenState::Text(screen) = &mut self.screen
                        {
                            screen.insert_text(text);
                            self.request_redraw();
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, _event: OwnerLivenessEvent) {
        self.force_close_for_owner(event_loop);
    }
}

fn is_paste_shortcut(modifiers: ModifiersState, ch: &str) -> bool {
    (modifiers.control_key() || modifiers.super_key()) && ch.eq_ignore_ascii_case("v")
}

struct RenderSurface {
    _context: Context<Rc<Window>>,
    surface: Surface<Rc<Window>, Rc<Window>>,
    size: PhysicalSize<u32>,
}

impl RenderSurface {
    fn new(window: Rc<Window>) -> Result<Self, PromptUiError> {
        let context = Context::new(window.clone())
            .map_err(|error| PromptUiError::Surface(error.to_string()))?;
        let surface = Surface::new(&context, window.clone())
            .map_err(|error| PromptUiError::Surface(error.to_string()))?;
        Ok(Self {
            _context: context,
            surface,
            size: PhysicalSize::new(0, 0),
        })
    }

    fn resize(&mut self, size: PhysicalSize<u32>) -> Result<(), PromptUiError> {
        if self.size == size || size.width == 0 || size.height == 0 {
            self.size = size;
            return Ok(());
        }
        let width = NonZeroU32::new(size.width)
            .ok_or_else(|| PromptUiError::Surface("Prompt width cannot be zero".to_owned()))?;
        let height = NonZeroU32::new(size.height)
            .ok_or_else(|| PromptUiError::Surface("Prompt height cannot be zero".to_owned()))?;
        self.surface
            .resize(width, height)
            .map_err(|error| PromptUiError::Surface(error.to_string()))?;
        self.size = size;
        Ok(())
    }

    fn present(&mut self, pixels: &[u32]) -> Result<(), PromptUiError> {
        let mut buffer = self
            .surface
            .buffer_mut()
            .map_err(|error| PromptUiError::Surface(error.to_string()))?;
        buffer.copy_from_slice(pixels);
        buffer
            .present()
            .map_err(|error| PromptUiError::Surface(error.to_string()))
    }
}

enum ScreenState {
    Text(TextScreenState),
    Confirm(ConfirmScreenState),
    Reveal(RevealScreenState),
}

impl ScreenState {
    fn render(&mut self, canvas: &mut Canvas<'_>, size: PhysicalSize<u32>) {
        match self {
            Self::Text(screen) => screen.render(canvas, size),
            Self::Confirm(screen) => screen.render(canvas, size),
            Self::Reveal(screen) => screen.render(canvas, size),
        }
    }

    fn handle_keyboard_navigation(
        &mut self,
        key: &Key,
        _modifiers: ModifiersState,
        _cursor_position: PhysicalPosition<f64>,
    ) -> bool {
        match self {
            Self::Text(screen) => screen.handle_navigation_key(key),
            Self::Confirm(screen) => screen.handle_navigation_key(key),
            Self::Reveal(_) => false,
        }
    }

    fn activate_focused(&mut self) -> Option<ScreenResult> {
        match self {
            Self::Text(screen) => screen.activate_focused(),
            Self::Confirm(screen) => screen.activate_focused(),
            Self::Reveal(_) => Some(ScreenResult::Acknowledged),
        }
    }

    fn handle_click(
        &mut self,
        cursor_position: PhysicalPosition<f64>,
        size: PhysicalSize<u32>,
    ) -> Option<ScreenResult> {
        match self {
            Self::Text(screen) => screen.handle_click(cursor_position, size),
            Self::Confirm(screen) => screen.handle_click(cursor_position, size),
            Self::Reveal(screen) => screen.handle_click(cursor_position, size),
        }
    }

    fn scrub_secrets(&mut self) {
        match self {
            Self::Text(screen) => {
                screen.value.zeroize();
                screen.validation.scrub_secrets();
            }
            Self::Reveal(screen) => screen.message.zeroize(),
            Self::Confirm(_) => {}
        }
    }
}

#[derive(Debug)]
enum ScreenResult {
    Submitted(Zeroizing<String>),
    Confirmed,
    Acknowledged,
    Cancelled,
}

struct TextScreenState {
    title: String,
    message: String,
    value: Zeroizing<String>,
    mode: TextPromptMode,
    ok_label: String,
    cancel_label: String,
    input_kind: TextInputKind,
    max_len: usize,
    validation: TextValidation,
    focus: TextFocus,
    cursor_index: usize,
    scroll_offset: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TextFocus {
    Input,
    Ok,
    Cancel,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum TextValidation {
    None,
    MinLength { min_length: usize },
    MatchesValue { expected: Zeroizing<String> },
    ExactValue { expected: Zeroizing<String> },
}

struct ValidationFeedback {
    message: String,
    color: u32,
    blocking: bool,
}

impl TextValidation {
    fn from_spec(spec: TextValidationSpec<'_>) -> Self {
        match spec {
            TextValidationSpec::None => Self::None,
            TextValidationSpec::MinLength { min_length } => Self::MinLength { min_length },
            TextValidationSpec::MatchesValue { expected } => Self::MatchesValue {
                expected: Zeroizing::new(expected.to_owned()),
            },
            TextValidationSpec::ExactValue { expected } => Self::ExactValue {
                expected: Zeroizing::new(expected.to_owned()),
            },
        }
    }

    fn scrub_secrets(&mut self) {
        match self {
            Self::MatchesValue { expected } | Self::ExactValue { expected } => expected.zeroize(),
            Self::None | Self::MinLength { .. } => {}
        }
    }
}

impl TextScreenState {
    fn render(&mut self, canvas: &mut Canvas<'_>, size: PhysicalSize<u32>) {
        let panel = Rect::new(
            CONTENT_MARGIN,
            CONTENT_MARGIN,
            size.width as i32 - (CONTENT_MARGIN * 2),
            size.height as i32 - (CONTENT_MARGIN * 2),
        );
        canvas.fill_rect(panel, PANEL);
        canvas.stroke_rect(panel, PANEL_BORDER);

        let heading_y = panel.y + 18;
        canvas.draw_text(panel.x + 18, heading_y, &self.title, TEXT);

        let body_width = panel.w - 36;
        let message_y = heading_y + LINE_HEIGHT + 8;
        let max_message_cols = max(12, body_width / ADVANCE_WIDTH as i32);
        let message_lines = wrap_text(&self.message, max_message_cols as usize);
        for (index, line) in message_lines.iter().enumerate() {
            canvas.draw_text(
                panel.x + 18,
                message_y + ((index as i32) * LINE_HEIGHT),
                line,
                TEXT_MUTED,
            );
        }

        let input_y = message_y + ((message_lines.len() as i32) * LINE_HEIGHT) + 16;
        let input_rect = Rect::new(panel.x + 18, input_y, body_width, FIELD_HEIGHT);
        canvas.fill_rect(input_rect, PANEL_MUTED);
        canvas.stroke_rect(
            input_rect,
            if self.focus == TextFocus::Input {
                PANEL_BORDER_ACTIVE
            } else {
                PANEL_BORDER
            },
        );

        let inner_x = input_rect.x + FIELD_INNER_PADDING_X;
        let inner_y = input_rect.y + FIELD_INNER_PADDING_Y;
        let visible_chars = visible_text_columns(input_rect.w);
        self.scroll_offset = adjusted_scroll(self.scroll_offset, self.cursor_index, visible_chars);
        let visible_end = min(self.value.len(), self.scroll_offset + visible_chars);
        let visible_value = &self.value[self.scroll_offset..visible_end];
        if self.mode == TextPromptMode::Secret {
            draw_masked_text(canvas, inner_x, inner_y, visible_value.len(), MASK);
        } else {
            canvas.draw_text(inner_x, inner_y, visible_value, TEXT);
        }
        if self.focus == TextFocus::Input {
            let caret_x = inner_x
                + (((self.cursor_index.saturating_sub(self.scroll_offset)) as i32)
                    * ADVANCE_WIDTH as i32)
                + CARET_TEXT_GAP_PX;
            canvas.fill_rect(Rect::new(caret_x, inner_y, 2, CELL_HEIGHT as i32), CARET);
        }

        let hint = match self.input_kind {
            TextInputKind::PrivateKey => format!("Length: {}  Paste: Ctrl/Cmd+V", self.value.len()),
            _ => "Paste: Ctrl/Cmd+V".to_owned(),
        };
        canvas.draw_text(
            panel.x + 18,
            input_rect.y + input_rect.h + 10,
            &hint,
            TEXT_MUTED,
        );
        if let Some(feedback) = self.validation_feedback() {
            canvas.draw_text(
                panel.x + 18,
                input_rect.y + input_rect.h + 10 + LINE_HEIGHT + 4,
                &feedback.message,
                feedback.color,
            );
        }

        let buttons_y = panel.y + panel.h - BUTTON_HEIGHT - 18;
        let cancel_rect = Rect::new(
            panel.x + panel.w - BUTTON_WIDTH - BUTTON_EDGE_INSET,
            buttons_y,
            BUTTON_WIDTH,
            BUTTON_HEIGHT,
        );
        let ok_rect = Rect::new(
            cancel_rect.x - BUTTON_GAP - BUTTON_WIDTH,
            buttons_y,
            BUTTON_WIDTH,
            BUTTON_HEIGHT,
        );
        let can_submit = self.can_submit();
        draw_button(
            canvas,
            ok_rect,
            &self.ok_label,
            self.focus == TextFocus::Ok,
            true,
            can_submit,
        );
        draw_button(
            canvas,
            cancel_rect,
            &self.cancel_label,
            self.focus == TextFocus::Cancel,
            false,
            true,
        );
    }

    fn handle_navigation_key(&mut self, key: &Key) -> bool {
        match key {
            Key::Named(NamedKey::Tab) => {
                self.focus = match self.focus {
                    TextFocus::Input => TextFocus::Ok,
                    TextFocus::Ok => TextFocus::Cancel,
                    TextFocus::Cancel => TextFocus::Input,
                };
                true
            }
            Key::Named(NamedKey::ArrowLeft) => {
                if self.focus == TextFocus::Input {
                    self.cursor_index = self.cursor_index.saturating_sub(1);
                } else {
                    self.focus = match self.focus {
                        TextFocus::Cancel => TextFocus::Ok,
                        TextFocus::Ok => TextFocus::Cancel,
                        TextFocus::Input => TextFocus::Input,
                    };
                }
                true
            }
            Key::Named(NamedKey::ArrowRight) => {
                if self.focus == TextFocus::Input {
                    self.cursor_index = min(self.cursor_index + 1, self.value.len());
                } else {
                    self.focus = match self.focus {
                        TextFocus::Ok => TextFocus::Cancel,
                        TextFocus::Cancel => TextFocus::Ok,
                        TextFocus::Input => TextFocus::Input,
                    };
                }
                true
            }
            Key::Named(NamedKey::Home) if self.focus == TextFocus::Input => {
                self.cursor_index = 0;
                true
            }
            Key::Named(NamedKey::End) if self.focus == TextFocus::Input => {
                self.cursor_index = self.value.len();
                true
            }
            _ => false,
        }
    }

    fn activate_focused(&mut self) -> Option<ScreenResult> {
        match self.focus {
            TextFocus::Input | TextFocus::Ok => {
                if !self.can_submit() {
                    return None;
                }
                Some(ScreenResult::Submitted(normalize_submit(
                    &self.value,
                    self.input_kind,
                )))
            }
            TextFocus::Cancel => Some(ScreenResult::Cancelled),
        }
    }

    fn handle_click(
        &mut self,
        position: PhysicalPosition<f64>,
        size: PhysicalSize<u32>,
    ) -> Option<ScreenResult> {
        let x = position.x as i32;
        let y = position.y as i32;
        let panel = Rect::new(
            CONTENT_MARGIN,
            CONTENT_MARGIN,
            size.width as i32 - (CONTENT_MARGIN * 2),
            size.height as i32 - (CONTENT_MARGIN * 2),
        );
        let body_width = panel.w - 36;
        let max_message_cols = max(12, body_width / ADVANCE_WIDTH as i32);
        let message_lines = wrap_text(&self.message, max_message_cols as usize);
        let message_y = panel.y + 18 + LINE_HEIGHT + 8;
        let input_y = message_y + ((message_lines.len() as i32) * LINE_HEIGHT) + 16;
        let input_rect = Rect::new(panel.x + 18, input_y, body_width, FIELD_HEIGHT);
        let buttons_y = panel.y + panel.h - BUTTON_HEIGHT - 18;
        let cancel_rect = Rect::new(
            panel.x + panel.w - BUTTON_WIDTH - BUTTON_EDGE_INSET,
            buttons_y,
            BUTTON_WIDTH,
            BUTTON_HEIGHT,
        );
        let ok_rect = Rect::new(
            cancel_rect.x - BUTTON_GAP - BUTTON_WIDTH,
            buttons_y,
            BUTTON_WIDTH,
            BUTTON_HEIGHT,
        );

        if input_rect.contains(x, y) {
            self.focus = TextFocus::Input;
            let inner_x = input_rect.x + FIELD_INNER_PADDING_X;
            let visible_chars = visible_text_columns(input_rect.w);
            self.scroll_offset =
                adjusted_scroll(self.scroll_offset, self.cursor_index, visible_chars);
            let relative_x = max(0, x - inner_x);
            let clicked = (relative_x / ADVANCE_WIDTH as i32) as usize;
            self.cursor_index = min(self.value.len(), self.scroll_offset + clicked);
            return None;
        }
        if ok_rect.contains(x, y) {
            self.focus = TextFocus::Ok;
            return self.activate_focused();
        }
        if cancel_rect.contains(x, y) {
            self.focus = TextFocus::Cancel;
            return self.activate_focused();
        }
        None
    }

    fn insert_text(&mut self, text: &str) {
        if self.focus != TextFocus::Input {
            self.focus = TextFocus::Input;
        }
        let filtered = filter_insert_text(text, self.input_kind);
        if filtered.is_empty() {
            return;
        }
        let remaining = self.max_len.saturating_sub(self.value.len());
        if remaining == 0 {
            return;
        }
        let chunk = &filtered[..min(filtered.len(), remaining)];
        self.value.insert_str(self.cursor_index, chunk);
        self.cursor_index += chunk.len();
    }

    fn backspace(&mut self) {
        if self.focus != TextFocus::Input || self.cursor_index == 0 {
            return;
        }
        self.cursor_index -= 1;
        self.value.remove(self.cursor_index);
    }

    fn delete(&mut self) {
        if self.focus != TextFocus::Input || self.cursor_index >= self.value.len() {
            return;
        }
        self.value.remove(self.cursor_index);
    }

    fn can_submit(&self) -> bool {
        self.validation_feedback()
            .map(|feedback| !feedback.blocking)
            .unwrap_or(true)
    }

    fn validation_feedback(&self) -> Option<ValidationFeedback> {
        match &self.validation {
            TextValidation::None => None,
            TextValidation::MinLength { min_length } => {
                let current = self.value.chars().count();
                if current >= *min_length {
                    Some(ValidationFeedback {
                        message: format!(
                            "Passphrase length is valid ({current}/{min_length}+ chars)."
                        ),
                        color: SUCCESS,
                        blocking: false,
                    })
                } else if current == 0 {
                    Some(ValidationFeedback {
                        message: format!("Passphrase must be at least {min_length} characters."),
                        color: TEXT_MUTED,
                        blocking: true,
                    })
                } else {
                    Some(ValidationFeedback {
                        message: format!(
                            "Passphrase must be at least {min_length} characters ({current}/{min_length})."
                        ),
                        color: WARNING,
                        blocking: true,
                    })
                }
            }
            TextValidation::MatchesValue { expected } => {
                if self.value.is_empty() {
                    Some(ValidationFeedback {
                        message: "Repeat the passphrase exactly.".to_owned(),
                        color: TEXT_MUTED,
                        blocking: true,
                    })
                } else if &self.value == expected {
                    Some(ValidationFeedback {
                        message: "Passphrase confirmation matches.".to_owned(),
                        color: SUCCESS,
                        blocking: false,
                    })
                } else {
                    Some(ValidationFeedback {
                        message: "Passphrase confirmation does not match.".to_owned(),
                        color: WARNING,
                        blocking: true,
                    })
                }
            }
            TextValidation::ExactValue { expected } => {
                if self.value.is_empty() {
                    Some(ValidationFeedback {
                        message: format!("Type {} exactly to continue.", expected.as_str()),
                        color: TEXT_MUTED,
                        blocking: true,
                    })
                } else if &self.value == expected {
                    Some(ValidationFeedback {
                        message: "Confirmation matches.".to_owned(),
                        color: SUCCESS,
                        blocking: false,
                    })
                } else {
                    Some(ValidationFeedback {
                        message: format!("Type {} exactly to continue.", expected.as_str()),
                        color: WARNING,
                        blocking: true,
                    })
                }
            }
        }
    }
}

struct ConfirmScreenState {
    title: String,
    content: ConfirmScreenContent,
    confirm_label: String,
    cancel_label: String,
    focus: ConfirmFocus,
}

enum ConfirmScreenContent {
    Plain(String),
    BiddingReview(BiddingReviewPage),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BiddingReviewTextRole {
    Plain,
    Label,
    Amount,
}

impl BiddingReviewTextRole {
    fn color(self) -> u32 {
        match self {
            Self::Plain => TEXT,
            Self::Label => BIDDING_REVIEW_LABEL,
            Self::Amount => BIDDING_REVIEW_AMOUNT,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct BiddingReviewTextSpan {
    text: String,
    role: BiddingReviewTextRole,
}

type BiddingReviewTextLine = Vec<BiddingReviewTextSpan>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConfirmFocus {
    Confirm,
    Cancel,
}

#[derive(Clone, Copy)]
struct ConfirmScreenLayout {
    panel: Rect,
    message_x: i32,
    message_y: i32,
    max_message_cols: usize,
    confirm_rect: Rect,
    cancel_rect: Rect,
}

impl ConfirmScreenLayout {
    fn for_size(size: PhysicalSize<u32>) -> Self {
        let panel = Rect::new(
            CONTENT_MARGIN,
            CONTENT_MARGIN,
            size.width as i32 - (CONTENT_MARGIN * 2),
            size.height as i32 - (CONTENT_MARGIN * 2),
        );
        let message_x = panel.x + 18;
        let message_y = panel.y + 18 + LINE_HEIGHT + 8;
        let body_width = panel.w - 36;
        let max_message_cols = max(12, body_width / ADVANCE_WIDTH as i32) as usize;
        let buttons_y = panel.y + panel.h - BUTTON_HEIGHT - 18;
        let cancel_rect = Rect::new(
            panel.x + panel.w - BUTTON_WIDTH - BUTTON_EDGE_INSET,
            buttons_y,
            BUTTON_WIDTH,
            BUTTON_HEIGHT,
        );
        let confirm_rect = Rect::new(
            cancel_rect.x - BUTTON_GAP - BUTTON_WIDTH,
            buttons_y,
            BUTTON_WIDTH,
            BUTTON_HEIGHT,
        );
        Self {
            panel,
            message_x,
            message_y,
            max_message_cols,
            confirm_rect,
            cancel_rect,
        }
    }

    fn message_lines(&self, message: &str) -> Vec<Zeroizing<String>> {
        wrap_text(message, self.max_message_cols)
    }

    fn bidding_review_lines(&self, page: &BiddingReviewPage) -> Vec<BiddingReviewTextLine> {
        wrap_bidding_review_page(page, self.max_message_cols)
    }

    fn bidding_review_fits(&self, page: &BiddingReviewPage) -> bool {
        let line_count = i32::try_from(self.bidding_review_lines(page).len()).unwrap_or(i32::MAX);
        self.line_count_fits(line_count)
    }

    fn line_count_fits(&self, line_count: i32) -> bool {
        let message_bottom = self
            .message_y
            .saturating_add(line_count.saturating_mul(LINE_HEIGHT));
        message_bottom <= self.confirm_rect.y
    }
}

impl ConfirmScreenState {
    fn render(&mut self, canvas: &mut Canvas<'_>, size: PhysicalSize<u32>) {
        let layout = ConfirmScreenLayout::for_size(size);
        canvas.fill_rect(layout.panel, PANEL);
        canvas.stroke_rect(layout.panel, PANEL_BORDER);
        canvas.draw_text(
            layout.panel.x + 18,
            layout.panel.y + 18,
            &self.title,
            WARNING,
        );

        match &self.content {
            ConfirmScreenContent::Plain(message) => {
                let lines = layout.message_lines(message);
                for (index, line) in lines.iter().enumerate() {
                    canvas.draw_text(
                        layout.message_x,
                        layout.message_y + ((index as i32) * LINE_HEIGHT),
                        line,
                        TEXT,
                    );
                }
            }
            ConfirmScreenContent::BiddingReview(page) => {
                let lines = layout.bidding_review_lines(page);
                for (index, line) in lines.iter().enumerate() {
                    let mut x = layout.message_x;
                    let y = layout.message_y + ((index as i32) * LINE_HEIGHT);
                    for span in line {
                        canvas.draw_text(x, y, &span.text, span.role.color());
                        x += (span.text.chars().count() as i32) * ADVANCE_WIDTH as i32;
                    }
                }
            }
        }

        draw_button(
            canvas,
            layout.confirm_rect,
            &self.confirm_label,
            self.focus == ConfirmFocus::Confirm,
            true,
            true,
        );
        draw_button(
            canvas,
            layout.cancel_rect,
            &self.cancel_label,
            self.focus == ConfirmFocus::Cancel,
            false,
            true,
        );
    }

    fn handle_navigation_key(&mut self, key: &Key) -> bool {
        match key {
            Key::Named(NamedKey::Tab)
            | Key::Named(NamedKey::ArrowLeft)
            | Key::Named(NamedKey::ArrowRight) => {
                self.focus = match self.focus {
                    ConfirmFocus::Confirm => ConfirmFocus::Cancel,
                    ConfirmFocus::Cancel => ConfirmFocus::Confirm,
                };
                true
            }
            _ => false,
        }
    }

    fn activate_focused(&self) -> Option<ScreenResult> {
        Some(match self.focus {
            ConfirmFocus::Confirm => ScreenResult::Confirmed,
            ConfirmFocus::Cancel => ScreenResult::Cancelled,
        })
    }

    fn handle_click(
        &mut self,
        position: PhysicalPosition<f64>,
        size: PhysicalSize<u32>,
    ) -> Option<ScreenResult> {
        let x = position.x as i32;
        let y = position.y as i32;
        let layout = ConfirmScreenLayout::for_size(size);
        if layout.confirm_rect.contains(x, y) {
            self.focus = ConfirmFocus::Confirm;
            return self.activate_focused();
        }
        if layout.cancel_rect.contains(x, y) {
            self.focus = ConfirmFocus::Cancel;
            return self.activate_focused();
        }
        None
    }
}

struct RevealScreenState {
    title: String,
    message: Zeroizing<String>,
    acknowledge_label: String,
}

impl RevealScreenState {
    fn render(&mut self, canvas: &mut Canvas<'_>, size: PhysicalSize<u32>) {
        let panel = Rect::new(
            CONTENT_MARGIN,
            CONTENT_MARGIN,
            size.width as i32 - (CONTENT_MARGIN * 2),
            size.height as i32 - (CONTENT_MARGIN * 2),
        );
        canvas.fill_rect(panel, PANEL);
        canvas.stroke_rect(panel, PANEL_BORDER);
        canvas.draw_text(panel.x + 18, panel.y + 18, &self.title, WARNING);

        let body_y = panel.y + 18 + LINE_HEIGHT + 8;
        let body_width = panel.w - 36;
        let max_cols = max(12, body_width / ADVANCE_WIDTH as i32);
        let lines = wrap_text(&self.message, max_cols as usize);
        for (index, line) in lines.iter().enumerate() {
            canvas.draw_text(
                panel.x + 18,
                body_y + ((index as i32) * LINE_HEIGHT),
                line,
                TEXT,
            );
        }

        let button_rect = Rect::new(
            panel.x + panel.w - BUTTON_WIDTH - BUTTON_EDGE_INSET,
            panel.y + panel.h - BUTTON_HEIGHT - 18,
            BUTTON_WIDTH,
            BUTTON_HEIGHT,
        );
        draw_button(
            canvas,
            button_rect,
            &self.acknowledge_label,
            true,
            true,
            true,
        );
    }

    fn handle_click(
        &mut self,
        position: PhysicalPosition<f64>,
        size: PhysicalSize<u32>,
    ) -> Option<ScreenResult> {
        let x = position.x as i32;
        let y = position.y as i32;
        let panel = Rect::new(
            CONTENT_MARGIN,
            CONTENT_MARGIN,
            size.width as i32 - (CONTENT_MARGIN * 2),
            size.height as i32 - (CONTENT_MARGIN * 2),
        );
        let button_rect = Rect::new(
            panel.x + panel.w - BUTTON_WIDTH - BUTTON_EDGE_INSET,
            panel.y + panel.h - BUTTON_HEIGHT - 18,
            BUTTON_WIDTH,
            BUTTON_HEIGHT,
        );
        if button_rect.contains(x, y) {
            return Some(ScreenResult::Acknowledged);
        }
        None
    }
}

struct Canvas<'a> {
    pixels: &'a mut [u32],
    width: usize,
    height: usize,
}

impl<'a> Canvas<'a> {
    fn new(pixels: &'a mut [u32], width: usize, height: usize) -> Self {
        Self {
            pixels,
            width,
            height,
        }
    }

    fn fill_rect(&mut self, rect: Rect, color: u32) {
        let x0 = max(0, rect.x) as usize;
        let y0 = max(0, rect.y) as usize;
        let x1 = min(self.width as i32, rect.x + rect.w) as usize;
        let y1 = min(self.height as i32, rect.y + rect.h) as usize;
        for y in y0..y1 {
            let row = y * self.width;
            for x in x0..x1 {
                self.pixels[row + x] = color;
            }
        }
    }

    fn stroke_rect(&mut self, rect: Rect, color: u32) {
        self.fill_rect(Rect::new(rect.x, rect.y, rect.w, 2), color);
        self.fill_rect(Rect::new(rect.x, rect.y + rect.h - 2, rect.w, 2), color);
        self.fill_rect(Rect::new(rect.x, rect.y, 2, rect.h), color);
        self.fill_rect(Rect::new(rect.x + rect.w - 2, rect.y, 2, rect.h), color);
    }

    fn draw_text(&mut self, x: i32, y: i32, text: &str, color: u32) {
        let mut cursor_x = x;
        for ch in text.chars() {
            if ch == ' ' {
                cursor_x += ADVANCE_WIDTH as i32;
                continue;
            }
            if let Some(rows) = glyph_rows(ch) {
                self.draw_glyph_rows_with_color(cursor_x, y, rows, color);
            }
            cursor_x += ADVANCE_WIDTH as i32;
        }
    }

    fn draw_glyph_rows_with_color(
        &mut self,
        x: i32,
        y: i32,
        rows: &[u32; CELL_HEIGHT],
        color: u32,
    ) {
        for (row_index, bits) in rows.iter().enumerate() {
            let py = y + row_index as i32;
            if py < 0 || py >= self.height as i32 {
                continue;
            }
            for bit_x in 0..CELL_WIDTH {
                if ((bits >> bit_x) & 1) == 0 {
                    continue;
                }
                let px = x + bit_x as i32;
                if px < 0 || px >= self.width as i32 {
                    continue;
                }
                self.pixels[(py as usize * self.width) + px as usize] = color;
            }
        }
    }
}

#[derive(Clone, Copy)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl Rect {
    const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }

    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}

fn draw_button(
    canvas: &mut Canvas<'_>,
    rect: Rect,
    label: &str,
    focused: bool,
    primary: bool,
    enabled: bool,
) {
    let fill = if !enabled {
        BUTTON_DISABLED
    } else if primary {
        BUTTON_PRIMARY
    } else {
        BUTTON_SECONDARY
    };
    let text_color = if !enabled {
        BUTTON_DISABLED_TEXT
    } else if primary {
        BUTTON_PRIMARY_TEXT
    } else {
        BUTTON_SECONDARY_TEXT
    };
    canvas.fill_rect(rect, fill);
    canvas.stroke_rect(
        rect,
        if !enabled {
            PANEL_BORDER
        } else if focused {
            PANEL_BORDER_ACTIVE
        } else {
            PANEL_BORDER
        },
    );
    let label_width = (label.len() as i32) * ADVANCE_WIDTH as i32;
    let label_x = rect.x + max(0, (rect.w - label_width) / 2);
    let label_y = rect.y + max(0, (rect.h - CELL_HEIGHT as i32) / 2);
    canvas.draw_text(label_x, label_y, label, text_color);
}

fn draw_masked_text(canvas: &mut Canvas<'_>, x: i32, y: i32, count: usize, color: u32) {
    for index in 0..count {
        let dot_x = x + (index as i32 * ADVANCE_WIDTH as i32) + 2;
        canvas.fill_rect(Rect::new(dot_x, y + 10, 8, 8), color);
    }
}

fn visible_text_columns(input_width: i32) -> usize {
    max(
        1,
        (input_width - (FIELD_INNER_PADDING_X * 2) - CARET_TEXT_GAP_PX) / ADVANCE_WIDTH as i32,
    ) as usize
}

fn glyph_rows(ch: char) -> Option<&'static [u32; CELL_HEIGHT]> {
    let code = ch as u32;
    if !(ASCII_START as u32..=ASCII_END as u32).contains(&code) {
        return None;
    }
    ASCII_GLYPHS.get((code as usize) - ASCII_START as usize)
}

fn wrap_text(text: &str, max_cols: usize) -> Vec<Zeroizing<String>> {
    let mut lines = Vec::<Zeroizing<String>>::new();
    for raw_line in text.split('\n') {
        if raw_line.is_empty() {
            lines.push(Zeroizing::new(String::new()));
            continue;
        }
        let mut start = 0;
        let bytes = raw_line.as_bytes();
        while start < bytes.len() {
            let remaining = bytes.len() - start;
            let take = min(max_cols, remaining);
            lines.push(Zeroizing::new(raw_line[start..start + take].to_owned()));
            start += take;
        }
    }
    if lines.is_empty() {
        lines.push(Zeroizing::new(String::new()));
    }
    lines
}

fn wrap_bidding_review_page(
    page: &BiddingReviewPage,
    max_cols: usize,
) -> Vec<BiddingReviewTextLine> {
    let mut lines = page
        .heading
        .as_deref()
        .map(|heading| {
            wrap_bidding_review_spans(vec![(heading, BiddingReviewTextRole::Plain)], max_cols)
        })
        .unwrap_or_default();
    for row in &page.rows {
        let indentation = " ".repeat(row.indentation_columns);
        let label = format!("{indentation}{}: ", row.label);
        let mut spans = vec![(label.as_str(), BiddingReviewTextRole::Label)];
        spans.extend(row.values.iter().map(|value| match value {
            BiddingReviewValue::Plain(value) => (value.as_str(), BiddingReviewTextRole::Plain),
            BiddingReviewValue::Amount(value) => (value.as_str(), BiddingReviewTextRole::Amount),
        }));
        lines.extend(wrap_bidding_review_spans(spans, max_cols));
    }
    lines
}

fn wrap_bidding_review_spans(
    spans: Vec<(&str, BiddingReviewTextRole)>,
    max_cols: usize,
) -> Vec<BiddingReviewTextLine> {
    let mut lines = vec![BiddingReviewTextLine::new()];
    let mut column = 0;
    for (text, role) in spans {
        let text_columns = text.chars().count();
        if role == BiddingReviewTextRole::Amount
            && text_columns <= max_cols
            && column > 0
            && column + text_columns > max_cols
        {
            // Keep an exact amount and its unit together when both fit on one line.
            lines.push(Vec::new());
            column = 0;
        }
        for character in text.chars() {
            if column == max_cols {
                lines.push(Vec::new());
                column = 0;
            }
            let current_line = lines.last_mut().expect("review line must exist");
            if let Some(current_span) = current_line.last_mut()
                && current_span.role == role
            {
                current_span.text.push(character);
            } else {
                current_line.push(BiddingReviewTextSpan {
                    text: character.to_string(),
                    role,
                });
            }
            column += 1;
        }
    }
    lines
}

fn adjusted_scroll(current: usize, cursor_index: usize, visible_chars: usize) -> usize {
    if cursor_index < current {
        return cursor_index;
    }
    if cursor_index >= current + visible_chars {
        return cursor_index.saturating_sub(visible_chars.saturating_sub(1));
    }
    current
}

fn take_sensitive_text(mut value: Zeroizing<String>) -> String {
    std::mem::take(&mut *value)
}

fn take_optional_sensitive_text(value: &mut Option<Zeroizing<String>>) -> String {
    value.take().map(take_sensitive_text).unwrap_or_default()
}

fn zeroize_optional_text(value: &mut Option<Zeroizing<String>>) {
    if let Some(value) = value {
        value.zeroize();
    }
    *value = None;
}

fn sanitize_initial_value(
    value: &str,
    input_kind: TextInputKind,
    max_len: usize,
) -> Zeroizing<String> {
    let normalized = normalize_submit(value, input_kind);
    Zeroizing::new(normalized.chars().take(max_len).collect())
}

fn filter_insert_text(text: &str, input_kind: TextInputKind) -> Zeroizing<String> {
    Zeroizing::new(match input_kind {
        TextInputKind::PrivateKey => text
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .filter(|ch| ch.is_ascii_hexdigit() || *ch == 'x' || *ch == 'X')
            .collect(),
        _ => text
            .chars()
            .filter(|ch| ch.is_ascii() && !ch.is_ascii_control())
            .collect(),
    })
}

fn normalize_paste(text: &str, input_kind: TextInputKind) -> Zeroizing<String> {
    Zeroizing::new(match input_kind {
        TextInputKind::PrivateKey => text
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .filter(|ch| ch.is_ascii_hexdigit() || *ch == 'x' || *ch == 'X')
            .collect(),
        _ => text
            .trim_end_matches(['\r', '\n'])
            .chars()
            .filter(|ch| ch.is_ascii() && !ch.is_ascii_control())
            .collect(),
    })
}

fn normalize_submit(text: &str, input_kind: TextInputKind) -> Zeroizing<String> {
    Zeroizing::new(match input_kind {
        TextInputKind::PrivateKey => text.chars().filter(|ch| !ch.is_whitespace()).collect(),
        _ => text.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_key_paste_strips_whitespace() {
        assert_eq!(
            normalize_paste(" 0x12 34\n", TextInputKind::PrivateKey).as_str(),
            "0x1234"
        );
    }

    #[test]
    fn label_insert_rejects_control_chars() {
        assert_eq!(
            filter_insert_text("abc\tdef\n", TextInputKind::Label).as_str(),
            "abcdef"
        );
    }

    #[test]
    fn wrap_text_hard_wraps_ascii_lines() {
        assert_eq!(
            wrap_text("abcdef", 4)
                .iter()
                .map(|line| line.as_str())
                .collect::<Vec<_>>(),
            vec!["abcd".to_owned(), "ef".to_owned()]
        );
    }

    #[test]
    fn bidding_reviews_use_the_tall_unlock_window() {
        let review_pages = vec![BiddingReviewPage {
            heading: Some("Bidding authorization".to_owned()),
            rows: Vec::new(),
        }];

        assert_eq!(
            resolve_unlock_window_size(&review_pages).unwrap(),
            BIDDING_REVIEW_WINDOW_SIZE
        );
        assert_eq!(resolve_unlock_window_size(&[]).unwrap(), UNLOCK_WINDOW_SIZE);
    }

    #[test]
    fn bidding_review_fit_guard_rejects_the_first_oversized_row() {
        let layout = ConfirmScreenLayout::for_size(PhysicalSize::new(
            BIDDING_REVIEW_WINDOW_SIZE.0,
            BIDDING_REVIEW_WINDOW_SIZE.1,
        ));
        let maximum_rows = ((layout.confirm_rect.y - layout.message_y) / LINE_HEIGHT) as usize;
        let build_page = |row_count| BiddingReviewPage {
            heading: None,
            rows: (0..row_count)
                .map(|_| BiddingReviewRow::plain("x", "y"))
                .collect(),
        };
        let fitting_page = build_page(maximum_rows);
        let oversized_page = build_page(maximum_rows + 1);

        assert!(layout.bidding_review_fits(&fitting_page));
        assert!(!layout.bidding_review_fits(&oversized_page));
        assert!(validate_bidding_review_pages(&[fitting_page]).is_ok());
        assert!(validate_bidding_review_pages(&[oversized_page]).is_err());
    }

    #[test]
    fn bidding_review_wrap_preserves_label_amount_and_plain_roles() {
        let page = BiddingReviewPage {
            heading: None,
            rows: vec![BiddingReviewRow::with_values(
                "Allowance",
                vec![
                    BiddingReviewValue::amount("1 WETH"),
                    BiddingReviewValue::plain(" for conduit"),
                ],
            )],
        };

        let lines = wrap_bidding_review_page(&page, 15);

        assert_eq!(
            lines,
            vec![
                vec![BiddingReviewTextSpan {
                    text: "Allowance: ".to_owned(),
                    role: BiddingReviewTextRole::Label,
                }],
                vec![
                    BiddingReviewTextSpan {
                        text: "1 WETH".to_owned(),
                        role: BiddingReviewTextRole::Amount,
                    },
                    BiddingReviewTextSpan {
                        text: " for cond".to_owned(),
                        role: BiddingReviewTextRole::Plain,
                    },
                ],
                vec![BiddingReviewTextSpan {
                    text: "uit".to_owned(),
                    role: BiddingReviewTextRole::Plain,
                }],
            ]
        );
    }

    #[test]
    fn bidding_review_render_uses_cyan_labels_and_artgod_yellow_amounts() {
        assert_eq!(BiddingReviewTextRole::Plain.color(), TEXT);
        assert_eq!(BiddingReviewTextRole::Label.color(), ARTGOD_CYAN);
        assert_eq!(BiddingReviewTextRole::Amount.color(), ARTGOD_YELLOW);
        assert_ne!(
            BiddingReviewTextRole::Label.color(),
            BiddingReviewTextRole::Plain.color()
        );
        assert_ne!(
            BiddingReviewTextRole::Amount.color(),
            BiddingReviewTextRole::Plain.color()
        );

        let size = PhysicalSize::new(BIDDING_REVIEW_WINDOW_SIZE.0, BIDDING_REVIEW_WINDOW_SIZE.1);
        let mut pixels = vec![BACKGROUND; size.width as usize * size.height as usize];
        let mut canvas = Canvas::new(&mut pixels, size.width as usize, size.height as usize);
        let mut screen = ConfirmScreenState {
            title: "Unlock Wallet".to_owned(),
            content: ConfirmScreenContent::BiddingReview(BiddingReviewPage {
                heading: Some("Bidding authorization".to_owned()),
                rows: vec![BiddingReviewRow::with_values(
                    "Allowance",
                    vec![BiddingReviewValue::amount("1 WETH")],
                )],
            }),
            confirm_label: REVIEW_NEXT_LABEL.to_owned(),
            cancel_label: "Cancel".to_owned(),
            focus: ConfirmFocus::Cancel,
        };

        screen.render(&mut canvas, size);

        assert!(pixels.contains(&BIDDING_REVIEW_LABEL));
        assert!(pixels.contains(&BIDDING_REVIEW_AMOUNT));
        assert!(pixels.contains(&TEXT));
        assert_ne!(BIDDING_REVIEW_AMOUNT, WARNING);
    }

    #[test]
    fn min_length_validation_blocks_short_passphrase_submit() {
        let screen = TextScreenState {
            title: "Import Wallet".to_owned(),
            message: "Keystore passphrase".to_owned(),
            value: Zeroizing::new("short".to_owned()),
            mode: TextPromptMode::Secret,
            ok_label: "OK".to_owned(),
            cancel_label: "Cancel".to_owned(),
            input_kind: TextInputKind::Passphrase,
            max_len: 256,
            validation: TextValidation::MinLength { min_length: 12 },
            focus: TextFocus::Input,
            cursor_index: 5,
            scroll_offset: 0,
        };

        assert!(!screen.can_submit());
        assert!(
            screen
                .validation_feedback()
                .is_some_and(|feedback| feedback.blocking)
        );
    }

    #[test]
    fn matching_validation_accepts_matching_confirmation() {
        let screen = TextScreenState {
            title: "Import Wallet".to_owned(),
            message: "Confirm keystore passphrase".to_owned(),
            value: Zeroizing::new("very-secret-123".to_owned()),
            mode: TextPromptMode::Secret,
            ok_label: "OK".to_owned(),
            cancel_label: "Cancel".to_owned(),
            input_kind: TextInputKind::Passphrase,
            max_len: 256,
            validation: TextValidation::MatchesValue {
                expected: Zeroizing::new("very-secret-123".to_owned()),
            },
            focus: TextFocus::Input,
            cursor_index: 15,
            scroll_offset: 0,
        };

        assert!(screen.can_submit());
        assert!(
            screen
                .validation_feedback()
                .is_some_and(|feedback| !feedback.blocking)
        );
    }

    #[test]
    fn exact_value_validation_blocks_mismatch() {
        let screen = TextScreenState {
            title: "Export Wallet".to_owned(),
            message: "Type EXPORT to continue".to_owned(),
            value: Zeroizing::new("WRONG".to_owned()),
            mode: TextPromptMode::Plain,
            ok_label: "OK".to_owned(),
            cancel_label: "Cancel".to_owned(),
            input_kind: TextInputKind::Confirmation,
            max_len: 64,
            validation: TextValidation::ExactValue {
                expected: Zeroizing::new("EXPORT".to_owned()),
            },
            focus: TextFocus::Input,
            cursor_index: 5,
            scroll_offset: 0,
        };

        assert!(!screen.can_submit());
        assert_eq!(
            screen
                .validation_feedback()
                .map(|feedback| feedback.message),
            Some("Type EXPORT exactly to continue.".to_owned())
        );
    }

    #[test]
    fn forced_export_reveal_closure_scrubs_private_key_ui_state() {
        let private_key = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let screen = build_reveal_screen(RevealPromptSpec {
            title: "Export Wallet",
            message: private_key,
            acknowledge_label: "Close",
        });
        let mut app = PromptApp::new(
            "Export Wallet".to_owned(),
            PromptFlow::SingleReveal,
            screen,
            REVEAL_WINDOW_SIZE,
            OwnerLiveness::default(),
        );

        app.scrub_secret_state();

        let ScreenState::Reveal(reveal) = &app.screen else {
            panic!("export reveal screen must remain inspectable after explicit scrub");
        };
        assert!(reveal.message.is_empty());
        assert!(app.result.is_none());
    }
}
