//! Which volume controls of an output are ducked, and how devices are named
//! inside the helper. No OS types, so it can be tested as is.

/// Control 0 is the endpoint's master volume; control `n` is channel `n - 1`.
pub const MASTER: u32 = 0;

/// Channels count as level when they are this close to each other.
const BALANCED: f32 = 0.005;

/// Picks the controls to save, lower and put back.
///
/// The master volume alone is enough when the channels are level: Windows
/// scales them together and the user sees one slider move. When the user has
/// set a balance (left and right differ), or the endpoint has no master
/// volume, each channel is handled by itself, so that ducking to silence and
/// back cannot flatten the balance.
pub fn pick(master: Option<f32>, channels: &[Option<f32>]) -> Vec<u32> {
    let readable: Vec<(u32, f32)> =
        channels.iter().enumerate().filter_map(|(index, value)| Some((index as u32 + 1, (*value)?))).collect();
    let low = readable.iter().map(|c| c.1).fold(f32::INFINITY, f32::min);
    let high = readable.iter().map(|c| c.1).fold(f32::NEG_INFINITY, f32::max);
    let level = readable.len() < 2 || high - low <= BALANCED;
    // Every channel has to be readable to be put back; otherwise the master it is.
    let all_readable = readable.len() == channels.len();
    if master.is_some() && (level || !all_readable) {
        return vec![MASTER];
    }
    readable.into_iter().map(|c| c.0).collect()
}

/// Endpoint ids are strings, and the shared ducking code wants a handle it can
/// copy. This hands out a small number per id, for the life of the process.
#[derive(Default)]
pub struct Names {
    ids: Vec<String>,
}

impl Names {
    pub fn intern(&mut self, id: &str) -> usize {
        match self.ids.iter().position(|known| known == id) {
            Some(index) => index,
            None => {
                self.ids.push(id.to_string());
                self.ids.len() - 1
            }
        }
    }

    pub fn id(&self, handle: usize) -> Option<&str> {
        self.ids.get(handle).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_channels_use_the_master_volume() {
        assert_eq!(pick(Some(0.5), &[Some(0.5), Some(0.5)]), vec![MASTER]);
        assert_eq!(pick(Some(0.5), &[Some(0.5), Some(0.503)]), vec![MASTER]);
        assert_eq!(pick(Some(0.8), &[Some(0.8)]), vec![MASTER]); // mono
        assert_eq!(pick(Some(0.8), &[]), vec![MASTER]); // no per-channel volume
    }

    #[test]
    fn a_balance_is_kept_by_ducking_each_channel() {
        assert_eq!(pick(Some(0.8), &[Some(0.8), Some(0.4)]), vec![1, 2]);
        assert_eq!(pick(Some(0.6), &[Some(0.6), Some(0.6), Some(0.3), Some(0.6)]), vec![1, 2, 3, 4]);
    }

    #[test]
    fn no_master_volume_falls_back_to_the_channels() {
        assert_eq!(pick(None, &[Some(0.5), Some(0.5)]), vec![1, 2]);
        assert_eq!(pick(None, &[None, Some(0.5)]), vec![2]);
    }

    #[test]
    fn a_channel_that_cannot_be_read_leaves_it_to_the_master() {
        assert_eq!(pick(Some(0.8), &[Some(0.8), None]), vec![MASTER]);
    }

    #[test]
    fn nothing_readable_is_nothing_to_duck() {
        assert_eq!(pick(None, &[]), Vec::<u32>::new());
        assert_eq!(pick(None, &[None, None]), Vec::<u32>::new());
    }

    #[test]
    fn an_endpoint_keeps_its_handle() {
        let mut names = Names::default();
        let speakers = names.intern("{0.0.0.00000000}.{aaaa}");
        let headset = names.intern("{0.0.0.00000000}.{bbbb}");
        assert_ne!(speakers, headset);
        assert_eq!(names.intern("{0.0.0.00000000}.{aaaa}"), speakers);
        assert_eq!(names.id(headset), Some("{0.0.0.00000000}.{bbbb}"));
        assert_eq!(names.id(99), None);
    }
}
