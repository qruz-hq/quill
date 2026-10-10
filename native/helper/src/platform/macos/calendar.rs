//! Capability `calendar` on macOS: todos to Calendar.app, through EventKit
//! (section 8).
//!
//! Full access rather than write-only on purpose: write-only cannot fetch an
//! event by identifier afterwards, so every edit would create a duplicate.
//!
//! The session calls `call` on its calendar worker thread, one op at a time.
//! The event store lives on that thread and never leaves it; only `request`
//! answers from elsewhere (EventKit's own queue, once the user has chosen),
//! and that answer touches no store.

use std::cell::RefCell;
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2::{msg_send, sel};
use objc2_app_kit::{NSColor, NSColorSpace};
use objc2_event_kit::{EKAuthorizationStatus, EKCalendar, EKEntityType, EKEvent, EKEventStore, EKSpan};
use objc2_foundation::{NSCalendar, NSDate, NSDateComponents, NSError, NSObjectProtocol, NSString};
use quill_core::caps::{CalReply, Calendar};
use quill_core::logln;
use serde_json::{json, Map, Value};

pub fn create() -> Arc<dyn Calendar> {
    Arc::new(EventKitCalendar)
}

struct EventKitCalendar;

impl Calendar for EventKitCalendar {
    fn supported(&self) -> bool {
        true
    }

    fn call(&self, op: &str, args: &Map<String, Value>, reply: CalReply) {
        match op {
            "status" => reply(fields([("status", json!(status()))])),
            "request" => request(reply),
            "calendars" => reply(guarded(calendars)),
            "upsert" => reply(guarded(|store| upsert(store, args))),
            "delete" => reply(guarded(|store| delete(store, text(args, "eventId")))),
            // The session answers unknown ops itself; this is for a caller that does not.
            other => reply(failure(format!("unknown op {other}"))),
        }
    }
}

// ------------------------------------------------------------- pure parts

fn fields<const N: usize>(pairs: [(&str, Value); N]) -> Map<String, Value> {
    pairs.into_iter().map(|(key, value)| (key.to_string(), value)).collect()
}

fn failure(message: impl Into<String>) -> Map<String, Value> {
    fields([("error", json!(message.into()))])
}

/// A string argument; missing or not a string reads as empty.
fn text<'a>(args: &'a Map<String, Value>, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}

/// The four words main knows (section 9).
fn status_word(raw: isize) -> &'static str {
    match raw {
        // Also what "authorized" was before macOS 14.
        3 => "granted",
        4 => "writeOnly",
        // Restricted (parental controls, a profile) and denied.
        1 | 2 => "denied",
        _ => "notDetermined",
    }
}

/// The numbers in `text` between `separator`s, as the Swift helper reads
/// them: empty pieces and pieces that are not whole numbers are skipped.
fn numbers(text: &str, separator: char) -> Vec<isize> {
    text.split(separator).filter(|piece| !piece.is_empty()).filter_map(|piece| piece.parse().ok()).collect()
}

/// `YYYY-MM-DD`. Only the shape is checked: like the Swift helper, a day past
/// the end of its month rolls into the next one.
fn parse_date(date: &str) -> Option<(isize, isize, isize)> {
    match numbers(date, '-')[..] {
        [year, month, day] => Some((year, month, day)),
        _ => None,
    }
}

/// `HH:MM`, or `Ok(None)` for all-day (an empty string).
fn parse_time(time: &str) -> Result<Option<(isize, isize)>, ()> {
    if time.is_empty() {
        return Ok(None);
    }
    match numbers(time, ':')[..] {
        [hour, minute] => Ok(Some((hour, minute))),
        _ => Err(()),
    }
}

/// Length of a timed event. Anything but a whole number means the default.
fn minutes(args: &Map<String, Value>) -> i64 {
    const DEFAULT: i64 = 30;
    // More than a year of minutes is not a todo; it also keeps the seconds exact as a float.
    const LIMIT: i64 = 366 * 24 * 60;
    let value = match args.get("minutes") {
        Some(Value::Number(n)) => {
            n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 1e12).map(|f| f as i64))
        }
        _ => None,
    };
    value.map_or(DEFAULT, |m| m.clamp(-LIMIT, LIMIT))
}

/// `#rrggbb` from sRGB components, each truncated to a byte as the Swift helper does.
fn hex(red: f64, green: f64, blue: f64) -> String {
    let byte = |component: f64| (component * 255.0).clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", byte(red), byte(green), byte(blue))
}

// ------------------------------------------------------------- EventKit

fn status() -> &'static str {
    // SAFETY: a class method that takes an enum and returns one.
    let raw = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
    status_word(raw.0)
}

fn granted() -> bool {
    // SAFETY: as in `status`.
    unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) == EKAuthorizationStatus::FullAccess }
}

struct Store {
    store: Retained<EKEventStore>,
    /// A store made before the user said yes can keep seeing no calendars.
    made_with_access: bool,
}

thread_local! {
    static STORE: RefCell<Option<Store>> = const { RefCell::new(None) };
}

/// The calendar thread's event store. It is made on first use and made again
/// once access has been granted since, so a grant given in System Settings
/// while the helper runs takes effect without a restart.
fn store() -> Retained<EKEventStore> {
    STORE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let now = granted();
        match slot.as_ref() {
            Some(existing) if existing.made_with_access || !now => existing.store.clone(),
            _ => {
                // SAFETY: plain `[[EKEventStore alloc] init]`.
                let fresh = unsafe { EKEventStore::new() };
                *slot = Some(Store { store: fresh.clone(), made_with_access: now });
                fresh
            }
        }
    })
}

/// Runs `op` with the store when access is full; otherwise the standard refusal.
fn guarded(op: impl FnOnce(&EKEventStore) -> Map<String, Value>) -> Map<String, Value> {
    if !granted() {
        return fields([("error", json!("no access")), ("status", json!(status()))]);
    }
    op(&store())
}

fn request(reply: CalReply) {
    let store = store();
    // The system calls the block once; the cell makes that a fact, not a hope.
    let reply = Mutex::new(Some(reply));
    let done = RcBlock::new(move |ok: Bool, error: *mut NSError| {
        // SAFETY: EventKit passes a valid NSError or nil, alive for this call.
        let detail = unsafe { error.as_ref() }.map(|e| format!(" ({})", e.localizedDescription())).unwrap_or_default();
        logln!("calendar: access {}{detail}", if ok.as_bool() { "granted" } else { "refused" });
        let reply = reply.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(reply) = reply {
            reply(fields([("status", json!(status()))]));
        }
    });
    // SAFETY: the block has the signature EventKit documents and is copied by
    // it; the selector is checked first, so nothing is sent that the system
    // does not answer.
    unsafe {
        if store.respondsToSelector(sel!(requestFullAccessToEventsWithCompletion:)) {
            store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&done));
        } else {
            // Before macOS 14 there was one kind of access.
            #[allow(deprecated)]
            store.requestAccessToEntityType_completion(EKEntityType::Event, RcBlock::as_ptr(&done));
        }
    }
}

fn identifier(calendar: &EKCalendar) -> String {
    // SAFETY: a getter. Declared non-null, read as nullable all the same.
    let id: Option<Retained<NSString>> = unsafe { msg_send![calendar, calendarIdentifier] };
    id.map(|s| s.to_string()).unwrap_or_default()
}

fn color(calendar: &EKCalendar) -> String {
    // SAFETY: a getter; nil for a calendar that has no colour yet.
    let color: Option<Retained<NSColor>> = unsafe { msg_send![calendar, color] };
    let Some(srgb) = color.and_then(|c| c.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())) else {
        return String::new();
    };
    hex(srgb.redComponent(), srgb.greenComponent(), srgb.blueComponent())
}

fn event_calendars(store: &EKEventStore) -> Vec<Retained<EKCalendar>> {
    // SAFETY: a getter that returns an array of calendars.
    unsafe { store.calendarsForEntityType(EKEntityType::Event) }.to_vec()
}

fn calendars(store: &EKEventStore) -> Map<String, Value> {
    // SAFETY: a getter; nil when the user has no calendar at all.
    let default = unsafe { store.defaultCalendarForNewEvents() }.map(|c| identifier(&c)).unwrap_or_default();
    let list: Vec<Value> = event_calendars(store)
        .iter()
        // SAFETY (the three below): getters on a calendar the store just returned.
        .filter(|calendar| unsafe { calendar.allowsContentModifications() })
        .map(|calendar| {
            let id = identifier(calendar);
            let title: Option<Retained<NSString>> = unsafe { msg_send![&**calendar, title] };
            let source = unsafe { calendar.source() }.map(|s| unsafe { s.title() }.to_string());
            json!({
                "id": id,
                "title": title.map(|t| t.to_string()).unwrap_or_default(),
                "source": source.unwrap_or_default(),
                "color": color(calendar),
                "isDefault": id == default,
            })
        })
        .collect();
    fields([("calendars", Value::Array(list))])
}

/// Local time, in the user's calendar. `None` when the system cannot make a
/// date of it.
fn local_date(date: (isize, isize, isize), time: Option<(isize, isize)>) -> Option<Retained<NSDate>> {
    let parts = NSDateComponents::new();
    parts.setYear(date.0);
    parts.setMonth(date.1);
    parts.setDay(date.2);
    if let Some((hour, minute)) = time {
        parts.setHour(hour);
        parts.setMinute(minute);
    }
    NSCalendar::currentCalendar().dateFromComponents(&parts)
}

/// Writes the todo's own fields into an event; nothing is saved.
fn fill(event: &EKEvent, title: &str, notes: &str, all_day: bool, start: &NSDate, end: &NSDate) {
    // SAFETY: setters on an event of this thread's store.
    unsafe {
        event.setTitle(Some(&NSString::from_str(title)));
        event.setNotes(if notes.is_empty() { None } else { Some(NSString::from_str(notes)) }.as_deref());
        event.setAllDay(all_day);
        event.setStartDate(Some(start));
        event.setEndDate(Some(end));
        // No alarm: the user chose to keep the calendar quiet.
        event.setAlarms(None);
    }
}

/// Creates or updates. `date` is YYYY-MM-DD, `time` HH:MM or empty for all-day.
fn upsert(store: &EKEventStore, args: &Map<String, Value>) -> Map<String, Value> {
    let notes = text(args, "notes");
    let calendar_id = text(args, "calendarId");
    let event_id = text(args, "eventId");

    // Both checked before anything is looked up or saved.
    let Some(date) = parse_date(text(args, "date")) else { return failure("bad date") };
    let Ok(time) = parse_time(text(args, "time")) else { return failure("bad time") };
    let all_day = time.is_none();
    let Some(start) = local_date(date, time) else { return failure("bad date") };
    let end = if all_day { start.clone() } else { start.dateByAddingTimeInterval(minutes(args) as f64 * 60.0) };

    // SAFETY (this block): EventKit getters and setters on objects of this
    // store, on the one thread that uses the store.
    unsafe {
        // An event that no longer exists is made anew, and answers with its new id.
        let existing = if event_id.is_empty() { None } else { store.eventWithIdentifier(&NSString::from_str(event_id)) };
        let event = existing.unwrap_or_else(|| EKEvent::eventWithEventStore(store));
        fill(&event, text(args, "title"), notes, all_day, &start, &end);
        // An existing event keeps its calendar unless the app asked to move it.
        let current = event.calendar().map(|c| identifier(&c));
        if current.is_none() || (!calendar_id.is_empty() && current.as_deref() != Some(calendar_id)) {
            let wanted = event_calendars(store).into_iter().find(|c| identifier(c) == calendar_id);
            let target = wanted.or_else(|| store.defaultCalendarForNewEvents());
            if target.is_none() && current.is_none() {
                // Saving an event that belongs to no calendar raises instead of failing.
                return failure("No calendar to add the event to.");
            }
            if let Some(target) = target {
                event.setCalendar(Some(&target));
            }
        }
        match store.saveEvent_span_commit_error(&event, EKSpan::ThisEvent, true) {
            Ok(()) => fields([
                ("eventId", json!(event.eventIdentifier().map(|s| s.to_string()).unwrap_or_default())),
                ("calendarId", json!(event.calendar().map(|c| identifier(&c)).unwrap_or_default())),
            ]),
            Err(error) => failure(error.localizedDescription().to_string()),
        }
    }
}

fn delete(store: &EKEventStore, event_id: &str) -> Map<String, Value> {
    let gone = || fields([("gone", json!(true))]);
    // SAFETY: a lookup and a removal on this thread's store.
    unsafe {
        let Some(event) = store.eventWithIdentifier(&NSString::from_str(event_id)) else { return gone() };
        match store.removeEvent_span_commit_error(&event, EKSpan::ThisEvent, true) {
            Ok(()) => gone(),
            Err(error) => failure(error.localizedDescription().to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn status_words_are_the_four_main_knows() {
        assert_eq!(status_word(0), "notDetermined");
        assert_eq!(status_word(1), "denied");
        assert_eq!(status_word(2), "denied");
        assert_eq!(status_word(3), "granted");
        assert_eq!(status_word(4), "writeOnly");
        assert_eq!(status_word(99), "notDetermined");
        assert_eq!(EKAuthorizationStatus::FullAccess.0, 3);
        assert_eq!(EKAuthorizationStatus::WriteOnly.0, 4);
    }

    #[test]
    fn dates_need_three_numbers() {
        assert_eq!(parse_date("2026-10-10"), Some((2026, 10, 10)));
        assert_eq!(parse_date("2026-1-2"), Some((2026, 1, 2)));
        assert_eq!(parse_date("2026-02-31"), Some((2026, 2, 31)), "the calendar rolls it over, as in Swift");
        for bad in ["", "not-a-date", "2026-10", "2026-10-10-10", "2026/10/10", "2026-10-1o", "10 Oct 2026"] {
            assert_eq!(parse_date(bad), None, "{bad}");
        }
    }

    #[test]
    fn an_empty_time_is_all_day() {
        assert_eq!(parse_time(""), Ok(None));
        assert_eq!(parse_time("09:05"), Ok(Some((9, 5))));
        assert_eq!(parse_time("23:59"), Ok(Some((23, 59))));
        for bad in ["9", "09:05:00", "nine", "09.05", ":", " "] {
            assert_eq!(parse_time(bad), Err(()), "{bad}");
        }
    }

    #[test]
    fn minutes_default_to_thirty() {
        assert_eq!(minutes(&args(json!({}))), 30);
        assert_eq!(minutes(&args(json!({"minutes": 45}))), 45);
        assert_eq!(minutes(&args(json!({"minutes": 45.0}))), 45);
        assert_eq!(minutes(&args(json!({"minutes": 45.5}))), 30);
        assert_eq!(minutes(&args(json!({"minutes": "45"}))), 30);
        assert_eq!(minutes(&args(json!({"minutes": null}))), 30);
        assert_eq!(minutes(&args(json!({"minutes": 1e300}))), 30);
        assert_eq!(minutes(&args(json!({"minutes": 99_999_999}))), 366 * 24 * 60);
    }

    #[test]
    fn colours_are_lower_case_hex_truncated() {
        assert_eq!(hex(1.0, 0.0, 0.0), "#ff0000");
        assert_eq!(hex(0.0, 0.5, 1.0), "#007fff");
        assert_eq!(hex(0.999, 0.001, 0.2), "#fe0033");
        assert_eq!(hex(1.2, -0.1, f64::NAN), "#ff0000");
    }

    #[test]
    fn missing_or_mistyped_arguments_read_as_empty() {
        let a = args(json!({"title": "Dentist", "eventId": 7, "notes": null}));
        assert_eq!(text(&a, "title"), "Dentist");
        assert_eq!(text(&a, "eventId"), "");
        assert_eq!(text(&a, "notes"), "");
        assert_eq!(text(&a, "calendarId"), "");
    }

    #[test]
    fn a_local_date_is_midnight_or_the_time_given() {
        let day = local_date((2026, 10, 10), None).expect("a date");
        let timed = local_date((2026, 10, 10), Some((9, 30))).expect("a date");
        assert_eq!(timed.timeIntervalSinceDate(&day), 9.5 * 3600.0);
    }

    /// Nothing here prompts, and nothing is saved: an event that is only
    /// built in memory needs no access.
    #[test]
    fn an_event_takes_every_field_before_it_is_saved() {
        let store = store();
        let start = local_date((2026, 10, 10), Some((9, 30))).unwrap();
        let end = start.dateByAddingTimeInterval(45.0 * 60.0);
        // SAFETY: getters on objects made on this thread.
        unsafe {
            let event = EKEvent::eventWithEventStore(&store);
            fill(&event, "Dentist", "bring the x-rays", false, &start, &end);
            assert_eq!(event.title().to_string(), "Dentist");
            assert_eq!(event.notes().map(|n| n.to_string()).as_deref(), Some("bring the x-rays"));
            assert!(!event.isAllDay());
            assert_eq!(event.endDate().timeIntervalSinceDate(&event.startDate()), 45.0 * 60.0);
            assert!(event.alarms().is_none_or(|a| a.is_empty()));

            fill(&event, "Dentist", "", true, &start, &start);
            assert!(event.notes().is_none());
            assert!(event.isAllDay());

            assert!(store.eventWithIdentifier(&NSString::from_str("quill-test-no-such-event")).is_none());
        }
        // Without access the lists are simply empty; with it they are the user's, only read.
        let listed = calendars(&store);
        let list = listed["calendars"].as_array().expect("a list");
        for calendar in list {
            assert!(calendar["id"].as_str().is_some_and(|id| !id.is_empty()));
            let color = calendar["color"].as_str().expect("a colour string");
            assert!(color.is_empty() || (color.len() == 7 && color.starts_with('#')));
            assert!(calendar["isDefault"].is_boolean());
        }
        assert!(list.iter().filter(|c| c["isDefault"] == json!(true)).count() <= 1);
    }

    /// Never prompts and never reads a calendar.
    #[test]
    fn status_is_always_one_of_the_four_words() {
        assert!(["granted", "writeOnly", "denied", "notDetermined"].contains(&status()));
    }

    #[test]
    fn without_access_every_calendar_op_is_refused_with_the_status() {
        if granted() {
            return;
        }
        let refused = guarded(|_| panic!("the store is not touched without access"));
        assert_eq!(refused.get("error"), Some(&json!("no access")));
        assert_eq!(refused.get("status"), Some(&json!(status())));
    }
}
