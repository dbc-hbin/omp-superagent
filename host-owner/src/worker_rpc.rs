use serde_json::{Map, Value};

// The peer and stock SDK share a wire protocol, not an authority level.
// Check the already decoded frame before any public command can change owner
// state, use its private lifecycle channel, or reach stock OMP.
pub(crate) fn allows(kind: &str, frame: &Value) -> bool {
    let Some(fields) = frame.as_object() else {
        return false;
    };
    if !optional(fields, "id", nonempty) {
        return false;
    }
    let exact = |keys: &[&str]| {
        fields
            .keys()
            .all(|key| matches!(key.as_str(), "id" | "type") || keys.contains(&key.as_str()))
    };
    match kind {
        "negotiate_protocol" => exact(&["protocolVersion"]) && frame["protocolVersion"] == 2,
        "get_host_admission" => {
            exact(&["messageUpdateCapability"])
                && optional(fields, "messageUpdateCapability", Value::is_boolean)
        }
        "set_host_message_updates" => {
            exact(&["messageUpdates"])
                && matches!(frame["messageUpdates"].as_str(), Some("full" | "activity-v1"))
        }
        "get_state"
        | "get_journal_cursor"
        | "get_subagents"
        | "get_available_commands"
        | "abort"
        | "abort_and_restore_queue"
        | "shutdown_host" => exact(&[]),
        "get_entries" => exact(&["since"]) && optional(fields, "since", nonempty),
        "prompt" => {
            // Runtime does not transport attachments to remote lanes.
            exact(&["message", "streamingBehavior", "replyVoice"])
                && frame["message"].as_str().is_some_and(ordinary_prompt)
                && optional(fields, "streamingBehavior", |value| value == "steer")
                && optional(fields, "replyVoice", |_| reply_voice(kind, fields))
        }
        "goal" => exact(&["op"]) && matches!(frame["op"].as_str(), Some("pause" | "resume")),
        "cancel_subagent" => exact(&["subagentId"]) && nonempty(&frame["subagentId"]),
        "set_model" | "set_lane_model" => {
            exact(&["provider", "modelId"])
                && model_id(&frame["provider"])
                && model_id(&frame["modelId"])
        }
        "set_model_preset" => {
            exact(&["name", "preset"])
                && frame["name"].as_str().is_some_and(role_name)
                && model_preset(&frame["preset"])
        }
        "extension_ui_response" => {
            nonempty(&frame["id"])
                && fields.len() == 3
                && (frame["cancelled"] == true
                    || frame["confirmed"].is_boolean()
                    || frame["value"].is_string()
                    || frame["answers"]
                        .as_array()
                        .is_some_and(|answers| answers.iter().all(ask_answer_shape)))
        }
        // Do not infer read safety from `get_`, or add aliases for native
        // commands that read a caller's path, change sessions, or run work outside a turn.
        _ => false,
    }
}

pub(crate) fn reply_voice(kind: &str, fields: &Map<String, Value>) -> bool {
    kind == "prompt"
        && !fields.contains_key("streamingBehavior")
        && fields.get("message").is_some_and(Value::is_string)
        && fields
            .get("replyVoice")
            .and_then(Value::as_object)
            .is_some_and(|voice| {
                voice.len() == 5 + usize::from(voice.contains_key("concept"))
                    && optional(voice, "concept", |value| matches!(value.as_str(), Some("plain" | "editorial" | "mentoring")))
                    && matches!(voice.get("tone").and_then(Value::as_str), Some("direct" | "warm" | "neutral"))
                    && matches!(voice.get("register").and_then(Value::as_str), Some("natural" | "formal" | "casual"))
                    && matches!(voice.get("detail").and_then(Value::as_str), Some("balanced" | "brief" | "detailed"))
                    && matches!(voice.get("structure").and_then(Value::as_str), Some("answer-first" | "evidence-first" | "natural"))
                    && matches!(voice.get("emoji").and_then(Value::as_str), Some("none" | "light"))
            })
}

// The local socket accepts literal provider and model IDs supported by stock
// OMP, including spaces. The worker wire keeps its narrower selector policy.
pub(crate) fn lane_model_selection(frame: &Value) -> bool {
    frame.as_object().is_some_and(|fields| {
        fields
            .keys()
            .all(|key| matches!(key.as_str(), "id" | "type" | "provider" | "modelId"))
            && optional(fields, "id", nonempty)
            && ["provider", "modelId"].iter().all(|key| {
                frame[*key]
                    .as_str()
                    .is_some_and(|text| !text.trim().is_empty() && !text.contains('\0'))
            })
    })
}

fn optional(fields: &Map<String, Value>, key: &str, valid: impl FnOnce(&Value) -> bool) -> bool {
    fields.get(key).is_none_or(valid)
}

fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.is_empty())
}

fn ordinary_prompt(message: &str) -> bool {
    // Stock `prompt` interprets leading slash commands and whitespace-delimited
    // `/skill:` tokens before the agent and its tools. JS whitespace includes BOM.
    let mut words = message
        .split(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
        .filter(|word| !word.is_empty());
    words.next().is_none_or(|first| !first.starts_with('/'))
        && !words.any(|word| word.starts_with("/skill:"))
}

pub(crate) fn model_id(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        !text.is_empty() && !text.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    })
}

fn role_name(text: &str) -> bool {
    let mut bytes = text.bytes();
    text.len() <= 128
        && bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn model_preset(preset: &Value) -> bool {
    let Some(fields) = preset.as_object() else {
        return false;
    };
    fields
        .keys()
        .all(|key| matches!(key.as_str(), "modelRoles" | "defaultThinkingLevel"))
        && preset["modelRoles"].as_object().is_some_and(|roles| {
            roles.len() <= 128
                && roles.iter().all(|(name, selector)| {
                    role_name(name)
                        && !matches!(name.as_str(), "constructor" | "prototype")
                        && selector.as_str().is_some_and(|selector| {
                            !selector.trim().is_empty() && !selector.chars().any(char::is_control)
                        })
                })
        })
        && optional(fields, "defaultThinkingLevel", |level| {
            matches!(
                level.as_str(),
                Some("auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
            )
        })
}

fn ask_answer_shape(answer: &Value) -> bool {
    answer.as_object().is_some_and(|fields| {
        fields
            .keys()
            .all(|key| matches!(key.as_str(), "id" | "selectedOptions" | "customInput"))
            && nonempty(&answer["id"])
            && answer["selectedOptions"]
                .as_array()
                .is_some_and(|options| options.iter().all(Value::is_string))
            && optional(fields, "customInput", Value::is_string)
    })
}

pub(crate) fn allows_answer(response: &Value, request: &Value) -> bool {
    // The owner has already looked up this exact outstanding native ID.
    // Keep malformed or method-mismatched responses from consuming the request.
    if response["cancelled"] == true {
        return true;
    }
    match request["method"].as_str() {
        Some("confirm") => response["confirmed"].is_boolean(),
        Some("select") => {
            let value = &response["value"];
            value.is_string()
                && request["options"]
                    .as_array()
                    .is_some_and(|options| options.contains(value))
        }
        Some("input" | "editor") => request["secret"] != true && response["value"].is_string(),
        Some("ask") => {
            let (Some(answers), Some(questions)) =
                (response["answers"].as_array(), request["questions"].as_array())
            else {
                return false;
            };
            answers.len() == questions.len()
                && answers.iter().zip(questions).all(|(answer, question)| {
                    let Some(selected) = answer["selectedOptions"].as_array() else {
                        return false;
                    };
                    let custom = answer["customInput"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty());
                    answer["id"] == question["id"]
                        && (question["multi"] == true || selected.len() + usize::from(custom) <= 1)
                        && question["options"].as_array().is_some_and(|options| {
                            selected.iter().enumerate().all(|(index, label)| {
                                !selected[..index].contains(label)
                                    && options.iter().any(|option| &option["label"] == label)
                            })
                        })
                })
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::allows;

    #[test]
    fn worker_voice_is_bounded_to_new_ordinary_prompts() {
        let initial = json!({"type": "prompt", "message": "owner task", "replyVoice": {
            "tone": "direct", "register": "formal", "detail": "brief",
            "structure": "answer-first", "emoji": "none"
        }});
        let mut steer = initial.clone();
        steer["streamingBehavior"] = json!("steer");
        let mut command = initial.clone();
        command["message"] = json!("/shell");
        let mut attachments = initial.clone();
        attachments["images"] = json!([]);
        let mut raw_prose = initial.clone();
        raw_prose["replyVoice"] = json!("arbitrary instructions");
        let mut unknown = initial.clone();
        unknown["replyVoice"]["register"] = json!("arbitrary instructions");
        let mut concept = initial.clone();
        concept["replyVoice"]["concept"] = json!("mentoring");
        let mut raw_concept = initial.clone();
        raw_concept["replyVoice"]["concept"] = json!("arbitrary instructions");

        assert!(allows("prompt", &initial));
        assert!(allows("prompt", &concept));
        assert!(!allows("prompt", &raw_concept));
        assert!(!allows("prompt", &steer));
        assert!(!allows("prompt", &command));
        assert!(!allows("prompt", &attachments));
        assert!(!allows("prompt", &raw_prose));
        assert!(!allows("prompt", &unknown));
        assert!(!allows(
            "get_state",
            &json!({"type": "get_state", "replyVoice": "formal"})
        ));
        assert!(!allows(
            "stage_reply_voice",
            &json!({"type": "stage_reply_voice", "token": "foreign"})
        ));
    }
}
