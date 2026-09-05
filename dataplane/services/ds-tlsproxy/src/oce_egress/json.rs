// Modified for OpenClaw Enterprise.
//! Duplicate-aware JSON parsing at the untrusted HTTP and authority RPC boundaries.
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Unique;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("unambiguous JSON")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Unique, E> {
                Ok(Unique(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Unique, E> {
                Ok(Unique(Value::Number(v.into())))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Unique, E> {
                Ok(Unique(Value::Number(v.into())))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Unique, E> {
                Number::from_f64(v)
                    .map(|n| Unique(Value::Number(n)))
                    .ok_or_else(|| E::custom("number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Unique, E> {
                Ok(Unique(Value::String(v.to_owned())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Unique, E> {
                Ok(Unique(Value::String(v)))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_none<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
                let mut out = Vec::new();
                while let Some(Unique(v)) = a.next_element()? {
                    out.push(v);
                }
                Ok(Unique(Value::Array(out)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
                let mut out = Map::new();
                while let Some(k) = a.next_key::<String>()? {
                    if out.contains_key(&k) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                    let Unique(v) = a.next_value()?;
                    out.insert(k, v);
                }
                Ok(Unique(Value::Object(out)))
            }
        }
        d.deserialize_any(V)
    }
}

pub(super) fn parse(bytes: &[u8]) -> Result<Value, super::Refusal> {
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let Unique(value) = Unique::deserialize(&mut d).map_err(|_| super::Refusal::Malformed)?;
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
        }
        assert!(parse(br#"{"model":"a","x":[1,true,null]}"#).is_ok());
    }
}
