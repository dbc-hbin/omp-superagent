use base64::{Engine, prelude::BASE64_STANDARD};
use serde::Deserialize;

use crate::adapter::EffectError;

const FILE_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ResultAttachment {
    pub name: String,
    data: String,
}

impl ResultAttachment {
    pub fn bytes(&self) -> Result<Vec<u8>, EffectError> {
        if self.name.is_empty()
            || self.name.len() > 180
            || self.name.starts_with('.')
            || self.name.trim() != self.name
            || self.name.contains(['/', '\\', '"', '%'])
            || self.name.chars().any(char::is_control)
            || self.data.is_empty()
            || self.data.len() > FILE_LIMIT.div_ceil(3) * 4
        {
            return Err(EffectError::rejected("Invalid result attachment filename or size"));
        }
        let data = BASE64_STANDARD
            .decode(&self.data)
            .map_err(|_| EffectError::rejected("Invalid result attachment encoding"))?;
        if data.is_empty() || data.len() > FILE_LIMIT {
            return Err(EffectError::rejected("Result attachment exceeds its safe size bound"));
        }
        Ok(data)
    }
}
