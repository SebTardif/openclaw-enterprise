// Modified for OpenClaw Enterprise.
//! Duplicate-aware GraphQL envelope parsing with limits checked before DOM allocation.
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;
use zeroize::{Zeroize, Zeroizing};

/// Own decoded values, including partial containers on parse errors. Library
/// unescape scratch remains serde's internal allocation; this guard covers the
/// strings and keys our visitor has actually received and retained.
pub(super) struct OwnedJson(pub Value);
impl OwnedJson {
    fn take(mut self) -> Value {
        std::mem::take(&mut self.0)
    }
}
impl Drop for OwnedJson {
    fn drop(&mut self) {
        fn erase(value: &mut Value) {
            match value {
                Value::String(text) => text.zeroize(),
                Value::Array(values) => values.iter_mut().for_each(erase),
                Value::Object(values) => {
                    for (mut key, mut value) in std::mem::take(values) {
                        key.zeroize();
                        erase(&mut value);
                    }
                }
                _ => {}
            }
        }
        erase(&mut self.0);
    }
}

// The selected envelope permits at most 20,000 JSON values and depth 64.
// Containers count as values, keys do not; the root has depth zero.
const REQUEST_VALUES: usize = 20_000;
const REQUEST_DEPTH: usize = 64;

struct Budget {
    remaining: usize,
    exceeded: bool,
}

struct Unique<'a> {
    budget: &'a mut Budget,
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for Unique<'_> {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        if self.budget.remaining == 0 || self.depth > REQUEST_DEPTH {
            self.budget.exceeded = true;
            return Err(de::Error::custom("JSON budget"));
        }
        self.budget.remaining -= 1;
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
        let mut out = OwnedJson(Value::Array(Vec::new()));
        while let Some(v) = a.next_element_seed(Unique {
            budget: self.budget,
            depth: self.depth + 1,
        })? {
            out.0.as_array_mut().unwrap().push(v);
        }
        Ok(out.take())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
        let mut out = OwnedJson(Value::Object(Map::new()));
        while let Some(k) = a.next_key::<String>()? {
            let mut k = Zeroizing::new(k);
            if out.0.as_object().unwrap().contains_key(k.as_str()) {
                return Err(de::Error::custom("duplicate key"));
            }
            let v = a.next_value_seed(Unique {
                budget: self.budget,
                depth: self.depth + 1,
            })?;
            out.0
                .as_object_mut()
                .unwrap()
                .insert(std::mem::take(&mut *k), v);
        }
        Ok(out.take())
    }
}

pub(super) fn parse(bytes: &[u8]) -> Result<Value, super::Refusal> {
    let mut budget = Budget {
        remaining: REQUEST_VALUES,
        exceeded: false,
    };
    let mut d = serde_json::Deserializer::from_slice(bytes);
    // Seed checks run before deserializing each value, bounding DOM expansion
    // even for a small wire representation containing millions of scalars.
    let value = OwnedJson(
        Unique {
            budget: &mut budget,
            depth: 0,
        }
        .deserialize(&mut d)
        .map_err(|_| {
            if budget.exceeded {
                super::Refusal::Bounds
            } else {
                super::Refusal::Protocol
            }
        })?,
    );
    d.end().map_err(|_| super::Refusal::Protocol)?;
    Ok(value.take())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Refusal;

    #[test]
    fn value_limit_is_checked_before_reading_the_excess_value() {
        let accepted = format!("[{}0]", "0,".repeat(REQUEST_VALUES - 2));
        assert_eq!(
            parse(accepted.as_bytes())
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            REQUEST_VALUES - 1
        );
        // The excess value is malformed too. Bounds, rather than Protocol,
        // proves rejection occurs before deserializing that next value.
        let rejected = format!("[{}invalid]", "0,".repeat(REQUEST_VALUES - 1));
        assert!(matches!(parse(rejected.as_bytes()), Err(Refusal::Bounds)));
    }

    #[test]
    fn nested_values_and_decoded_duplicate_keys_are_bounded() {
        let accepted = format!(
            "{}0{}",
            "[".repeat(REQUEST_DEPTH),
            "]".repeat(REQUEST_DEPTH)
        );
        assert!(parse(accepted.as_bytes()).is_ok());
        let rejected = format!("[{}]", accepted);
        assert!(matches!(parse(rejected.as_bytes()), Err(Refusal::Bounds)));
        assert!(matches!(
            parse(br#"{"variables":{"x":1,"\u0078":2}}"#),
            Err(Refusal::Protocol)
        ));
    }
}
