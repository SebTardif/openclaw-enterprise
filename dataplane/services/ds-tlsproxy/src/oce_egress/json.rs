// Modified for OpenClaw Enterprise.
//! Duplicate-aware JSON parsing at the untrusted HTTP and authority RPC boundaries.
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

// Match CODEX_CONTEXT_LIMITS: root depth is zero, containers count as values,
// and object keys do not consume values. Ordinary RPC/config parsing is unchanged.
const REQUEST_VALUES: usize = 20_000;
const REQUEST_DEPTH: usize = 64;

struct Budget {
    remaining: Option<usize>,
    exceeded: bool,
}

struct Unique<'a> {
    budget: &'a mut Budget,
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for Unique<'_> {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        if let Some(remaining) = self.budget.remaining.as_mut() {
            if *remaining == 0 || self.depth > REQUEST_DEPTH {
                self.budget.exceeded = true;
                return Err(de::Error::custom("JSON budget"));
            }
            *remaining -= 1;
        }
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Unique<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("unambiguous JSON")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(Value::Number(v.into()))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(Value::Number(v.into()))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| E::custom("number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        let mut out = Vec::new();
        while let Some(v) = a.next_element_seed(Unique {
            budget: self.budget,
            depth: self.depth + 1,
        })? {
            out.push(v);
        }
        Ok(Value::Array(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        let mut out = Map::new();
        while let Some(k) = a.next_key::<String>()? {
            if out.contains_key(&k) {
                return Err(de::Error::custom("duplicate key"));
            }
            let v = a.next_value_seed(Unique {
                budget: self.budget,
                depth: self.depth + 1,
            })?;
            out.insert(k, v);
        }
        Ok(Value::Object(out))
    }
}

pub(super) fn parse(bytes: &[u8]) -> Result<Value, super::Refusal> {
    parse_with_budget(bytes, None)
}

pub(super) fn parse_request(bytes: &[u8]) -> Result<Value, super::Refusal> {
    parse_with_budget(bytes, Some(REQUEST_VALUES))
}

fn parse_with_budget(bytes: &[u8], remaining: Option<usize>) -> Result<Value, super::Refusal> {
    let mut budget = Budget {
        remaining,
        exceeded: false,
    };
    let mut d = serde_json::Deserializer::from_slice(bytes);
    // Seed checks run before deserializing each value, bounding DOM expansion
    // even for a small wire representation containing millions of scalars.
    let value = Unique {
        budget: &mut budget,
        depth: 0,
    }
    .deserialize(&mut d)
    .map_err(|_| {
        if budget.exceeded {
            super::Refusal::Bounds
        } else {
            super::Refusal::Malformed
        }
    })?;
    d.end().map_err(|_| super::Refusal::Malformed)?;
    Ok(value)
}

pub(super) fn bounded_str<'a>(
    v: &'a Value,
    key: &str,
    max: usize,
) -> Result<&'a str, super::Refusal> {
    let s = v
        .get(key)
        .and_then(Value::as_str)
        .ok_or(super::Refusal::Malformed)?;
    if s.is_empty() || s.len() > max || s.bytes().any(|b| !(0x21..=0x7e).contains(&b)) {
        return Err(super::Refusal::Malformed);
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_decoded_keys_at_any_depth_deny() {
        for s in [
            r#"{"model":"a","\u006dodel":"b"}"#,
            r#"{"x":[{"a":1,"a":2}]}"#,
            "{} {}",
        ] {
            assert!(parse(s.as_bytes()).is_err());
            assert!(matches!(
                parse_request(s.as_bytes()),
                Err(super::super::Refusal::Malformed)
            ));
        }
        assert!(parse(br#"{"model":"a","x":[1,true,null]}"#).is_ok());
    }

    #[test]
    fn request_value_budget_counts_containers_but_not_object_keys() {
        // Root plus 19,999 scalar values is the selected profile's exact cap.
        let array = format!("[{}0]", "0,".repeat(REQUEST_VALUES - 2));
        assert_eq!(
            parse_request(array.as_bytes())
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            REQUEST_VALUES - 1
        );
        let object = format!(
            "{{{}}}",
            (0..REQUEST_VALUES - 1)
                .map(|index| format!("\"k{index}\":0"))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert_eq!(
            parse_request(object.as_bytes())
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            REQUEST_VALUES - 1
        );

        for (accepted, suffix) in [(&array, ",0]"), (&object, ",\"extra\":0}")] {
            let excessive = format!("{}{suffix}", &accepted[..accepted.len() - 1]);
            assert!(matches!(
                parse_request(excessive.as_bytes()),
                Err(super::super::Refusal::Bounds)
            ));
            // RPC/config parsing keeps its original acceptance behavior.
            assert!(parse(excessive.as_bytes()).is_ok());
        }
    }

    #[test]
    fn request_budget_stops_before_deserializing_the_excess_value() {
        // Invalid JSON at the first excess value proves the budget is enforced
        // during descent, before parsing/materializing the rest of the body.
        for text in [
            format!("[{}!not-json]", "0,".repeat(REQUEST_VALUES - 1)),
            format!(
                "{{{}\"excess\":!not-json}}",
                (0..REQUEST_VALUES - 1)
                    .map(|index| format!("\"k{index}\":0,"))
                    .collect::<String>()
            ),
        ] {
            assert!(matches!(
                parse_request(text.as_bytes()),
                Err(super::super::Refusal::Bounds)
            ));
            assert!(matches!(
                parse(text.as_bytes()),
                Err(super::super::Refusal::Malformed)
            ));
        }
    }

    #[test]
    fn request_depth_budget_uses_root_depth_zero() {
        for (open, close) in [("[", "]"), ("{\"child\":", "}")] {
            let exact = format!(
                "{}0{}",
                open.repeat(REQUEST_DEPTH),
                close.repeat(REQUEST_DEPTH)
            );
            assert!(parse_request(exact.as_bytes()).is_ok());
            let excessive = format!("{open}{exact}{close}");
            assert!(matches!(
                parse_request(excessive.as_bytes()),
                Err(super::super::Refusal::Bounds)
            ));
            assert!(parse(excessive.as_bytes()).is_ok());
        }
        // An empty container is still a value at depth 64 and has no child.
        let empty = format!(
            "{}{}",
            "[".repeat(REQUEST_DEPTH + 1),
            "]".repeat(REQUEST_DEPTH + 1)
        );
        assert!(parse_request(empty.as_bytes()).is_ok());
    }
}
