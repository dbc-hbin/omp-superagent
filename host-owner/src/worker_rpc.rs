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
            exact(&["message", "streamingBehavior"])
                && frame["message"].as_str().is_some_and(ordinary_prompt)
                && optional(fields, "streamingBehavior", |value| value == "steer")
        }
        "goal" => exact(&["op"]) && matches!(frame["op"].as_str(), Some("pause" | "resume")),
        "cancel_subagent" => exact(&["subagentId"]) && nonempty(&frame["subagentId"]),
        "set_model" => {
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

fn model_id(value: &Value) -> bool {
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
